import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configurationDigest } from './artifacts.mjs';
import { loadConfiguration } from './configuration.mjs';
import { reviewRequest } from './pr-review.mjs';

const operations = ['authorize', 'analyze', 'synthesize', 'improve', 'publish', 'finish'];

try {
    const env = { ...process.env };
    const operation = env.REVIEW_OPERATION;
    if (env.GITHUB_SERVER_URL !== 'https://github.com')
        throw new Error('ReviewRelay v1 supports GitHub.com only.');
    env.GH_HOST = 'github.com';
    if (!operations.includes(operation)) throw new Error('Unknown ReviewRelay operation.');
    if (operation !== 'authorize') {
        const request = JSON.parse(env.REVIEW_REQUEST || 'null');
        if (
            !request ||
            request.schemaVersion !== 1 ||
            request.repository !== env.GITHUB_REPOSITORY ||
            request.runId !== env.GITHUB_RUN_ID ||
            request.sourceWorkflowRef !== env.GITHUB_WORKFLOW_REF ||
            request.sourceWorkflowSha !== env.GITHUB_WORKFLOW_SHA ||
            request.actor !== env.GITHUB_ACTOR ||
            !['review', 'improve'].includes(request.command) ||
            typeof request.manual !== 'boolean' ||
            !Number.isSafeInteger(request.number) ||
            request.number <= 0 ||
            !/^[a-f0-9]{40}$/.test(request.base) ||
            !/^[a-f0-9]{40}$/.test(request.head) ||
            !/^[a-f0-9]{40}$/.test(request.sourceWorkflowSha) ||
            !/^[a-f0-9]{64}$/.test(request.configurationSha256) ||
            !/^[a-z0-9][a-z0-9-]*(?:\[bot\])?$/i.test(request.actor)
        )
            throw new Error('Missing or invalid authorized request for this consumer run.');
        const eventRequest = reviewRequest(
            env.GITHUB_EVENT_NAME,
            JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
            true,
        );
        if (
            !eventRequest ||
            ['number', 'command', 'manual'].some((key) => eventRequest[key] !== request[key])
        )
            throw new Error('Authorized request does not match the original GitHub event.');
        Object.assign(env, {
            PR_NUMBER: String(request.number),
            BASE_SHA: request.base,
            HEAD_SHA: request.head,
            REVIEW_COMMAND: request.command,
            MANUAL: String(request.manual),
            REVIEW_ACTOR: request.actor,
            REVIEW_CHECK_ID: request.check,
            REVIEW_EXPECTED_CONFIG: request.configurationSha256,
            GITHUB_WORKFLOW_SHA: request.sourceWorkflowSha,
        });
        if (
            ((operation === 'analyze' || operation === 'synthesize') &&
                request.command !== 'review') ||
            (operation === 'improve' && request.command !== 'improve')
        )
            throw new Error('Operation does not match the authorized command.');
    }
    if (process.argv[2] === 'prepare') {
        const ref = env.BASE_SHA || env.GITHUB_WORKFLOW_SHA;
        if (!/^[a-f0-9]{40}$/.test(ref || ''))
            throw new Error('Missing trusted checkout revision.');
        appendFileSync(env.GITHUB_OUTPUT, `source-ref=${ref}\nnumber=${env.PR_NUMBER || ''}\n`);
    } else if (process.argv[2] === 'run') {
        if (operation === 'publish' && env.REVIEW_PROVIDER_ENV && env.REVIEW_PROVIDER_ENV !== '{}')
            throw new Error('Publication must not receive provider-env credentials.');
        if (
            !['authorize', 'finish', 'publish'].includes(operation) &&
            configurationDigest(loadConfiguration(env)) !== env.REVIEW_EXPECTED_CONFIG
        )
            throw new Error(
                'Configuration changed after request authorization. Start a new /review.',
            );
        if (operation === 'finish') {
            const results = JSON.parse(env.REVIEW_RESULTS || '{}');
            Object.assign(env, {
                OPENCODE_RESULT: results.analyze,
                SYNTHESIS_RESULT: results.synthesize || results.improve,
                PUBLISH_RESULT: results.publish,
                REVIEW_SKIPPED: results.skipped,
                SYNTHESIS_STATE: results.state,
            });
        }
        const result = spawnSync(
            process.execPath,
            [fileURLToPath(new URL('./pr-review.mjs', import.meta.url)), operation],
            { env, stdio: 'inherit' },
        );
        if (result.error) throw new Error('Cannot start the review engine.');
        process.exitCode = result.status ?? 1;
    } else throw new Error('Expected prepare or run.');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
