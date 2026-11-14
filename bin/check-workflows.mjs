import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const directory of ['.github/workflows', 'examples']) {
    for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
        const path = join(directory, name);
        // actionlint 1.7.12 predates GitHub.com's self reference. Resolve it locally for
        // static interface checks; only hosted qualification establishes $/ resolution.
        const source = readFileSync(path, 'utf8').replaceAll('uses: $/action', 'uses: ./action');
        const result = spawnSync(
            process.env.ACTIONLINT_BIN || 'actionlint',
            ['-stdin-filename', path, '-'],
            { input: source, encoding: 'utf8' },
        );
        if (result.error) throw result.error;
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        if (result.status !== 0) process.exitCode = 1;
    }
}
