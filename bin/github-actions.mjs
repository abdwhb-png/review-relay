import { spawnSync } from 'node:child_process';

export function api(endpoint, options = [], input) {
    const result = spawnSync('gh', ['api', endpoint, ...options], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        input,
    });
    if (result.error || result.status !== 0) throw new Error('Command failed: gh api');
    return JSON.parse(result.stdout);
}

export function acknowledgeCommandComment(commentId) {
    if (!Number.isSafeInteger(commentId) || commentId <= 0) return;
    try {
        api(`repos/${process.env.GITHUB_REPOSITORY}/issues/comments/${commentId}/reactions`, [
            '--method',
            'POST',
            '-f',
            'content=eyes',
        ]);
    } catch {
        console.log(
            '::warning::GitHub could not add the eyes reaction. The accepted command will continue.',
        );
    }
}

export function writeCheckRun(fields, id) {
    const env = process.env;
    const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    try {
        return api(
            `repos/${env.GITHUB_REPOSITORY}/check-runs${id ? `/${id}` : ''}`,
            ['--method', id ? 'PATCH' : 'POST', '--input', '-'],
            JSON.stringify({
                ...fields,
                details_url: runUrl,
                output: {
                    ...fields.output,
                    summary: `${fields.output.summary}\n\n[View the Actions run](${runUrl})`,
                },
            }),
        );
    } catch {
        console.log('::warning::GitHub could not update the check run.');
    }
}

export function pullRevision(pull, repository, branches = ['main']) {
    if (
        pull.state !== 'open' ||
        pull.draft !== false ||
        !branches.includes(pull.base?.ref) ||
        pull.head?.repo?.full_name !== repository ||
        pull.base.repo?.full_name !== repository ||
        !/^[a-f0-9]{40}$/.test(pull.base.sha) ||
        !/^[a-f0-9]{40}$/.test(pull.head.sha)
    )
        return null;
    return { base: pull.base.sha, head: pull.head.sha };
}
