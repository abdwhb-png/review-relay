import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtime } from './artifacts.mjs';
import { runtimeCache } from './install-runtime.mjs';
import { openCodeDefaults } from './configuration.mjs';

const binary = process.env.OPENCODE_BIN;
if (!binary)
    throw new Error(
        'Set OPENCODE_BIN to the checksum-verified pinned CLI (install-runtime.mjs prepares it).',
    );
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0);
assert.equal(version.stdout.trim(), `opencode v${runtime.opencode.version}`);
const cache = join(runtimeCache(), 'tiktoken', runtime.prAgent.image.split('sha256:')[1]);
mkdirSync(cache, { recursive: true });
// Let the pinned native library download and checksum its own tokenizer data once.
const warmed = spawnSync(
    'docker',
    [
        'run',
        '--rm',
        '--read-only',
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,mode=1777',
        '--env',
        'TIKTOKEN_CACHE_DIR=/cache',
        '--mount',
        `type=bind,src=${cache},dst=/cache`,
        '--entrypoint',
        'python',
        runtime.prAgent.image,
        '-c',
        'import tiktoken; tiktoken.get_encoding("o200k_base")',
    ],
    { stdio: 'inherit', timeout: 180_000 },
);
assert.equal(warmed.status, 0, 'Native tokenizer preparation failed.');

for (const [fixture, operation, replay] of [
    ['adapter_fixture.py', 'scope', false],
    ['adapter_fixture.py', 'render', false],
    ['adapter_fixture.py', 'publish-suggestions', false],
    ['adapter_fixture.py', 'publish-suggestions', true],
    ['adapter_fixture.py', 'publish-summarized', false],
    ['adapter_fixture.py', 'provider-settings', false],
    ['opencode_fixture.py', '', false],
]) {
    const output = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'reviewrelay-native-'));
    try {
        for (const provider of ['primary', 'fallback'])
            writeFileSync(
                join(output, `defaults-${provider}.json`),
                JSON.stringify(openCodeDefaults(provider)),
            );
        const result = spawnSync(
            'docker',
            [
                'run',
                '--rm',
                '--network',
                'none',
                '--read-only',
                '--user',
                `${process.getuid()}:${process.getgid()}`,
                '--cap-drop',
                'ALL',
                '--security-opt',
                'no-new-privileges',
                '--tmpfs',
                '/tmp:rw,exec,nosuid,nodev,mode=1777',
                '--env',
                'HOME=/tmp',
                ...(replay ? ['--env', 'REVIEW_TEST_REPLAY=1'] : []),
                '--env',
                'TIKTOKEN_CACHE_DIR=/cache',
                '--mount',
                `type=bind,src=${cache},dst=/cache,readonly`,
                '--mount',
                `type=bind,src=${resolve('.')},dst=/tool,readonly`,
                '--mount',
                `type=bind,src=${output},dst=/output`,
                '--mount',
                `type=bind,src=${resolve(binary)},dst=/opt/opencode,readonly`,
                '--entrypoint',
                'python',
                runtime.prAgent.image,
                `/tool/tests/native/${fixture}`,
                ...(operation ? [operation] : []),
            ],
            { encoding: 'utf8', timeout: 180_000 },
        );
        if (result.status !== 0) {
            process.stderr.write(result.stdout || '');
            process.stderr.write(result.stderr || '');
            throw result.error || new Error(`Native verification failed: ${fixture} ${operation}`);
        }
        const outcome = result.stdout
            .split('\n')
            .filter((line) => line.startsWith('Native '))
            .join('\n');
        console.log(outcome);
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
}
