import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtime } from './artifacts.mjs';

function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Runtime setup failed: ${command}`);
}

export function runtimeCache() {
    const checkout = createHash('sha256').update(resolve(process.cwd())).digest('hex').slice(0, 16);
    return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'reviewrelay', checkout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    try {
        if (
            process.platform !== 'linux' ||
            process.arch !== 'x64' ||
            Number(process.versions.node.split('.')[0]) < 24
        )
            throw new Error('ReviewRelay requires Linux x64 and Node.js 24 or newer.');
        const operation = process.env.REVIEW_OPERATION;
        if (['analyze', 'synthesize', 'improve', 'publish'].includes(operation)) {
            const installed = spawnSync('docker', ['image', 'inspect', runtime.prAgent.image], {
                stdio: 'ignore',
            });
            if (installed.status !== 0) run('docker', ['pull', runtime.prAgent.image]);
        }
        if (operation === 'analyze' || operation === 'validate') {
            const asset = operation === 'validate' ? runtime.actionlint : runtime.opencode;
            const name = operation === 'validate' ? 'actionlint' : 'opencode';
            const cache = join(runtimeCache(), asset.sha256);
            mkdirSync(cache, { recursive: true });
            const archive = join(cache, `${name}.tgz`);
            if (!existsSync(archive))
                run('curl', [
                    '--fail',
                    '--silent',
                    '--show-error',
                    '--location',
                    '--retry',
                    '2',
                    asset.url,
                    '--output',
                    archive,
                ]);
            if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== asset.sha256)
                throw new Error(`${name} archive checksum mismatch.`);
            run('tar', ['-xzf', archive, '-C', cache, name]);
            appendFileSync(
                process.env.GITHUB_ENV,
                `${name === 'opencode' ? 'OPENCODE_BIN' : 'ACTIONLINT_BIN'}=${join(cache, name)}\n`,
            );
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
