import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
    });
}

for (const path of [...files('bin'), ...files('tests')]) {
    let result;
    if (path.endsWith('.mjs'))
        result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    else if (path.endsWith('.py'))
        result = spawnSync(
            'python3',
            [
                '-c',
                'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(), filename=sys.argv[1])',
                path,
            ],
            { stdio: 'inherit' },
        );
    if (result && result.status !== 0) process.exitCode = 1;
}
