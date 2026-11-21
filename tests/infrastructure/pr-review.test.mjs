import { runtime } from '../../bin/artifacts.mjs';
import assert from 'node:assert/strict';
import { pullRevision } from '../../bin/github-actions.mjs';
import { commentCommands, credentialName } from '../../bin/configuration.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
    opencodeReport,
    providerFailure,
    reviewRequest,
    runReviewStage,
    sameRevision,
} from '../../bin/pr-review.mjs';

const repo = 'example/project';
const base = '1'.repeat(40);
const head = '2'.repeat(40);
const pull = {
    state: 'open',
    draft: false,
    base: { ref: 'main', sha: base, repo: { full_name: repo } },
    head: { sha: head, repo: { full_name: repo } },
};
const manual = {
    action: 'created',
    issue: { number: 42, pull_request: {} },
    sender: { type: 'User' },
};
const automatic = { action: 'synchronize', number: 42, pull_request: pull };

await test('native credential names cover HTTP headers while keeping token budgets significant', () => {
    for (const key of ['X-Api-Key', 'Proxy-Authorization', 'OPENAI__KEY', 'AWS_ACCESS_KEY_ID'])
        assert.equal(credentialName(key), true, key);
    for (const key of ['CONFIG__MAX_OUTPUT_TOKENS', 'max-tokens', 'reasoningEffort'])
        assert.equal(credentialName(key), false, key);
});

function reviewFixture(
    t,
    {
        branch = 'main',
        draft = false,
        files = {},
        headFiles = {},
        guidance = ['AGENTS.md', 'apps/platform/AGENTS.md', 'apps/mobile/AGENTS.md'],
    } = {},
) {
    const fixture = mkdtempSync(join(tmpdir(), 'reviewrelay-hybrid-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    const write = (path, value, options) => writeFileSync(join(fixture, path), value, options);
    git('init', '--quiet', '--template=', '-b', branch);
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    for (const dir of ['apps/platform', 'apps/mobile', '.missions/one/evidence/notes'])
        mkdirSync(join(fixture, dir), { recursive: true });
    for (const path of guidance) write(path, 'Trusted guidance\n');
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(fixture, path, '..'), { recursive: true });
        write(path, content);
    }
    git('add', '.');
    git('commit', '-qm', 'Base');
    const baseSha = git('rev-parse', 'HEAD');
    for (const [path, content] of Object.entries(headFiles)) {
        mkdirSync(join(fixture, path, '..'), { recursive: true });
        write(path, content);
    }
    write('app.txt', 'Product change\n');
    write('.missions/one/spec.md', 'Mission contract\n');
    write('.missions/one/evidence/archive.patch', 'Archived duplicate\n');
    write('.missions/one/evidence/browser.json', 'Archived browser evidence\n');
    write('.missions/one/evidence/notes/summary.md', 'Evidence summary\n');
    git('add', '.');
    git('commit', '-qm', 'Head');
    const headSha = git('rev-parse', 'HEAD');
    const expectedPull = {
        ...pull,
        draft,
        base: { ...pull.base, ref: branch, sha: baseSha },
        head: { ...pull.head, sha: headSha },
    };
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    write(
        'gh',
        `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'run') {
    const dir = process.argv[process.argv.indexOf('--dir')+1];
    fs.cpSync(process.env.FIXTURE_PREVIOUS_DIR, dir, {recursive:true});
    process.exit(0);
}
const endpoint = process.argv[3];
if (endpoint.endsWith('/artifacts/70/zip')) {
    const result=require('node:child_process').spawnSync('python3',['-c','import os,sys,zipfile; z=zipfile.ZipFile(sys.stdout.buffer, "w"); root=sys.argv[1]; [z.write(os.path.join(root,n),n) for n in os.listdir(root)]; z.close()',process.env.FIXTURE_ARCHIVE_DIR || process.env.FIXTURE_PREVIOUS_DIR]);
    process.stdout.write(result.stdout);process.exit(result.status);
}
if (endpoint.endsWith('/artifacts/70')) {
    console.log(JSON.stringify({id:70,expired:false,workflow_run:{id:900}}));process.exit(0);
}
if (endpoint.endsWith('/actions/runs/900')) {
    console.log(JSON.stringify({id:900,event:process.env.FIXTURE_SOURCE_EVENT || 'issue_comment',head_branch:'main',path:process.env.FIXTURE_WRONG_WORKFLOW || '.github/workflows/custom.yml',head_sha:process.env.FIXTURE_SOURCE_EVENT === 'pull_request_target' ? process.env.HEAD_SHA : process.env.GITHUB_WORKFLOW_SHA,repository:{full_name:process.env.GITHUB_REPOSITORY},head_repository:{full_name:process.env.GITHUB_REPOSITORY}}));process.exit(0);
}
if(endpoint.endsWith('/permission')) { console.log(JSON.stringify({permission:process.env.FIXTURE_PERMISSION || 'write'}));process.exit(0); }
if (endpoint.includes('/commits/') && endpoint.includes('/check-runs?')) {
    console.log(JSON.stringify([{check_runs:JSON.parse(process.env.FIXTURE_CHECK_RUNS || '[]')}]));process.exit(0);
}
if (/\\/check-runs\\/[0-9]+$/.test(endpoint)) {
    const body=fs.readFileSync(0,'utf8');
    fs.appendFileSync('check-updates',JSON.stringify({endpoint,body:JSON.parse(body)})+'\\n');
    if(endpoint.endsWith('/123')) fs.appendFileSync('stages',body+'\\n');
}

if (endpoint.endsWith('/reviews') && !process.argv.includes('POST')) {
    console.log(JSON.stringify(fs.existsSync('published') ? fs.readFileSync('published','utf8').trim().split('\\n').filter(Boolean).map((r)=>({...JSON.parse(r),id:100,state:'COMMENTED',user:{login:'github-actions[bot]'},html_url:'https://github.com/fixture/review'})) : []));process.exit(0);
}
if (endpoint.endsWith('/issues/42/comments') && !process.argv.includes('POST')) {
    console.log(JSON.stringify(fs.existsSync('reference') ? [{...JSON.parse(fs.readFileSync('reference','utf8')),id:3,user:{login:'github-actions[bot]'}}] : []));process.exit(0);
}
if (endpoint.endsWith('/reviews')) {
    const review = fs.readFileSync(0, 'utf8');
    fs.appendFileSync('published', review + '\\n');
    console.log(JSON.stringify({state:'COMMENTED',commit_id:JSON.parse(review).commit_id,html_url:'https://github.com/fixture/review'}));
} else if (endpoint.includes('/actions/workflows/')) console.log('['+(process.env.FIXTURE_RUNS || '{"workflow_runs":[]}')+']');
else if (endpoint.includes('/artifacts?')) console.log(process.env.FIXTURE_ARTIFACT_PAGES || JSON.stringify([{artifacts:[{id:70,name:process.env.FIXTURE_ARTIFACT_NAME || 'reviewrelay-analyze-42-1',expired:false}]}]));
else if (endpoint.endsWith('/issues/42/comments')) {
    fs.appendFileSync('reference-calls','1'); fs.writeFileSync('reference',fs.readFileSync(0,'utf8')); console.log('{"id":3}');
} else console.log(process.env.FIXTURE_PULL);
`,
        { mode: 0o755 },
    );
    write(
        'docker',
        `#!${process.execPath}
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
const mount = (name) => args.find((arg) => arg.includes(',dst=' + name)).split(',')[1].slice(4);
if (args.includes('/opt/native.py') && !args.includes('generate')) {
    if (process.env.FIXTURE_NATIVE_SCOPE && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Missing native Actions identity');
    if (args.at(-1)==='scope') {
        const paths=execFileSync('git',['diff','--no-renames','--name-only',process.env.BASE_SHA+'...'+process.env.HEAD_SHA],{encoding:'utf8'}).trim().split('\\n');
        const ignore=[...JSON.parse(process.env.IGNORE__REGEX || '[]'),...JSON.parse(process.env.REVIEW_EXCLUDED_REGEX || '[]')].map(x=>new RegExp(x));
        const scope=process.env.REVIEW_FULL==='true' ? null : process.env.FIXTURE_NATIVE_SCOPE;
        console.log(process.env.REVIEW_SCOPE || scope || JSON.stringify({incremental:false,start:process.env.BASE_SHA,first:null,paths:paths.filter(p=>p && !ignore.some(r=>r.test(p))).sort()}));
    } else if (args.at(-1)==='publish-suggestions') {
        fs.writeFileSync('suggestion-publications',fs.readFileSync(mount('/output')+'/suggestions.json','utf8'));
        if(process.env.OPENAI__KEY || process.env.OPENROUTER__KEY) throw new Error('Publication received provider credentials');
        console.log(JSON.stringify({published:1}));
    } else throw new Error('Unexpected native operation');
} else if (args.includes('debug')) {
    const src=mount('/review');
    const entries=fs.existsSync(src+'/opencode.json') ? [{type:'document', path:'/review/opencode.json', info:JSON.parse(fs.readFileSync(src+'/opencode.json','utf8'))}] : [];
    entries.push({type:'document',info:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}')});
    console.log(JSON.stringify(entries));
} else if (args.includes('import')) {
    fs.appendFileSync('session-imports',fs.readFileSync(mount('/state')+'/previous-session.json','utf8')+'\\n');
    console.log('Imported session: ses_fixture');
} else if (args.includes('export')) {
    console.log(JSON.stringify({info:{id:'ses_fixture'},messages:[{type:'user',text:'Previous context fixture-gh-token'},{id:'end',type:'assistant',content:[{type:'text',text:process.env.FIXTURE_SANITIZED_EXPORT ? '[redacted:text:end]' : 'OpenCode report fixture-go-key'}]}]}));
} else if (args.includes('--standalone')) {
    fs.appendFileSync('provider-calls', 'opencode\\n');
    const src = mount('/review');
    fs.copyFileSync(src + '/reviewrelay-review.diff', 'opencode.diff');
    fs.copyFileSync(src + '/.missions/one/evidence/archive.patch', 'archived-proof');
    fs.writeFileSync('opencode-arguments',JSON.stringify(args));
    fs.writeFileSync('snapshot',JSON.stringify(Object.fromEntries(fs.readdirSync(src,{recursive:true}).filter(p=>fs.statSync(src+'/'+p).isFile() && !p.startsWith('.git/')).map(p=>[p,fs.readFileSync(src+'/'+p,'utf8')]))));
    fs.writeFileSync('opencode-inline-config',process.env.OPENCODE_CONFIG_CONTENT);
    console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'end',text:'OpenCode report fixture-go-key'}}));
    console.log(JSON.stringify({type:'step_finish',part:{reason:'stop',messageID:'end'}}));
} else {
    fs.appendFileSync('provider-calls', 'pr-agent\\n');
    if (process.env.FIXTURE_COMMAND_EXCEPTION) {
        console.error('2026-11-14 | ERROR | pr_agent.agent.pr_agent:_handle_request:369 - Failed to process the command.');
        console.error('ValueError: Native setup rejected fixture-go-key');
        process.exit(1);
    }
    const failure = process.env.FIXTURE_SYNTHESIS_ERROR;
    if (failure && !(process.env.OPENROUTER__KEY && process.env.FIXTURE_FALLBACK_SUCCESS)) {
        console.error('2026-11-08 | ERROR | pr_agent.tools.pr_reviewer:run:502 - Failed to review PR: Attempts: openai/deepseek-v4.1-flash: ' + failure);
        process.exit(1);
    }
    const out = mount('/output');
    const input = mount('/input');
    fs.writeFileSync('native-arguments',JSON.stringify(args));
    fs.writeFileSync('native-env',JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.includes('__') || k === 'OPENAI_CUSTOM_HEADERS'))));
    if(args.includes('improve')) {
        fs.writeFileSync(out+'/improve.json',JSON.stringify({code_suggestions:[{relevant_file:'app.txt', relevant_lines_start:1, relevant_lines_end:1, improved_code:'Corrected value', existing_code:'Product change', suggestion_content:'Fix the regression', label:'bug'}],publication_settings:{committable_code_suggestions:true},usage:{}}));
        process.exit(0);
    }
    fs.copyFileSync(input + '/pr.diff', 'pr-agent.diff');
    fs.copyFileSync(input + '/' + process.env.ARTIFACT_PATH, 'pr-agent-input.md');
    fs.writeFileSync(out + '/review.json', JSON.stringify({review:{key_issues_to_review:[], summary:'fixture-gh-token'},coverage:{}}));
    fs.writeFileSync(out+'/rendered.json',process.env.FIXTURE_NATIVE_RENDERED || JSON.stringify({...(process.env.FIXTURE_MISSING_NATIVE_BODY ? {} : {body:'PR-Agent report fixture-gh-token'}),anchor:'Native reference'}));
    console.log("Injected artifact context into tools: ['pr_reviewer']");
}
`,
        { mode: 0o755 },
    );
    const run = (command, overrides = {}) => {
        write('output', '');
        return spawnSync(
            process.execPath,
            overrides.FIXTURE_ACTION
                ? [
                      fileURLToPath(new URL('../../bin/action.mjs', import.meta.url)),
                      overrides.FIXTURE_PREPARE ? 'prepare' : 'run',
                  ]
                : [fileURLToPath(new URL('../../bin/pr-review.mjs', import.meta.url)), command],
            {
                cwd: fixture,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${fixture}:${process.env.PATH}`,
                    RUNNER_TEMP: fixture,
                    GITHUB_OUTPUT: join(fixture, 'output'),
                    GITHUB_REPOSITORY: repo,
                    GITHUB_SERVER_URL: 'https://github.com',
                    GITHUB_RUN_ID: '900',
                    GITHUB_RUN_ATTEMPT: '1',
                    GITHUB_WORKFLOW_REF: `example/project/.github/workflows/custom.yml@refs/heads/${branch}`,
                    GITHUB_WORKFLOW_SHA: baseSha,
                    REVIEW_DEFAULT_BRANCH: branch,
                    GITHUB_ACTIONS: 'true',
                    GITHUB_EVENT_NAME: 'issue_comment',
                    GITHUB_EVENT_PATH: join(fixture, 'event.json'),
                    GITHUB_REF: `refs/heads/${branch}`,
                    GITHUB_ACTOR: 'member',
                    REVIEW_OPERATION: command,
                    PR_NUMBER: '42',
                    BASE_SHA: baseSha,
                    HEAD_SHA: headSha,
                    REVIEW_CHECK_ID: '123',
                    PR_REVIEW_EXCLUDE_GLOBS: '',
                    OPENCODE_GO_API_KEY: 'fixture-go-key',
                    GH_TOKEN: 'fixture-gh-token',
                    OPENCODE_BIN: '/fixture/opencode',
                    FIXTURE_PULL: JSON.stringify(expectedPull),
                    ...overrides,
                },
            },
        );
    };
    const outputs = () =>
        Object.fromEntries(
            readFileSync(join(fixture, 'output'), 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => [
                    line.slice(0, line.indexOf('=')),
                    line.slice(line.indexOf('=') + 1),
                ]),
        );
    const read = (path) => readFileSync(join(fixture, path), 'utf8');
    return { fixture, git, write, run, outputs, read, baseSha, headSha, expectedPull };
}

await test('the hybrid run reviews one filtered diff and reports each stage on the pinned commit', (t) => {
    const { fixture, git, write, run, outputs, read, baseSha, headSha, expectedPull } =
        reviewFixture(t);
    const runReview = (exclusions = '') => run('analyze', { PR_REVIEW_EXCLUDE_GLOBS: exclusions });
    const globs = [
        '!.missions/*/evidence/**/summary.md',
        '.missions/*/evidence/**',
        '!.missions/*/evidence/**/*.patch',
    ];
    const result = runReview(JSON.stringify(globs));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read('provider-calls'), 'opencode\n');
    const diff = read('opencode.diff');
    assert.match(diff, /Product change/);
    assert.match(diff, /Mission contract/);
    assert.match(diff, /Archived duplicate/);
    assert.match(diff, /Evidence summary/);
    assert.doesNotMatch(diff, /Archived browser evidence/);
    assert.equal(read('archived-proof'), 'Archived duplicate\n');
    assert.match(result.stdout, /Excluded by review globs: 1 file/);

    const { reports } = outputs();
    assert.ok(reports, 'the runner must expose the report directory to Actions');
    assert.ok(
        readdirSync(reports).includes('opencode-session.json'),
        'a successful analysis must preserve the native session for the next review',
    );
    assert.deepEqual(readdirSync(reports).sort(), [
        'manifest.json',
        'opencode-report.md',
        'opencode-session.json',
    ]);
    const manifestPath = join(reports, 'manifest.json');
    const reportPath = join(reports, 'opencode-report.md');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const report = readFileSync(reportPath, 'utf8');
    assert.equal(report, 'OpenCode report [redacted]\n');
    const { producer, compatibility, configurationSha256, ...payload } = manifest;
    assert.equal(producer.runId, '900');
    assert.equal(producer.workflowSha, baseSha);
    assert.equal(compatibility.version, runtime.version);
    assert.match(compatibility.engine, /^[a-f0-9]{64}$/);
    assert.match(configurationSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(payload, {
        schemaVersion: 2,
        kind: 'analysis',
        instructionPaths: [],
        repository: repo,
        reviewId: null,
        number: 42,
        base: baseSha,
        head: headSha,
        globs,
        scope: {
            incremental: false,
            start: baseSha,
            first: null,
            paths: [
                '.missions/one/evidence/archive.patch',
                '.missions/one/evidence/notes/summary.md',
                '.missions/one/spec.md',
                'app.txt',
            ],
        },
        sessionId: 'ses_fixture',
        files: {
            'opencode-session.json': createHash('sha256')
                .update(readFileSync(join(reports, 'opencode-session.json')))
                .digest('hex'),
            'opencode-report.md': createHash('sha256').update(report).digest('hex'),
        },
        diffSha256: createHash('sha256').update(diff).digest('hex'),
    });

    const synthesize = (overrides = {}) =>
        run('synthesize', {
            OPENCODE_REPORT_DIR: reports,
            PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify(globs),
            ...overrides,
        });

    const missing = synthesize({ OPENCODE_REPORT_DIR: join(fixture, 'expired') });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Start a new request/);
    assert.equal(outputs().state, 'new-review-required');

    writeFileSync(reportPath, 'Corrupted report\n');
    const corrupt = synthesize();
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /Start a new request/);
    writeFileSync(reportPath, report);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, globs: ['app.*'] }));
    const wrongDiff = synthesize();
    assert.equal(wrongDiff.status, 1);
    assert.match(wrongDiff.stderr, /Start a new request/);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, number: 43 }));
    const wrongPull = synthesize();
    assert.equal(wrongPull.status, 1);
    assert.match(wrongPull.stderr, /Start a new request/);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const stale = synthesize({
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: baseSha },
        }),
    });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /revision or eligibility changed.*Start a new request/);
    assert.equal(read('provider-calls'), 'opencode\n');

    const quota = synthesize({
        FIXTURE_SYNTHESIS_ERROR: 'RateLimitError: Daily quota exhausted, try again later.',
    });
    assert.equal(quota.status, 1);
    assert.match(
        quota.stderr,
        /PR-Agent \/review did not complete on primary: PR-Agent RateLimitError/,
    );
    assert.doesNotMatch(quota.stdout, /Retrying synthesis/);
    assert.equal(outputs().review, undefined);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');

    const resumed = synthesize();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\npr-agent\n');
    assert.equal(read('pr-agent.diff'), diff);
    assert.equal(read('pr-agent-input.md'), report);
    const stages = read('stages')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).output);
    assert.deepEqual(
        stages.map(({ title }) => title),
        ['Preparing the review', 'OpenCode analysis', 'PR-Agent synthesis', 'PR-Agent synthesis'],
    );
    for (const { summary } of stages)
        assert.match(summary, /https:\/\/github\.com\/example\/project\/actions\/runs\/900/);
    const synthesis = outputs();
    assert.deepEqual(readdirSync(synthesis.reports).sort(), [
        'manifest.json',
        'pr-agent-review.json',
        'pr-agent-review.md',
        'publication.json',
    ]);
    assert.match(
        readFileSync(join(synthesis.reports, 'pr-agent-review.md'), 'utf8'),
        /^PR-Agent report \[redacted\]$/m,
    );
    assert.equal(
        JSON.parse(readFileSync(join(synthesis.reports, 'pr-agent-review.json'), 'utf8')).review
            .summary,
        '[redacted]',
    );
    const published = run('publish', {
        REVIEW_REPORT_DIR: synthesis.reports,
        PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify(globs),
    });
    assert.equal(published.status, 0, published.stderr);
    const sent = JSON.parse(read('published'));
    assert.match(sent.body, /<!-- reviewrelay:[a-f0-9]{64} -->$/);
    assert.deepEqual(
        { ...sent, body: sent.body.replace(/\n\n<!-- reviewrelay:[a-f0-9]{64} -->$/, '') },
        {
            body: 'PR-Agent report [redacted]\n\nReview scope: 1 files excluded from the primary diff by the configured review globs.',
            commit_id: headSha,
            event: 'COMMENT',
        },
    );

    const custom = runReview('["app.*", ".missions/*/evidence/*.patch"]');
    assert.equal(custom.status, 0, custom.stderr);
    const customDiff = readFileSync(join(fixture, 'opencode.diff'), 'utf8');
    assert.match(customDiff, /Mission contract/);
    assert.match(customDiff, /Archived browser evidence/);
    assert.doesNotMatch(customDiff, /Product change|Archived duplicate/);
    assert.match(custom.stdout, /Excluded by review globs: 2 files/);

    const unfiltered = runReview('[]');
    assert.equal(unfiltered.status, 0, unfiltered.stderr);
    const unfilteredDiff = readFileSync(join(fixture, 'opencode.diff'), 'utf8');
    for (const text of [
        /Archived duplicate/,
        /Archived browser evidence/,
        /Product change/,
        /Mission contract/,
    ])
        assert.match(unfilteredDiff, text);
    assert.match(unfiltered.stdout, /Excluded by review globs: 0 files/);

    const unset = runReview();
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(readFileSync(join(fixture, 'opencode.diff'), 'utf8'), unfilteredDiff);

    for (const exclusions of ['[', '{}', '[1]', '[" "]', '["!"]', '["! "]', '["!/absolute"]']) {
        const invalid = runReview(exclusions);
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /PR_REVIEW_EXCLUDE_GLOBS must be a JSON array/);
        assert.doesNotMatch(invalid.stdout, /OpenCode started/);
    }
    const sanitized = run('analyze', { FIXTURE_SANITIZED_EXPORT: 'true' });
    assert.equal(
        sanitized.status,
        1,
        'an export without the report text cannot establish resumable context',
    );
    assert.match(sanitized.stderr, /session export.*context/);

    write('app.txt', 'Product change\nFollow-up change\n');
    git('add', 'app.txt');
    git('commit', '-qm', 'Follow-up');
    const followUp = git('rev-parse', 'HEAD');
    const scope = { incremental: true, start: headSha, first: followUp, paths: ['app.txt'] };
    const continuation = {
        HEAD_SHA: followUp,
        GITHUB_RUN_ID: '901',
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: followUp },
        }),
        FIXTURE_NATIVE_SCOPE: JSON.stringify(scope),
        FIXTURE_RUNS: JSON.stringify({
            workflow_runs: [
                {
                    id: 900,
                    head_branch: 'main',
                    head_sha: baseSha,
                    event: 'issue_comment',
                    conclusion: 'success',
                },
            ],
        }),
        FIXTURE_PREVIOUS_DIR: reports,
        PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify(globs),
    };
    const next = run('analyze', continuation);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /Resuming OpenCode session from run 900/);
    assert.match(read('session-imports'), /Previous context \[redacted\]/);
    assert.match(read('opencode.diff'), /^\+Follow-up change$/m);
    assert.doesNotMatch(
        read('opencode.diff'),
        /^\+Product change|Mission contract|Archived duplicate/m,
    );
    assert.ok(JSON.parse(read('opencode-arguments')).includes('--session'));
    const nextReports = outputs().reports;
    const nextManifest = JSON.parse(readFileSync(join(nextReports, 'manifest.json'), 'utf8'));
    assert.deepEqual(nextManifest.scope, scope);
    const secondSynthesis = run('synthesize', {
        ...continuation,
        OPENCODE_REPORT_DIR: nextReports,
    });
    assert.equal(secondSynthesis.status, 0, secondSynthesis.stderr);
    assert.equal(read('pr-agent.diff'), read('opencode.diff'));
    const secondOutput = outputs();
    assert.equal(
        run('publish', {
            ...continuation,
            REVIEW_REPORT_DIR: secondOutput.reports,
        }).status,
        0,
    );
    assert.match(JSON.parse(read('reference')).body, new RegExp(followUp));

    const beforeSkip = read('provider-calls');
    const noChanges = run('analyze', {
        ...continuation,
        FIXTURE_PREVIOUS_DIR: nextReports,
        FIXTURE_NATIVE_SCOPE: JSON.stringify({
            incremental: true,
            start: followUp,
            first: null,
            paths: [],
        }),
    });
    assert.equal(noChanges.status, 0, noChanges.stderr);
    assert.equal(outputs().skipped, 'true');
    assert.equal(
        read('provider-calls'),
        beforeSkip,
        'unchanged commits must not invoke either model',
    );

    const priorSessionPath = join(reports, 'opencode-session.json');
    writeFileSync(priorSessionPath, 'Corrupted session');
    const invalidSession = run('analyze', continuation);
    assert.equal(invalidSession.status, 1);
    assert.match(invalidSession.stderr, /Artifact payload checksum mismatch/);
    assert.equal(read('provider-calls'), beforeSkip);

    const importedBeforeReset = read('session-imports');
    const reset = run('analyze', { ...continuation, FIXTURE_RUNS: '{"workflow_runs":[]}' });
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /No compatible archived OpenCode session.*complete review/);
    assert.match(read('opencode.diff'), /Mission contract/);
    assert.equal(read('session-imports'), importedBeforeReset);
    assert.ok(!JSON.parse(read('opencode-arguments')).includes('--session'));
});

await test('manual review and suggestions stay available independently of the auto-review switch', () => {
    assert.deepEqual(
        reviewRequest('workflow_dispatch', { inputs: { pull_request: '42' } }, false),
        {
            number: 42,
            command: 'review',
            manual: true,
        },
    );
    for (const command of ['review', 'improve']) {
        assert.deepEqual(
            reviewRequest('issue_comment', { ...manual, comment: { body: `/${command}` } }, false),
            {
                number: 42,
                command,
                manual: true,
            },
        );
    }
    assert.equal(
        reviewRequest('issue_comment', { ...manual, comment: { body: '/review --config' } }, true),
        null,
    );
    assert.equal(
        reviewRequest(
            'issue_comment',
            { ...manual, sender: { type: 'Bot' }, comment: { body: '/review' } },
            true,
        ),
        null,
    );
});

await test('automatic review requires the switch and an eligible PR event', () => {
    assert.equal(reviewRequest('pull_request_target', automatic, false), null);
    assert.deepEqual(reviewRequest('pull_request_target', automatic, true), {
        number: 42,
        command: 'review',
        manual: false,
    });
    assert.equal(
        reviewRequest('pull_request_target', { ...automatic, pull_request: { draft: true } }, true),
        null,
    );
});

await test('a slash command remains valid with a trailing line break', () => {
    for (const [body, command] of [
        ['/review\r\n', 'review'],
        ['/improve\n', 'improve'],
    ]) {
        assert.deepEqual(reviewRequest('issue_comment', { ...manual, comment: { body } }, false), {
            number: 42,
            command,
            manual: true,
        });
    }
    assert.equal(
        reviewRequest(
            'issue_comment',
            { ...manual, comment: { body: '/review\nPlease check this.' } },
            false,
        ),
        null,
    );
});

await test('pin only internal, ready pull requests and refuse a change to either revision', () => {
    assert.deepEqual(pullRevision(pull, repo), { base, head });
    assert.equal(pullRevision({ ...pull, draft: true }, repo), null);
    assert.equal(
        pullRevision(
            { ...pull, head: { ...pull.head, repo: { full_name: 'elsewhere/fork' } } },
            repo,
        ),
        null,
    );
    assert.equal(sameRevision(pull, repo, base, head), true);
    assert.equal(sameRevision(pull, repo, base, '3'.repeat(40)), false);
    assert.equal(sameRevision(pull, repo, '3'.repeat(40), head), false);
    assert.equal(sameRevision({ ...pull, state: 'closed' }, repo, base, head), false);
});

await test('fallback only runs for a manual request with an enabled switch and provider failure', async () => {
    for (const [manual, fallback, unavailable, expected] of [
        [false, true, 'provider rate limit', ['primary']],
        [true, false, 'provider rate limit', ['primary']],
        [true, true, null, ['primary']],
        [true, true, 'provider rate limit', ['primary', 'fallback']],
    ]) {
        const providers = [];
        const result = await runReviewStage({ manual, fallback }, (provider) => {
            providers.push(provider);
            return { ok: false, unavailable };
        });
        assert.deepEqual(providers, expected);
        assert.equal(result.ok, false);
        assert.equal(result.provider, expected.at(-1));
    }
});

await test('temporary synthesis overload retries Go once before manual fallback', async () => {
    const calls = [];
    const result = await runReviewStage(
        { manual: true, fallback: true, waitForRetry: () => calls.push('wait') },
        (provider) => {
            calls.push(provider);
            return { ok: false, unavailable: 'PR-Agent RateLimitError', retryable: true };
        },
    );
    assert.deepEqual(calls, ['primary', 'wait', 'primary', 'fallback']);
    assert.equal(result.provider, 'fallback');
});

await test('successful Go output is returned without calling another provider', async () => {
    const result = await runReviewStage({ manual: true, fallback: true }, (provider) => {
        assert.equal(provider, 'primary');
        return { ok: true, report: 'Review' };
    });
    assert.deepEqual(result, { ok: true, report: 'Review', provider: 'primary' });
});

await test('only final, complete OpenCode text becomes the report', () => {
    const events = [
        { type: 'text', part: { messageID: 'old', text: 'Discard this text.' } },
        { type: 'text', part: { messageID: 'final', text: 'Real report.' } },
        { type: 'step_finish', part: { messageID: 'final', reason: 'stop' } },
    ];
    assert.equal(opencodeReport(events), 'Real report.');
    assert.equal(opencodeReport(events.slice(0, -1)), null);
    assert.equal(
        opencodeReport([
            ...events,
            { type: 'step_finish', part: { messageID: 'final', reason: 'length' } },
        ]),
        null,
    );
    assert.equal(opencodeReport([...events, { type: 'error', error: { status: 429 } }]), null);
});

await test('provider failures can switch routes while auth, invalid outputs and local failures cannot', () => {
    for (const status of [402, 408, 429, 502])
        assert.ok(providerFailure('opencode', [{ type: 'error', error: { status } }]));
    for (const status of [400, 401, 403, 404])
        assert.equal(providerFailure('opencode', [{ type: 'error', error: { status } }]), null);
    const failure = (kind) =>
        `2026-11-08 | ERROR | pr_agent.tools.pr_reviewer:run:502 - Failed to review PR: Failed to generate prediction with any model. Attempts: openai/deepseek-v4.1-flash: ${kind}: error`;
    for (const kind of ['RateLimitError', 'Timeout', 'APIConnectionError', 'InternalServerError'])
        assert.ok(providerFailure('pr-agent', failure(kind)));
    for (const kind of [
        'AuthenticationError',
        'FallbackEligibleError',
        'EmptyTruncatedResponseError',
    ])
        assert.equal(providerFailure('pr-agent', failure(kind)), null);
    assert.equal(
        providerFailure('pr-agent', 'Model mentioned RateLimitError as an example.'),
        null,
    );
});

await test('the command entrypoint acknowledges eligible comments before allowing analysis and rejects stale publication', (t) => {
    const { fixture, baseSha, expectedPull } = reviewFixture(t);
    const base = baseSha;
    const pull = expectedPull;
    const commandPath = fileURLToPath(new URL('../../bin/pr-review.mjs', import.meta.url));
    const output = join(fixture, 'output');
    const eventPath = join(fixture, 'event');
    const calls = join(fixture, 'calls');
    const summary = join(fixture, 'summary');
    writeFileSync(output, '');
    writeFileSync(calls, '');
    const comment = { ...manual, comment: { id: 123, body: '/review\r\n' } };
    writeFileSync(eventPath, JSON.stringify(comment));
    writeFileSync(
        join(fixture, 'gh'),
        `#!${process.execPath}
const fs = require('node:fs');
const endpoint = process.argv[3];
fs.appendFileSync(process.env.FIXTURE_CALLS, endpoint + '\\n');
if (endpoint.endsWith('/permission')) console.log(JSON.stringify({ permission: process.env.FIXTURE_PERMISSION }));
else if (endpoint.endsWith('/reactions')) {
    const args = process.argv.slice(4);
    if (process.env.FIXTURE_REACTION_FAIL === 'true' || fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8') || !args.includes('content=eyes')) process.exit(1);
    console.log(JSON.stringify({ id: 456, content: 'eyes' }));
}
else if (endpoint.endsWith('/check-runs')) {
    const check = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (check.head_sha !== JSON.parse(process.env.FIXTURE_PULL).head.sha || check.status !== 'in_progress' || check.external_id !== 'reviewrelay-'+process.env.GITHUB_RUN_ID) process.exit(1);
    console.log(JSON.stringify({ id: 123 }));
}
else console.log(process.env.FIXTURE_PULL);
`,
        { mode: 0o755 },
    );
    const env = {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_ACTOR: 'member',
        GITHUB_REPOSITORY: repo,
        GITHUB_WORKFLOW_SHA: baseSha,
        GITHUB_REF: '',
        BASE_SHA: baseSha,
        HEAD_SHA: '',
        GITHUB_RUN_ID: '900',
        FIXTURE_CALLS: calls,
        FIXTURE_PERMISSION: 'read',
        FIXTURE_PULL: JSON.stringify(pull),
    };
    const denied = spawnSync(process.execPath, [commandPath, 'authorize'], { cwd: fixture, env });
    assert.equal(denied.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
    assert.equal(readFileSync(calls, 'utf8'), `repos/${repo}/collaborators/member/permission\n`);

    writeFileSync(calls, '');
    const ineligible = spawnSync(process.execPath, [commandPath, 'authorize'], {
        cwd: fixture,
        env: {
            ...env,
            FIXTURE_PERMISSION: 'write',
            FIXTURE_PULL: JSON.stringify({ ...pull, base: { ...pull.base, ref: 'design-system' } }),
        },
        encoding: 'utf8',
    });
    assert.equal(ineligible.status, 0, ineligible.stderr);
    assert.equal(readFileSync(output, 'utf8'), '');
    assert.equal(
        readFileSync(calls, 'utf8'),
        `repos/${repo}/collaborators/member/permission\nrepos/${repo}/pulls/42\n`,
    );
    assert.match(ineligible.stdout, /target main/i);
    assert.match(readFileSync(summary, 'utf8'), /target main/i);

    for (const command of ['review', 'improve']) {
        writeFileSync(output, '');
        writeFileSync(calls, '');
        writeFileSync(
            eventPath,
            JSON.stringify({ ...comment, comment: { id: 123, body: `/${command}\r\n` } }),
        );
        const authorized = spawnSync(process.execPath, [commandPath, 'authorize'], {
            cwd: fixture,
            env: { ...env, FIXTURE_PERMISSION: 'write' },
            encoding: 'utf8',
        });
        assert.equal(authorized.status, 0, authorized.stderr);
        assert.equal(authorized.stderr, '');
        assert.equal(authorized.stdout, '');
        assert.match(readFileSync(output, 'utf8'), new RegExp(`^command=${command}$`, 'm'));
        assert.match(readFileSync(output, 'utf8'), /^allowed=true$/m);
        if (command === 'review') assert.match(readFileSync(output, 'utf8'), /^check=123$/m);
        assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
            `repos/${repo}/collaborators/member/permission`,
            `repos/${repo}/pulls/42`,
            `repos/${repo}/issues/comments/123/reactions`,
            ...(command === 'review' ? [`repos/${repo}/check-runs`] : []),
        ]);
    }

    writeFileSync(output, '');
    const failedReaction = spawnSync(process.execPath, [commandPath, 'authorize'], {
        cwd: fixture,
        env: { ...env, FIXTURE_PERMISSION: 'write', FIXTURE_REACTION_FAIL: 'true' },
        encoding: 'utf8',
    });
    assert.equal(failedReaction.status, 0, failedReaction.stderr);
    assert.match(failedReaction.stdout, /::warning::.*reaction/i);
    assert.match(readFileSync(output, 'utf8'), /^allowed=true$/m);

    writeFileSync(output, '');
    writeFileSync(calls, '');
    writeFileSync(eventPath, JSON.stringify({ inputs: { pull_request: '42' } }));
    const dispatched = spawnSync(process.execPath, [commandPath, 'authorize'], {
        cwd: fixture,
        env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', FIXTURE_PERMISSION: 'write' },
    });
    assert.equal(dispatched.status, 0);
    assert.match(readFileSync(output, 'utf8'), /^allowed=true$/m);
    assert.equal(
        readFileSync(calls, 'utf8'),
        `repos/${repo}/collaborators/member/permission\nrepos/${repo}/pulls/42\nrepos/${repo}/check-runs\n`,
    );

    writeFileSync(calls, '');
    const stale = spawnSync(process.execPath, [commandPath, 'publish'], {
        cwd: fixture,
        env: {
            ...env,
            PR_NUMBER: '42',
            BASE_SHA: base,
            HEAD_SHA: '3'.repeat(40),
            REVIEW: '"Review"',
        },
        encoding: 'utf8',
    });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /PR revision or eligibility changed/);
    assert.equal(readFileSync(calls, 'utf8'), `repos/${repo}/pulls/42\n`);
});

await test('the review workflow retains legacy filtering and prefilters custom caller commands', () => {
    const workflow = readFileSync(
        new URL('../../.github/workflows/review.yml', import.meta.url),
        'utf8',
    );
    const expression = workflow.match(/\s+request:\n\s+if: >-\n([\s\S]*?)\n\s+runs-on:/)[1].trim();
    const eligible = (body, commands = {}) =>
        runInNewContext(expression, {
            github: {
                event_name: 'issue_comment',
                event: { issue: { pull_request: {} }, sender: { type: 'User' }, comment: { body } },
            },
            vars: {},
            inputs: { 'review-commands': '', 'improve-commands': '', ...commands },
            startsWith: (text, prefix) => text.startsWith(prefix),
        });
    assert.equal(eligible('/ci'), false);
    assert.equal(eligible('/unrelated'), false);
    assert.equal(eligible('/review'), true);
    assert.equal(eligible('/review\r\n'), true);
    assert.equal(eligible('/improve\n'), true);
    const custom = { 'review-commands': '["/check-fr"]' };
    assert.equal(eligible('/check-fr', custom), true);
    assert.equal(eligible('ordinary comment', custom), false);
    assert.equal(eligible('/unknown', custom), true);
});

await test('a differently laid out project uses trusted custom guidance and its configured target branch', (t) => {
    const { run, read } = reviewFixture(t, {
        branch: 'develop',
        guidance: [],
        files: {
            '.reviewrelay.json': JSON.stringify({
                schemaVersion: 1,
                instructionSources: ['CLAUDE.md', 'policy/*.md'],
                baseBranches: ['develop'],
            }),
            'CLAUDE.md': 'Trusted Claude guidance',
            'policy/security.md': 'Trusted custom policy',
            'opencode.json': JSON.stringify({
                model: 'vendor/custom-model',
                instructions: ['policy/*.md'],
            }),
        },
    });
    const result = run('analyze');
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(read('snapshot'));
    assert.equal(snapshot['CLAUDE.md'], 'Trusted Claude guidance');
    assert.equal(snapshot['policy/security.md'], 'Trusted custom policy');
    assert.equal(JSON.parse(snapshot['opencode.json']).model, 'vendor/custom-model');
    const config = JSON.parse(read('opencode-inline-config'));
    assert.ok(config.instructions.includes('CLAUDE.md'));
    assert.ok(
        !read('opencode-arguments').includes('--model'),
        'the native project config must own model selection',
    );
});

await test('trusted configuration and invocation overrides select the diff while head instructions remain untrusted', (t) => {
    const { run, read } = reviewFixture(t, {
        files: {
            '.reviewrelay.json': JSON.stringify({
                schemaVersion: 1,
                excludeGlobs: ['app.txt'],
                instructionSources: ['policy/*.md'],
            }),
            'policy/rules.md': 'Trusted policy',
        },
        headFiles: {
            '.reviewrelay.json': JSON.stringify({
                schemaVersion: 1,
                instructionSources: ['evil.md'],
            }),
            'policy/rules.md': 'Malicious head instruction',
            'CLAUDE.md': 'Malicious automatic instruction',
        },
    });
    const configured = run('analyze');
    assert.equal(configured.status, 0, configured.stderr);
    assert.doesNotMatch(read('opencode.diff'), /Product change/);
    const snapshot = JSON.parse(read('snapshot'));
    assert.equal(snapshot['policy/rules.md'], 'Trusted policy');
    assert.equal(snapshot['CLAUDE.md'], undefined);
    const overridden = run('analyze', { REVIEW_OVERRIDES: JSON.stringify({ excludeGlobs: [] }) });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.match(read('opencode.diff'), /Product change/);
    const calls = read('provider-calls');
    for (const config of [
        '[]',
        'null',
        '{"retentionDays":-1}',
        '{"unknown":true}',
        '{"instructionSources":["../outside.md"]}',
        '{"instructionSources":["missing.md"]}',
    ]) {
        const invalid = run('analyze', { REVIEW_OVERRIDES: config });
        assert.equal(invalid.status, 1, `must reject ${config}`);
        assert.equal(read('provider-calls'), calls, 'invalid settings must fail before inference');
    }
});

await test('native instruction globs are restored from the trusted revision even without orchestration aliases', (t) => {
    const { run, read } = reviewFixture(t, {
        files: {
            'opencode.json': JSON.stringify({ instructions: ['policy/*.md'] }),
            'policy/native.md': 'Trusted native guidance',
        },
        headFiles: {
            'policy/native.md': 'Injected head guidance',
            'policy/new.md': 'New injected instruction',
        },
    });
    const result = run('analyze');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read('snapshot'))['policy/native.md'], 'Trusted native guidance');
    assert.equal(JSON.parse(read('snapshot'))['policy/new.md'], undefined);
});

await test('native invocation settings reach the runtime without hidden model, timeout, or presentation overrides', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    const provider = JSON.stringify({
        'pr-agent': {
            CONFIG__MODEL: 'openrouter/custom-model',
            CONFIG__AI_TIMEOUT: '901',
            PR_REVIEWER__REQUIRE_ESTIMATE_EFFORT_TO_REVIEW: 'true',
        },
        opencode: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'vendor/model#medium' }) },
    });
    const analyzed = run('analyze', { REVIEW_PROVIDER_ENV: provider });
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal(JSON.parse(read('opencode-inline-config')).model, 'vendor/model#medium');
    const result = run('synthesize', {
        OPENCODE_REPORT_DIR: outputs().reports,
        REVIEW_PROVIDER_ENV: provider,
    });
    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(read('native-env'));
    assert.equal(env.CONFIG__MODEL, 'openrouter/custom-model');
    assert.equal(env.CONFIG__AI_TIMEOUT, '901');
    assert.equal(env.PR_REVIEWER__REQUIRE_ESTIMATE_EFFORT_TO_REVIEW, 'true');
    assert.equal(env.CONFIG__PUBLISH_OUTPUT, 'false');
    for (const unsafe of [
        { opencode: { NODE_OPTIONS: '--import=evil' } },
        { 'pr-agent': { GITHUB__USER_TOKEN: 'other' } },
        { 'pr-agent': { CONFIG__PUBLISH_OUTPUT: 'true' } },
        { 'pr-agent': { DOCKER_HOST: 'tcp://127.0.0.1:2375' } },
        { opencode: { DOCKER_CONFIG: '/caller-config' } },
    ]) {
        const failed = run('analyze', { REVIEW_PROVIDER_ENV: JSON.stringify(unsafe) });
        assert.equal(failed.status, 1);
    }
});

await test('analysis reuse rejects effective configuration changes and synthesis publishes an identified archive instead of job text', (t) => {
    const { run, outputs } = reviewFixture(t);
    const analyzed = run('analyze');
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const reports = outputs().reports;
    const changed = run('synthesize', {
        OPENCODE_REPORT_DIR: reports,
        REVIEW_OVERRIDES: JSON.stringify({ retentionDays: 3 }),
    });
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /cannot be reused/);
    const result = run('synthesize', { OPENCODE_REPORT_DIR: reports });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(outputs().review, undefined, 'reports must not pass through job outputs');
    const manifest = JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.kind, 'synthesis');
    assert.equal(manifest.producer.runId, '900');
});

await test('operations transfer an artifact by ID and reject a producer from another workflow', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    const analyzed = run('analyze');
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const reports = outputs().reports;
    const result = run('synthesize', { REVIEW_ARTIFACT_ID: '70', FIXTURE_ARCHIVE_DIR: reports });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
        JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8')).kind,
        'synthesis',
    );
    const before = read('provider-calls');
    const wrong = run('synthesize', {
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
        FIXTURE_WRONG_WORKFLOW: '.github/workflows/untrusted.yml',
    });
    assert.equal(wrong.status, 1);
    assert.equal(read('provider-calls'), before);
});

await test('improve archives native suggestions without publication or write credentials in generation', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    const result = run('improve');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(outputs().reports, 'suggestions must be archived for a separate publication');
    const manifest = JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'suggestions');
    assert.equal(JSON.parse(read('native-env')).CONFIG__PUBLISH_OUTPUT, 'false');
    assert.equal(read('provider-calls'), 'pr-agent\n');
    const suggestions = JSON.parse(
        readFileSync(join(outputs().reports, 'suggestions.json'), 'utf8'),
    );
    assert.equal(suggestions.code_suggestions[0].improved_code, 'Corrected value');
    assert.equal(suggestions.publication_settings.committable_code_suggestions, true);
});

await test('failure classification supports the configured native model rather than a fixed provider name', () => {
    assert.deepEqual(
        providerFailure(
            'pr-agent',
            '2026-11-14 | ERROR | pr_agent.tools.pr_reviewer:run:502 - Failed to review PR: Attempts: vendor/custom-model: ServiceUnavailableError: Temporary overload',
        ),
        { unavailable: 'PR-Agent ServiceUnavailableError', retryable: true },
    );
});

await test('authorization returns a frozen public request independent of automatic review and rejects dispatch from another branch', (t) => {
    const { run, outputs, fixture, write, baseSha, headSha } = reviewFixture(t);
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const env = {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    };
    const result = run('authorize', env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(outputs().request, 'authorization must return the public request');
    const request = JSON.parse(outputs().request);
    assert.equal(request.schemaVersion, 2);
    assert.equal(request.repository, repo);
    assert.equal(request.base, baseSha);
    assert.equal(request.head, headSha);
    assert.equal(request.actor, 'member');
    assert.equal(request.manual, true);
    assert.match(request.configurationSha256, /^[a-f0-9]{64}$/);
    write('event.json', JSON.stringify({ inputs: { pull_request: '42' } }));
    const denied = run('authorize', {
        ...env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/untrusted',
    });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(outputs().request, undefined);
});

await test('native ignore rules and coordinator exclusions both constrain the frozen review scope', (t) => {
    const { run, outputs } = reviewFixture(t);
    const result = run('analyze', {
        REVIEW_PROVIDER_ENV: JSON.stringify({
            'pr-agent': { IGNORE__REGEX: JSON.stringify(['^app\\.txt$']) },
        }),
        PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify(['.missions/*/evidence/*.json']),
    });
    assert.equal(result.status, 0, result.stderr);
    const { scope } = JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8'));
    assert.ok(!scope.paths.includes('app.txt'));
    assert.ok(!scope.paths.includes('.missions/one/evidence/browser.json'));
    assert.ok(scope.paths.includes('.missions/one/spec.md'));
});

await test('the public action composes authorization, resumed synthesis, and publication with revoked and stale requests refused', (t) => {
    const { run, outputs, fixture, write, read, expectedPull } = reviewFixture(t);
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const auth = run('authorize', {
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    });
    assert.equal(auth.status, 0, auth.stderr);
    const request = outputs().request;
    const env = { FIXTURE_ACTION: 'true', REVIEW_REQUEST: request };
    const analyzed = run('analyze', env);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const analysis = outputs().reports;
    const failed = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: analysis,
        FIXTURE_SYNTHESIS_ERROR: 'RateLimitError: Daily quota exhausted',
    });
    assert.equal(failed.status, 1);
    const resumed = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: analysis,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const synthesis = outputs().reports;
    assert.equal(read('provider-calls'), 'opencode\npr-agent\npr-agent\n');
    const revoked = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: synthesis,
        FIXTURE_PERMISSION: 'read',
    });
    assert.equal(revoked.status, 1);
    assert.match(revoked.stderr, /revoked/);
    const stale = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: synthesis,
        FIXTURE_PULL: JSON.stringify({ ...expectedPull, draft: true }),
    });
    assert.equal(stale.status, 1);
    const published = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: synthesis,
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(outputs().state, 'published');
    assert.equal(JSON.parse(read('published')).commit_id, expectedPull.head.sha);
    const unsafe = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: synthesis,
        REVIEW_PROVIDER_ENV: JSON.stringify({ opencode: { OPENCODE_API_KEY: 'secret' } }),
    });
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /must not receive/);
});

await test('a native configuration file skipped by its loader fails before inference', (t) => {
    const { run } = reviewFixture(t, {
        files: { 'opencode.jsonc': '{ invalid native configuration' },
    });
    const result = run('analyze');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /native configuration/);
});

await test('native provider credentials are redacted from retained reports and sessions', (t) => {
    const { run, outputs } = reviewFixture(t);
    const result = run('analyze', {
        OPENCODE_GO_API_KEY: '',
        REVIEW_PROVIDER_ENV: JSON.stringify({ opencode: { OPENCODE_API_KEY: 'fixture-go-key' } }),
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['opencode-report.md', 'opencode-session.json']) {
        assert.doesNotMatch(readFileSync(join(outputs().reports, name), 'utf8'), /fixture-go-key/);
    }
});

await test('automatic bot requests preserve the distinction between reviewed head and trusted workflow source', (t) => {
    const { run, outputs, fixture, write, git, expectedPull } = reviewFixture(t, {
        branch: 'release',
        files: {
            '.reviewrelay.json': JSON.stringify({ autoReview: true, baseBranches: ['release'] }),
        },
    });
    write('dispatcher.txt', 'Trusted default-branch workflow revision');
    git('add', 'dispatcher.txt');
    git('commit', '-qm', 'Independent default-branch workflow');
    const workflow = {
        GITHUB_WORKFLOW_SHA: git('rev-parse', 'HEAD'),
        GITHUB_WORKFLOW_REF: 'example/project/.github/workflows/custom.yml@refs/heads/main',
        REVIEW_DEFAULT_BRANCH: 'main',
    };
    write(
        'event.json',
        JSON.stringify({ action: 'synchronize', number: 42, pull_request: expectedPull }),
    );
    const auth = run('authorize', {
        ...workflow,
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
        GITHUB_ACTOR: 'dependabot[bot]',
        AUTO_ENABLED: 'true',
    });
    assert.equal(auth.status, 0, auth.stderr);
    const request = outputs().request;
    assert.ok(request);
    const env = {
        ...workflow,
        FIXTURE_ACTION: 'true',
        REVIEW_REQUEST: request,
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_ACTOR: 'dependabot[bot]',
    };
    const analysis = run('analyze', env);
    assert.equal(analysis.status, 0, analysis.stderr);
    const archive = outputs().reports;
    const result = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: archive,
        FIXTURE_SOURCE_EVENT: 'pull_request_target',
    });
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(
        manifestPath,
        JSON.stringify({
            ...manifest,
            producer: { ...manifest.producer, workflowSha: expectedPull.base.sha },
        }),
    );
    const calls = readFileSync(join(fixture, 'provider-calls'), 'utf8');
    const mismatched = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: archive,
        FIXTURE_SOURCE_EVENT: 'pull_request_target',
    });
    assert.equal(mismatched.status, 1);
    assert.equal(readFileSync(join(fixture, 'provider-calls'), 'utf8'), calls);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    write('dispatcher.txt', 'Later trusted default-branch revision');
    git('add', 'dispatcher.txt');
    git('commit', '-qm', 'Advance the trusted default branch');
    const historical = {
        ...env,
        GITHUB_RUN_ID: '901',
        GITHUB_WORKFLOW_SHA: git('rev-parse', 'HEAD'),
    };
    assert.equal(run('authorize', historical).status, 0);
    const resumed = run('synthesize', {
        ...historical,
        REVIEW_REQUEST: outputs().request,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: archive,
        FIXTURE_SOURCE_EVENT: 'pull_request_target',
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const unrelated = {
        ...historical,
        GITHUB_RUN_ID: '902',
        GITHUB_WORKFLOW_SHA: expectedPull.base.sha,
    };
    assert.equal(run('authorize', unrelated).status, 0);
    const untrusted = run('synthesize', {
        ...unrelated,
        REVIEW_REQUEST: outputs().request,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: archive,
        FIXTURE_SOURCE_EVENT: 'pull_request_target',
    });
    assert.equal(untrusted.status, 1);
});

await test('publication retries reuse the confirmed review and native reference without repeating inference', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    assert.equal(run('analyze').status, 0);
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: outputs().reports }).status, 0);
    const reports = outputs().reports;
    const first = run('publish', { REVIEW_REPORT_DIR: reports });
    assert.equal(first.status, 0, first.stderr);
    const repeat = run('publish', { REVIEW_REPORT_DIR: reports });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(read('published').trim().split('\n').length, 1);
    assert.equal(read('reference-calls'), '1');
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
});

await test('public operations cannot turn a manual event into an automatic request to bypass current authorization', (t) => {
    const { run, outputs, fixture, write } = reviewFixture(t);
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const context = {
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    };
    assert.equal(run('authorize', context).status, 0);
    const request = JSON.parse(outputs().request);
    const forged = run('analyze', {
        ...context,
        REVIEW_REQUEST: JSON.stringify({ ...request, manual: false }),
        FIXTURE_PERMISSION: 'read',
    });
    assert.equal(forged.status, 1);
    assert.match(forged.stderr, /event|request/);
});

await test('executable native extensions are refused before inspecting the untrusted head snapshot', (t) => {
    const { run } = reviewFixture(t, {
        files: { 'opencode.json': JSON.stringify({ plugins: [{ package: './app.js' }] }) },
    });
    const result = run('analyze');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extensions/);
});

await test('credential rotation preserves analysis compatibility but native token-budget changes invalidate it', (t) => {
    const { run, outputs } = reviewFixture(t);
    const provider = (key, tokens) =>
        JSON.stringify({
            'pr-agent': { OPENAI__KEY: key, CONFIG__MAX_OUTPUT_TOKENS: String(tokens) },
        });
    const first = run('analyze', { REVIEW_PROVIDER_ENV: provider('first-credential', 1000) });
    assert.equal(first.status, 0, first.stderr);
    const reports = outputs().reports;
    const changed = run('synthesize', {
        OPENCODE_REPORT_DIR: reports,
        REVIEW_PROVIDER_ENV: provider('first-credential', 2000),
    });
    assert.equal(changed.status, 1);
    const rotated = run('synthesize', {
        OPENCODE_REPORT_DIR: reports,
        REVIEW_PROVIDER_ENV: provider('rotated-credential', 1000),
    });
    assert.equal(rotated.status, 0, rotated.stderr);
});

await test('a native provider can run without a Go credential or a fixed credential-variable catalog', (t) => {
    const { run } = reviewFixture(t, {
        files: { 'opencode.json': JSON.stringify({ model: 'local/native-model' }) },
    });
    const anonymous = run('analyze', { OPENCODE_GO_API_KEY: '' });
    assert.equal(anonymous.status, 0, anonymous.stderr);
    const environment = run('analyze', {
        OPENCODE_GO_API_KEY: '',
        REVIEW_PROVIDER_ENV: JSON.stringify({
            opencode: {
                AWS_ACCESS_KEY_ID: 'fixture-account',
                AWS_SECRET_ACCESS_KEY: 'fixture-secret',
            },
        }),
    });
    assert.equal(environment.status, 0, environment.stderr);
});

await test('manual fallback instruction sources are frozen before primary analysis even if fallback is not needed', (t) => {
    const { run, read } = reviewFixture(t, {
        files: { 'fallback.md': 'Trusted fallback policy' },
        headFiles: { 'fallback.md': 'Injected fallback policy' },
    });
    const result = run('analyze', {
        MANUAL: 'true',
        REVIEW_OVERRIDES: JSON.stringify({ manualFallback: true }),
        REVIEW_PROVIDER_ENV: JSON.stringify({
            fallback: {
                opencode: {
                    OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['fallback.md'] }),
                },
            },
        }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read('snapshot'))['fallback.md'], 'Trusted fallback policy');
    assert.ok(
        !JSON.parse(read('opencode-inline-config')).instructions.includes('fallback.md'),
        'fallback-only rules must not be injected into primary inference',
    );
});

await test('native TOML safety constraints follow native case-insensitive settings names', (t) => {
    const { run } = reviewFixture(t, {
        files: { '.pr_agent.toml': '[CONFIG]\nREPO_CONTEXT_FROM_DEFAULT_BRANCH = true\n' },
    });
    const result = run('analyze');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /native TOML/);
});

await test('invocation settings cannot select a moving cross-repository settings source', (t) => {
    const { run } = reviewFixture(t);
    const result = run('analyze', {
        REVIEW_PROVIDER_ENV: JSON.stringify({
            'pr-agent': { CONFIG__GLOBAL_SETTINGS_REPO: 'fixture/settings' },
        }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Reserved|frozen/);
});

await test('a custom native configuration directory cannot bypass the executable-extension guard', (t) => {
    const { run } = reviewFixture(t, {
        files: { '.custom/plugins/review.js': 'export default async () => ({})' },
    });
    const result = run('analyze', {
        REVIEW_PROVIDER_ENV: JSON.stringify({ opencode: { OPENCODE_CONFIG_DIR: '.custom' } }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extensions/);
    const aliased = run('analyze', {
        REVIEW_PROVIDER_ENV: JSON.stringify({ opencode: { OPENCODE_CONFIG_DIR: '.custom/' } }),
    });
    assert.equal(aliased.status, 1);
    assert.match(aliased.stderr, /repository-relative/);
});

await test('fallback synthesis applies its native presentation settings to the generated report', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    const environment = {
        MANUAL: 'true',
        REVIEW_OVERRIDES: JSON.stringify({ manualFallback: true }),
        REVIEW_PROVIDER_ENV: JSON.stringify({
            fallback: {
                'pr-agent': {
                    OPENROUTER__KEY: 'fixture-backup-key',
                    CONFIG__RESPONSE_LANGUAGE: 'fr-FR',
                },
            },
        }),
    };
    const analysis = run('analyze', environment);
    assert.equal(analysis.status, 0, analysis.stderr);
    const synthesis = run('synthesize', {
        ...environment,
        OPENCODE_REPORT_DIR: outputs().reports,
        FIXTURE_SYNTHESIS_ERROR: 'PaymentRequiredError: subscription exhausted',
        FIXTURE_FALLBACK_SUCCESS: 'true',
    });
    assert.equal(synthesis.status, 0, synthesis.stderr);
    assert.equal(JSON.parse(read('native-env')).CONFIG__RESPONSE_LANGUAGE, 'fr-FR');
});

await test('native command failures expose the terminal exception while redacting provider credentials', (t) => {
    const { run, outputs } = reviewFixture(t);
    assert.equal(run('analyze').status, 0);
    const result = run('synthesize', {
        OPENCODE_REPORT_DIR: outputs().reports,
        FIXTURE_COMMAND_EXCEPTION: 'true',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ValueError: Native setup rejected \[redacted\]/);
    assert.ok(!result.stderr.includes('fixture-go-key'));
});

await test('manual authorization reads native configuration from the frozen PR base rather than the dispatcher revision', (t) => {
    const { run, outputs, write, git, baseSha } = reviewFixture(t, {
        files: { '.pr_agent.toml': '[config]\nrepo_context_from_default_branch = false\n' },
    });
    write('.pr_agent.toml', '[config]\nrepo_context_from_default_branch = true\n');
    git('add', '.pr_agent.toml');
    git('commit', '-qm', 'Independent dispatcher revision');
    const result = run('authorize', {
        BASE_SHA: '',
        HEAD_SHA: '',
        GITHUB_WORKFLOW_SHA: git('rev-parse', 'HEAD'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(outputs().request).base, baseSha);
});

await test('native SDK conversation headers have a stable default and remain overridable', (t) => {
    const { run, read } = reviewFixture(t);
    assert.equal(run('improve').status, 0);
    assert.equal(
        JSON.parse(read('native-env')).OPENAI_CUSTOM_HEADERS,
        'x-opencode-session: reviewrelay-example/project-42',
    );
    const headers = 'x-opencode-session: consumer-conversation\nX-Consumer: custom';
    const custom = run('improve', {
        REVIEW_PROVIDER_ENV: JSON.stringify({ 'pr-agent': { OPENAI_CUSTOM_HEADERS: headers } }),
    });
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(JSON.parse(read('native-env')).OPENAI_CUSTOM_HEADERS, headers);
});

await test('native header credentials are redacted and may rotate without discarding completed analysis', (t) => {
    const { run, outputs } = reviewFixture(t);
    const environment = (credential, client = 'consumer') => ({
        OPENCODE_GO_API_KEY: '',
        REVIEW_PROVIDER_ENV: JSON.stringify({
            'pr-agent': {
                OPENAI_CUSTOM_HEADERS: `Authorization: Bearer ${credential}\nX-Client: ${client}`,
            },
        }),
    });
    const first = run('analyze', environment('fixture-go-key'));
    assert.equal(first.status, 0, first.stderr);
    const reports = outputs().reports;
    for (const name of ['opencode-report.md', 'opencode-session.json'])
        assert.doesNotMatch(readFileSync(join(reports, name), 'utf8'), /fixture-go-key/);
    const rotated = run('synthesize', {
        ...environment('rotated-header-credential'),
        OPENCODE_REPORT_DIR: reports,
    });
    assert.equal(rotated.status, 0, rotated.stderr);
    const changed = run('synthesize', {
        ...environment('rotated-header-credential', 'different-client'),
        OPENCODE_REPORT_DIR: reports,
    });
    assert.equal(changed.status, 1);
});

await test('a recovery updates the latest GitHub copy of its advisory check after repeated failed attempts', (t) => {
    const { run, read } = reviewFixture(t);
    const check = {
        name: 'ReviewRelay PR review',
        external_id: 'reviewrelay-900',
        app: { slug: 'github-actions' },
    };
    const result = run('finish', {
        GITHUB_RUN_ATTEMPT: '3',
        PUBLISH_RESULT: 'success',
        FIXTURE_CHECK_RUNS: JSON.stringify([
            { ...check, id: 123 },
            { ...check, id: 124 },
            { ...check, id: 999, external_id: 'reviewrelay-899' },
            { ...check, id: 1000, app: { slug: 'another-app' } },
        ]),
    });
    assert.equal(result.status, 0, result.stderr);
    const updates = read('check-updates')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].endpoint, `repos/${repo}/check-runs/124`);
    assert.equal(updates[0].body.conclusion, 'success');
});

await test('an opted-in manual draft review and improve publish on an explicitly permitted stacked base', (t) => {
    const { run, outputs, write, read, fixture, expectedPull } = reviewFixture(t, {
        branch: 'stack/base',
        draft: true,
        files: { '.reviewrelay.json': JSON.stringify({ manualDraftReview: false }) },
    });
    const context = {
        FIXTURE_ACTION: 'true',
        REVIEW_OVERRIDES: JSON.stringify({ manualDraftReview: true, baseBranches: ['stack/base'] }),
        REVIEW_DEFAULT_BRANCH: 'main',
        GITHUB_WORKFLOW_REF: 'example/project/.github/workflows/custom.yml@refs/heads/main',
        GITHUB_REF: 'refs/heads/main',
    };
    const authorized = run('authorize', context);
    assert.equal(authorized.status, 0, authorized.stderr);
    assert.equal(outputs().allowed, 'true');
    const review = { ...context, REVIEW_REQUEST: outputs().request };
    const analysis = run('analyze', review);
    assert.equal(analysis.status, 0, analysis.stderr);
    const synthesized = run('synthesize', {
        ...review,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: outputs().reports,
    });
    assert.equal(synthesized.status, 0, synthesized.stderr);
    const archive = outputs().reports;
    for (const changed of [
        { FIXTURE_PERMISSION: 'read' },
        { FIXTURE_PULL: JSON.stringify({ ...expectedPull, state: 'closed' }) },
        { FIXTURE_PULL: JSON.stringify({ ...expectedPull, draft: null }) },
        {
            FIXTURE_PULL: JSON.stringify({
                ...expectedPull,
                head: { ...expectedPull.head, sha: '3'.repeat(40) },
            }),
        },
        {
            FIXTURE_PULL: JSON.stringify({
                ...expectedPull,
                base: { ...expectedPull.base, sha: '3'.repeat(40) },
            }),
        },
        {
            FIXTURE_PULL: JSON.stringify({
                ...expectedPull,
                base: { ...expectedPull.base, ref: 'other/base' },
            }),
        },
        {
            FIXTURE_PULL: JSON.stringify({
                ...expectedPull,
                head: { ...expectedPull.head, repo: { full_name: 'other/fork' } },
            }),
        },
    ]) {
        const denied = run('publish', {
            ...review,
            REVIEW_ARTIFACT_ID: '70',
            FIXTURE_ARCHIVE_DIR: archive,
            ...changed,
        });
        assert.equal(denied.status, 1, denied.stdout);
        assert.ok(!readdirSync(fixture).includes('published'));
    }
    const published = run('publish', {
        ...review,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: archive,
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(outputs().state, 'published');
    assert.equal(JSON.parse(read('published')).commit_id, expectedPull.head.sha);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');

    write('event.json', JSON.stringify({ ...manual, comment: { id: 124, body: '/improve' } }));
    assert.equal(run('authorize', context).status, 0);
    assert.equal(outputs().allowed, 'true');
    const improve = { ...context, REVIEW_REQUEST: outputs().request };
    const generated = run('improve', improve);
    assert.equal(generated.status, 0, generated.stderr);
    const suggestions = run('publish', {
        ...improve,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: outputs().reports,
    });
    assert.equal(suggestions.status, 0, suggestions.stderr);
    assert.equal(
        JSON.parse(read('suggestion-publications')).code_suggestions[0].improved_code,
        'Corrected value',
    );
    write('event.json', JSON.stringify({ inputs: { pull_request: '42' } }));
    assert.equal(
        run('authorize', { ...context, GITHUB_EVENT_NAME: 'workflow_dispatch' }).status,
        0,
    );
    assert.equal(outputs().allowed, 'true');
    assert.equal(JSON.parse(outputs().request).manual, true);
});

await test('draft authorization requires trusted opt-in, valid settings and a manual authorized event', (t) => {
    for (const scenario of [
        { name: 'default', config: {} },
        { name: 'disabled', config: { manualDraftReview: false } },
        {
            name: 'invocation disables project opt-in',
            config: { manualDraftReview: true },
            overrides: { manualDraftReview: false },
        },
        {
            name: 'head cannot opt in',
            config: {},
            headFiles: { '.reviewrelay.json': JSON.stringify({ manualDraftReview: true }) },
        },
        {
            name: 'automatic stays disabled for drafts',
            config: { manualDraftReview: true, autoReview: true },
            automatic: true,
        },
        {
            name: 'automatic event cannot review a PR converted to draft',
            config: { manualDraftReview: true, autoReview: true },
            automatic: 'converted',
        },
        {
            name: 'insufficient permission',
            config: { manualDraftReview: true },
            permission: 'read',
        },
        { name: 'wrong base', config: { manualDraftReview: true, baseBranches: ['another/base'] } },
        { name: 'invalid boolean', config: { manualDraftReview: 'true' }, status: 1 },
    ]) {
        const { run, outputs, write, fixture, expectedPull } = reviewFixture(t, {
            branch: 'stack/base',
            draft: true,
            files: {
                '.reviewrelay.json': JSON.stringify({
                    baseBranches: ['stack/base'],
                    ...scenario.config,
                }),
            },
            headFiles: scenario.headFiles,
        });
        if (scenario.automatic)
            write(
                'event.json',
                JSON.stringify({
                    action: 'synchronize',
                    number: 42,
                    pull_request:
                        scenario.automatic === 'converted'
                            ? { ...expectedPull, draft: false }
                            : expectedPull,
                }),
            );
        const result = run('authorize', {
            FIXTURE_ACTION: 'true',
            REVIEW_OVERRIDES: JSON.stringify(scenario.overrides || {}),
            FIXTURE_PERMISSION: scenario.permission || 'write',
            GITHUB_EVENT_NAME: scenario.automatic ? 'pull_request_target' : 'issue_comment',
        });
        assert.equal(result.status, scenario.status || 0, scenario.name + ': ' + result.stderr);
        assert.equal(outputs().allowed, undefined, scenario.name);
        assert.ok(!readdirSync(fixture).includes('provider-calls'), scenario.name);
        assert.ok(!readdirSync(fixture).includes('published'), scenario.name);
        assert.equal(outputs().reports, undefined, scenario.name);
    }
});

await test('authorization freezes a named stream and exposes its concurrency identity', (t) => {
    const { run, outputs, fixture, write } = reviewFixture(t, {
        files: {
            '.reviewrelay.json': JSON.stringify({ reviewId: 'localization' }),
        },
    });
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const result = run('authorize', {
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    });
    assert.equal(result.status, 0, result.stderr);
    const request = JSON.parse(outputs().request);
    assert.equal(request.schemaVersion, 2);
    assert.equal(request.reviewId, 'localization');
    assert.equal(request.configPath, '.reviewrelay.json');
    assert.equal(request.prAgentConfigPath, '.pr_agent.toml');
    assert.equal(outputs()['concurrency-group'], 'reviewrelay-example/project-42-localization');
});

await test('named stream artifacts and publication retain their authorized identity without publisher credentials', (t) => {
    const { run, outputs, fixture, write, read } = reviewFixture(t, {
        files: { '.reviewrelay.json': JSON.stringify({ reviewId: 'localization' }) },
    });
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const event = {
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    };
    assert.equal(run('authorize', event).status, 0);
    const request = outputs().request;
    const environment = { ...event, REVIEW_REQUEST: request };
    const analysis = run('analyze', environment);
    assert.equal(analysis.status, 0, analysis.stderr);
    const artifact = outputs().reports;
    const manifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.reviewId, 'localization');
    const nativeAnchor = '## PR Reviewer Guide 🔍\n\n<!-- pr-agent:review:full -->';
    const synthesis = run('synthesize', {
        ...environment,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: artifact,
        FIXTURE_NATIVE_RENDERED: JSON.stringify({
            body: `${nativeAnchor}\n\nPR-Agent report fixture-gh-token`,
            anchor: nativeAnchor,
        }),
    });
    assert.equal(synthesis.status, 0, synthesis.stderr);
    const reports = outputs().reports;
    assert.equal(
        JSON.parse(read('native-env')).OPENAI_CUSTOM_HEADERS,
        'x-opencode-session: reviewrelay-example/project-42-localization',
    );
    const wrong = run('publish', {
        ...environment,
        REVIEW_OVERRIDES: '{"reviewId":"security"}',
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
    });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /authorized|identity|selection/i);
    const published = run('publish', {
        ...environment,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
        REVIEW_PROVIDER_ENV: '{}',
    });
    assert.equal(published.status, 0, published.stderr);
    const reviewBody = JSON.parse(read('published')).body;
    const referenceBody = JSON.parse(read('reference')).body;
    for (const body of [reviewBody, referenceBody]) {
        assert.deepEqual(body.split('\n').slice(0, 5), [
            '<!-- reviewrelay:stream:localization -->',
            '**Review stream:** `localization`',
            '## PR Reviewer Guide 🔍',
            '',
            '<!-- pr-agent:review:full -->',
        ]);
    }
    const archived = readFileSync(join(reports, 'pr-agent-review.md'), 'utf8').trimEnd();
    const publicationId = /<!-- reviewrelay:[a-f0-9]{64} -->$/.exec(reviewBody)?.[0];
    assert.ok(publicationId);
    assert.equal(reviewBody, `${archived}\n\n${publicationId}`);
    assert.ok(referenceBody.includes(publicationId));
    const replay = run('publish', {
        ...environment,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
        REVIEW_PROVIDER_ENV: '{}',
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(read('published').trim().split('\n').length, 1);
    assert.equal(read('reference-calls'), '1');
});

await test('named stream publication limits include its visible label and archive marker in UTF-8 bytes', async (t) => {
    for (const excess of [0, 1]) {
        await t.test(
            excess ? 'rejects 65537 bytes before publication' : 'publishes exactly 65536 bytes',
            (t) => {
                const reviewId = 'a'.repeat(64);
                const { run, outputs, read, fixture } = reviewFixture(t, {
                    files: { '.reviewrelay.json': JSON.stringify({ reviewId }) },
                });
                assert.equal(run('analyze').status, 0);
                const prefix = `<!-- reviewrelay:stream:${reviewId} -->\n**Review stream:** \`${reviewId}\`\n`;
                const nativeAnchor = '## PR Reviewer Guide 🔍\n\n<!-- pr-agent:review:full -->';
                const publicationSuffix = `\n\n<!-- reviewrelay:${'a'.repeat(64)} -->`;
                const remaining =
                    65536 +
                    excess -
                    Buffer.byteLength(prefix + nativeAnchor + '\n\n' + publicationSuffix);
                const nativeBody =
                    nativeAnchor +
                    '\n\n' +
                    'é'.repeat(Math.floor(remaining / 2)) +
                    'x'.repeat(remaining % 2);
                const synthesized = run('synthesize', {
                    OPENCODE_REPORT_DIR: outputs().reports,
                    FIXTURE_NATIVE_RENDERED: JSON.stringify({
                        body: nativeBody,
                        anchor: nativeAnchor,
                    }),
                });
                assert.equal(synthesized.status, 0, synthesized.stderr);
                const reports = outputs().reports;
                const archived = readFileSync(
                    join(reports, 'pr-agent-review.md'),
                    'utf8',
                ).trimEnd();
                assert.equal(Buffer.byteLength(archived + publicationSuffix), 65536 + excess);
                const published = run('publish', { REVIEW_REPORT_DIR: reports });
                if (excess) {
                    assert.equal(published.status, 1);
                    assert.match(published.stderr, /exceeds the GitHub publication limit/);
                    assert.ok(!readdirSync(fixture).includes('published'));
                    assert.ok(!readdirSync(fixture).includes('reference'));
                } else {
                    assert.equal(published.status, 0, published.stderr);
                    assert.equal(Buffer.byteLength(JSON.parse(read('published')).body), 65536);
                }
            },
        );
    }
});

await test('a completed stream resumes its session from a globally failed run', (t) => {
    const { run, outputs, git, write, read, expectedPull, headSha, baseSha } = reviewFixture(t, {
        files: { '.reviewrelay.json': JSON.stringify({ reviewId: 'localization' }) },
    });
    const initial = run('analyze');
    assert.equal(initial.status, 0, initial.stderr);
    const previous = outputs().reports;
    write('app.txt', 'Product change\nFollow-up change\n');
    git('add', 'app.txt');
    git('commit', '-qm', 'Follow-up');
    const head = git('rev-parse', 'HEAD');
    const resumed = run('analyze', {
        HEAD_SHA: head,
        GITHUB_RUN_ID: '901',
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: head },
        }),
        FIXTURE_NATIVE_SCOPE: JSON.stringify({
            incremental: true,
            start: headSha,
            first: head,
            paths: ['app.txt'],
        }),
        FIXTURE_RUNS: JSON.stringify({
            workflow_runs: [
                {
                    id: 900,
                    head_branch: 'main',
                    head_sha: baseSha,
                    event: 'issue_comment',
                    conclusion: 'failure',
                },
            ],
        }),
        FIXTURE_PREVIOUS_DIR: previous,
        FIXTURE_ARTIFACT_NAME: 'reviewrelay-analyze-42-localization-1',
        FIXTURE_ARTIFACT_PAGES: JSON.stringify([
            {
                artifacts: [
                    { id: 80, name: 'reviewrelay-analyze-42-localization-other-1', expired: false },
                ],
            },
            {
                artifacts: [
                    { id: 70, name: 'reviewrelay-analyze-42-localization-1', expired: false },
                ],
            },
        ]),
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Resuming OpenCode session from run 900/);
    assert.match(read('session-imports'), /Previous context/);
    assert.match(read('opencode.diff'), /Follow-up change/);
    assert.doesNotMatch(read('opencode.diff'), /^\+Product change/m);
});

await test('stream identifiers and selected TOMLs are validated at authorization', (t) => {
    const { run, outputs, fixture, write } = reviewFixture(t, {
        files: {
            '.reviewrelay.json': JSON.stringify({
                reviewId: 'localization',
                prAgentConfigPath: '.pr_agent.localization.toml',
            }),
            '.pr_agent.toml': '[config]\npublish_output = true\n',
            '.pr_agent.localization.toml': '[pr_reviewer]\nextra_instructions = "localization"\n',
        },
    });
    write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
    const event = {
        FIXTURE_ACTION: 'true',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(fixture, 'event.json'),
    };
    const accepted = run('authorize', event);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(outputs().request).prAgentConfigPath, '.pr_agent.localization.toml');
    for (const reviewId of ['', 'Upper', 'a--b', '-a', 'a-', 'a/b', 'a'.repeat(65), 1]) {
        const invalid = run('authorize', {
            ...event,
            REVIEW_OVERRIDES: JSON.stringify({ reviewId }),
        });
        assert.equal(invalid.status, 1, JSON.stringify(reviewId));
        assert.match(invalid.stderr, /reviewId/);
        assert.equal(outputs().request, undefined);
    }
    for (const path of ['../outside.toml', '/tmp/settings.toml', 'missing.toml']) {
        const invalid = run('authorize', {
            ...event,
            REVIEW_OVERRIDES: JSON.stringify({ prAgentConfigPath: path }),
        });
        assert.equal(invalid.status, 1, path);
        assert.equal(outputs().request, undefined);
    }
});

await test('a named stream refuses incomplete native Markdown before archival', (t) => {
    const { run, outputs } = reviewFixture(t, {
        files: { '.reviewrelay.json': JSON.stringify({ reviewId: 'localization' }) },
    });
    assert.equal(run('analyze').status, 0);
    const result = run('synthesize', {
        OPENCODE_REPORT_DIR: outputs().reports,
        FIXTURE_MISSING_NATIVE_BODY: 'true',
    });
    assert.equal(result.status, 1);
    assert.equal(outputs().reports, undefined);
});

await test('caller command lists authorize aliases and preserve routing through publication', (t) => {
    const { run, outputs, write, read } = reviewFixture(t, {
        files: { '.reviewrelay.json': JSON.stringify({ reviewId: 'localization' }) },
    });
    const policy = {
        FIXTURE_ACTION: 'true',
        REVIEW_REVIEW_COMMANDS: '["/review-localization","/review-fr"]',
        REVIEW_IMPROVE_COMMANDS: '["/improve-localization"]',
    };
    for (const body of [
        '/review',
        '/improve',
        '/unknown',
        '/review-fr more',
        '/REVIEW-FR',
        '/review-fr\nmore',
    ]) {
        write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body } }));
        assert.equal(run('authorize', policy).status, 0);
        assert.equal(outputs().allowed, undefined);
    }
    for (const body of ['/review-localization', '/review-fr\r\n']) {
        write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body } }));
        assert.equal(run('authorize', policy).status, 0);
        assert.equal(JSON.parse(outputs().request).command, 'review');
    }
    const request = outputs().request;
    const env = { ...policy, REVIEW_REQUEST: request };
    const forged = run('improve', {
        ...env,
        REVIEW_REQUEST: JSON.stringify({ ...JSON.parse(request), command: 'improve' }),
    });
    assert.equal(forged.status, 1);
    assert.match(forged.stderr, /original GitHub event/);
    const denied = run('analyze', { ...env, FIXTURE_PERMISSION: 'read' });
    assert.equal(denied.status, 1);
    const wrong = run('analyze', {
        ...env,
        REVIEW_REVIEW_COMMANDS: '[]',
        REVIEW_IMPROVE_COMMANDS: '["/review-fr"]',
    });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /original GitHub event/);
    assert.equal(run('analyze', env).status, 0);
    const analysis = outputs().reports;
    const synthesis = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: analysis,
    });
    assert.equal(synthesis.status, 0, synthesis.stderr);
    assert.equal(JSON.parse(read('native-arguments')).at(-1), 'review');
    const reports = outputs().reports;
    const wrongPublisher = run('publish', {
        ...env,
        REVIEW_REVIEW_COMMANDS: '["/different"]',
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
        REVIEW_PROVIDER_ENV: '{}',
    });
    assert.equal(wrongPublisher.status, 1);
    assert.match(wrongPublisher.stderr, /original GitHub event/);
    const published = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: reports,
        REVIEW_PROVIDER_ENV: '{}',
    });
    assert.equal(published.status, 0, published.stderr);
    assert.match(JSON.parse(read('published')).body, /reviewrelay:stream:localization/);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
    write(
        'event.json',
        JSON.stringify({ ...manual, comment: { id: 124, body: '/improve-localization' } }),
    );
    assert.equal(run('authorize', policy).status, 0);
    const improve = { ...policy, REVIEW_REQUEST: outputs().request };
    assert.equal(JSON.parse(improve.REVIEW_REQUEST).command, 'improve');
    assert.equal(run('analyze', improve).status, 1);
    assert.equal(run('improve', improve).status, 0);
    assert.equal(JSON.parse(read('native-arguments')).at(-1), 'improve');
    const suggestions = outputs().reports;
    const sent = run('publish', {
        ...improve,
        REVIEW_ARTIFACT_ID: '70',
        FIXTURE_ARCHIVE_DIR: suggestions,
        REVIEW_PROVIDER_ENV: '{}',
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(outputs().state, 'published');
});

await test('invalid or disabled caller command lists cannot authorize inference', (t) => {
    const { run, outputs, fixture, write } = reviewFixture(t);
    for (const policy of [
        { REVIEW_REVIEW_COMMANDS: 'not-json' },
        { REVIEW_REVIEW_COMMANDS: '{}' },
        { REVIEW_REVIEW_COMMANDS: '[1]' },
        { REVIEW_REVIEW_COMMANDS: '["review"]' },
        { REVIEW_REVIEW_COMMANDS: '["/review more"]' },
        { REVIEW_REVIEW_COMMANDS: '["/review\\n"]' },
        { REVIEW_REVIEW_COMMANDS: '["/same","/same"]' },
        { REVIEW_REVIEW_COMMANDS: '["/same"]', REVIEW_IMPROVE_COMMANDS: '["/same"]' },
        { REVIEW_IMPROVE_COMMANDS: 'null' },
    ]) {
        const result = run('authorize', { FIXTURE_ACTION: 'true', ...policy });
        assert.equal(result.status, 1, JSON.stringify(policy));
        assert.match(result.stderr, /command/i);
        assert.equal(outputs().allowed, undefined);
    }
    for (const policy of [
        { REVIEW_REVIEW_COMMANDS: '[]' },
        { REVIEW_IMPROVE_COMMANDS: '["/suggest"]' },
    ]) {
        write('event.json', JSON.stringify({ ...manual, comment: { id: 123, body: '/review' } }));
        assert.equal(run('authorize', { FIXTURE_ACTION: 'true', ...policy }).status, 0);
        assert.equal(outputs().allowed, undefined);
    }
    const prepare = run('authorize', {
        FIXTURE_ACTION: 'true',
        FIXTURE_PREPARE: 'true',
        REVIEW_REVIEW_COMMANDS: '{}',
    });
    assert.equal(prepare.status, 1);
    assert.match(prepare.stderr, /review-commands/);
    const noComments = commentCommands({ REVIEW_REVIEW_COMMANDS: '[]' });
    assert.deepEqual(
        reviewRequest('workflow_dispatch', { inputs: { pull_request: '42' } }, true, noComments),
        { number: 42, command: 'review', manual: true },
    );
    assert.deepEqual(reviewRequest('pull_request_target', automatic, true, noComments), {
        number: 42,
        command: 'review',
        manual: false,
    });
    assert.ok(!readdirSync(fixture).includes('provider-calls'));
    assert.ok(!readdirSync(fixture).includes('published'));
});
