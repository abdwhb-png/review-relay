import { composeReviewOutput } from '../../bin/review-output.mjs';
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
const fixtureRun = {id:900,head_sha:process.env.GITHUB_WORKFLOW_SHA,event:'issue_comment',head_branch:'main',path:process.env.FIXTURE_WRONG_WORKFLOW || '.github/workflows/custom.yml',repository:{full_name:process.env.GITHUB_REPOSITORY},head_repository:{full_name:process.env.GITHUB_REPOSITORY}};
const artifactPages = JSON.parse(process.env.FIXTURE_ARTIFACT_PAGES || JSON.stringify([{artifacts:[{id:70,name:process.env.FIXTURE_ARTIFACT_NAME || 'reviewrelay-analyze-42-1',expired:false}]}])).map(page=>({...page,artifacts:page.artifacts.map(a=>({workflow_run:{id:900},...a}))}));
if (process.env.FIXTURE_NO_METADATA && (endpoint.endsWith('/artifacts/70') || endpoint.endsWith('/actions/runs/900'))) process.exit(77);
if (endpoint.endsWith('/zip')) {
    if (process.env.FIXTURE_ZIP_GONE) {
        console.error('gh: Gone (HTTP 410)');
        process.exit(1);
    }
    const id = endpoint.split('/').at(-2);
    const archive = JSON.parse(process.env.FIXTURE_ARCHIVES || '{}')[id] || process.env.FIXTURE_ARCHIVE_DIR || process.env.FIXTURE_PREVIOUS_DIR;
    const result=require('node:child_process').spawnSync('python3',['-c','import os,sys,zipfile; z=zipfile.ZipFile(sys.stdout.buffer, "w"); root=sys.argv[1]; [z.write(os.path.join(root,n),n) for n in os.listdir(root)]; z.close()',archive]);
    process.stdout.write(result.stdout);process.exit(result.status);
}
if (/\\/artifacts\\/[0-9]+$/.test(endpoint)) {
    const id = Number(endpoint.split('/').at(-1));
    console.log(JSON.stringify({id,expired:false,workflow_run:{id:id === 70 ? 900 : Number(process.env.GITHUB_RUN_ID)}}));process.exit(0);
}
if (/\\/actions\\/runs\\/[0-9]+$/.test(endpoint)) {
    const id = Number(endpoint.split('/').at(-1));
    console.log(JSON.stringify({id,event:process.env.FIXTURE_SOURCE_EVENT || 'issue_comment',head_branch:'main',path:process.env.FIXTURE_WRONG_WORKFLOW || '.github/workflows/custom.yml',head_sha:process.env.FIXTURE_SOURCE_EVENT === 'pull_request_target' ? process.env.HEAD_SHA : process.env.GITHUB_WORKFLOW_SHA,repository:{full_name:process.env.GITHUB_REPOSITORY},head_repository:{full_name:process.env.GITHUB_REPOSITORY}}));process.exit(0);
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
} else if (endpoint.includes('/actions/workflows/')) console.log(JSON.stringify([{workflow_runs:JSON.parse(process.env.FIXTURE_RUNS || '{"workflow_runs":[]}').workflow_runs.map(r=>({...fixtureRun,...r}))}]));
else if (endpoint.includes('/artifacts?')) {
    const id = Number(endpoint.split('/').at(-2));
    const forRun = JSON.parse(process.env.FIXTURE_RUN_ARTIFACTS || '{}')[id];
    console.log(JSON.stringify(forRun ? [{ artifacts: forRun.map((artifactId) => ({id: artifactId,name:'reviewrelay-analyze-42-1',expired:false,workflow_run:{id}})) }] : artifactPages));
}
else if (endpoint.endsWith('/issues/42/comments')) {
    if (process.env.FIXTURE_REFERENCE_FAILURE) process.exit(1);
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
if (process.env.FIXTURE_NO_DOCKER) process.exit(78);
if(args[0]==='image' || args[0]==='pull') process.exit(0);
const mount = (name) => args.find((arg) => arg.includes(',dst=' + name)).split(',')[1].slice(4);
if (args.includes('/opt/native.py') && !args.includes('generate')) {
    if (process.env.FIXTURE_NATIVE_SCOPE && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Missing native Actions identity');
    if (args.at(-1)==='scope') {
        const paths=execFileSync('git',['diff','--no-renames','--name-only',process.env.BASE_SHA+'...'+process.env.HEAD_SHA],{encoding:'utf8'}).trim().split('\\n');
        const ignore=[...JSON.parse(process.env.IGNORE__REGEX || '[]'),...JSON.parse(process.env.REVIEW_EXCLUDED_REGEX || '[]')].map(x=>new RegExp(x));
        const scope=process.env.REVIEW_FULL==='true' ? null : process.env.FIXTURE_NATIVE_SCOPE;
        if (scope && process.env.FIXTURE_SCOPE_BASE) {
            console.log(JSON.stringify({...JSON.parse(scope),start:process.env.BASE_SHA}));
            process.exit(0);
        }
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
    console.log(JSON.stringify({info:{id:'ses_fixture'},messages:[{type:'user',text:'Previous context fixture-gh-token'},{id:'end',type:'assistant',model:{providerID:'fixture',id:'review-model'},content:[{type:'text',text:process.env.FIXTURE_SANITIZED_EXPORT ? '[redacted:text:end]' : (process.env.FIXTURE_ANALYSIS_REPORT || 'OpenCode report fixture-go-key')}]}]}));
} else if (args.includes('--standalone')) {
    fs.appendFileSync('provider-calls', 'opencode\\n');
    const src = mount('/review');
    if (fs.existsSync(src + '/reviewrelay-checkpoint.json')) {
        fs.copyFileSync(src + '/reviewrelay-checkpoint.json', 'checkpoint-evidence');
        fs.copyFileSync(src + '/reviewrelay-publication.diff', 'publication-diff');
    }
    fs.copyFileSync(src + '/reviewrelay-review.diff', 'opencode.diff');
    fs.copyFileSync(src + '/.missions/one/evidence/archive.patch', 'archived-proof');
    fs.writeFileSync('opencode-arguments',JSON.stringify(args));
    fs.writeFileSync('snapshot',JSON.stringify(Object.fromEntries(fs.readdirSync(src,{recursive:true}).filter(p=>fs.statSync(src+'/'+p).isFile() && !p.startsWith('.git/')).map(p=>[p,fs.readFileSync(src+'/'+p,'utf8')]))));
    fs.writeFileSync('opencode-inline-config',process.env.OPENCODE_CONFIG_CONTENT);
    console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'end',text:process.env.FIXTURE_ANALYSIS_REPORT || 'OpenCode report fixture-go-key'}}));
    console.log(JSON.stringify({type:'step_finish',part:{reason:'stop',messageID:'end',tokens:{input:11,output:7,reasoning:3,cache:{read:101,write:0}}}}));
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
            overrides.FIXTURE_INSTALL
                ? [fileURLToPath(new URL('../../bin/install-runtime.mjs', import.meta.url))]
                : overrides.FIXTURE_ACTION
                  ? [
                        fileURLToPath(new URL('../../bin/action.mjs', import.meta.url)),
                        overrides.FIXTURE_PREPARE ? 'prepare' : 'run',
                    ]
                  : [fileURLToPath(new URL('../../bin/pr-review.mjs', import.meta.url)), command],
            {
                cwd: overrides.FIXTURE_CWD || fixture,
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
    const { producer, compatibility, configurationSha256, execution, ...payload } = manifest;
    assert.equal(execution.provider, 'primary');
    assert.ok(execution.seconds >= 0);
    assert.equal(producer.runId, '900');
    assert.equal(producer.workflowSha, baseSha);
    assert.equal(compatibility.version, runtime.version);
    assert.match(compatibility.engine, /^[a-f0-9]{64}$/);
    assert.match(configurationSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(payload, {
        schemaVersion: 4,
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
        diffOrigin: baseSha,
        inspection: { start: baseSha, diffSha256: createHash('sha256').update(diff).digest('hex') },
        checkpoint: null,
        reusedAnalysis: null,
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

    const published = run('publish', {
        REVIEW_REPORT_DIR: synthesis.reports,
        PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify(globs),
    });
    assert.equal(published.status, 0, published.stderr);
    const sent = JSON.parse(read('published'));
    assert.match(sent.body, /<!-- reviewrelay:[a-f0-9]{64} -->$/);
    assert.deepEqual(
        { ...sent, body: sent.body.split('\n\n<details>')[0] },
        {
            body: 'PR-Agent report [redacted]\n\nReview scope: 1 files excluded from the primary diff by the configured review globs.',
            commit_id: headSha,
            event: 'COMMENT',
        },
    );

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
    const beforeCorruption = read('provider-calls');
    const priorSessionPath = join(reports, 'opencode-session.json');
    writeFileSync(priorSessionPath, 'Corrupted session');
    const invalidSession = run('analyze', continuation);
    assert.equal(invalidSession.status, 1);
    assert.match(invalidSession.stderr, /Artifact payload checksum mismatch/);
    assert.equal(read('provider-calls'), beforeCorruption);

    const importedBeforeReset = read('session-imports');
    const reset = run('analyze', { ...continuation, FIXTURE_RUNS: '{"workflow_runs":[]}' });
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /No compatible archived OpenCode session.*complete review/);
    assert.match(read('opencode.diff'), /Mission contract/);
    assert.equal(read('session-imports'), importedBeforeReset);
    assert.ok(!JSON.parse(read('opencode-arguments')).includes('--session'));

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
const fixtureRun = {id:900,head_sha:process.env.GITHUB_WORKFLOW_SHA,event:'issue_comment',head_branch:'main',path:process.env.FIXTURE_WRONG_WORKFLOW || '.github/workflows/custom.yml',repository:{full_name:process.env.GITHUB_REPOSITORY},head_repository:{full_name:process.env.GITHUB_REPOSITORY}};
const artifactPages = JSON.parse(process.env.FIXTURE_ARTIFACT_PAGES || JSON.stringify([{artifacts:[{id:70,name:process.env.FIXTURE_ARTIFACT_NAME || 'reviewrelay-analyze-42-1',expired:false}]}])).map(page=>({...page,artifacts:page.artifacts.map(a=>({workflow_run:{id:900},...a}))}));
if (process.env.FIXTURE_NO_METADATA && (endpoint.endsWith('/artifacts/70') || endpoint.endsWith('/actions/runs/900'))) process.exit(77);
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
    assert.equal(manifest.schemaVersion, 4);
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
    assert.equal(manifest.schemaVersion, 4);
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
    assert.ok(reviewBody.startsWith(archived + '\n\n'));
    assert.ok(reviewBody.endsWith(publicationId));
    assert.match(reviewBody, /OpenCode analysis report/);
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
                    files: {
                        '.reviewrelay.json': JSON.stringify({
                            reviewId,
                            includeAnalysisReport: false,
                            includePipelineDetails: false,
                        }),
                    },
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
    const continuation = {
        FIXTURE_NO_METADATA: '1',
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
    };
    const resumed = run('analyze', continuation);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Resuming OpenCode session from run 900/);
    assert.match(read('session-imports'), /Previous context/);
    assert.match(read('opencode.diff'), /Follow-up change/);
    assert.doesNotMatch(read('opencode.diff'), /^\+Product change/m);
    for (const invalid of [
        { run: { repository: { full_name: 'foreign/project' } } },
        { run: { path: '.github/workflows/untrusted.yml' } },
        { artifact: { workflow_run: { id: 999 } } },
    ]) {
        const runs = JSON.parse(continuation.FIXTURE_RUNS);
        Object.assign(runs.workflow_runs[0], invalid.run);
        const pages = JSON.parse(continuation.FIXTURE_ARTIFACT_PAGES);
        Object.assign(pages[1].artifacts[0], invalid.artifact);
        const denied = run('analyze', {
            ...continuation,
            FIXTURE_RUNS: JSON.stringify(runs),
            FIXTURE_ARTIFACT_PAGES: JSON.stringify(pages),
        });
        assert.equal(denied.status, 1);
        assert.match(denied.stderr, /trusted consumer workflow/);
    }
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

await test('review publication needs no Docker installation or invocation', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    const initial = run('analyze');
    assert.equal(initial.status, 0, initial.stderr);
    const analysis = outputs().reports;
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: analysis }).status, 0);
    const reports = outputs().reports;
    const setup = run('publish', { FIXTURE_INSTALL: true, FIXTURE_NO_DOCKER: '1' });
    assert.equal(setup.status, 0, setup.stderr);
    const result = run('publish', { REVIEW_REPORT_DIR: reports, FIXTURE_NO_DOCKER: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(read('published')).body, /PR-Agent report/);
    assert.match(JSON.parse(read('reference')).body, /Native reference/);
});

await test('finish resolves the latest retry check from a shallow trusted checkout', (t) => {
    const { fixture, git, run, baseSha } = reviewFixture(t);
    git('branch', 'frozen-base', baseSha);
    const shallow = join(fixture, 'shallow');
    git('clone', '--quiet', '--depth=1', '--branch=frozen-base', 'file://' + fixture, shallow);
    assert.equal(
        spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
            cwd: shallow,
            encoding: 'utf8',
        }).stdout.trim(),
        'true',
    );
    const check = {
        name: 'ReviewRelay PR review',
        external_id: 'reviewrelay-900',
        app: { slug: 'github-actions' },
    };
    const result = run('finish', {
        FIXTURE_CWD: shallow,
        GITHUB_RUN_ATTEMPT: '2',
        PUBLISH_RESULT: 'success',
        FIXTURE_CHECK_RUNS: JSON.stringify([
            { ...check, id: 123 },
            { ...check, id: 124 },
        ]),
    });
    assert.equal(result.status, 0, result.stderr);
    const updates = readFileSync(join(shallow, 'check-updates'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    assert.equal(updates.at(-1).endpoint, 'repos/example/project/check-runs/124');
    assert.equal(updates.at(-1).body.conclusion, 'success');
});

await test('publication includes verified analysis and pipeline measurements without another inference', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    assert.equal(run('analyze').status, 0);
    const analysis = outputs().reports;
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: analysis }).status, 0);
    const reports = outputs().reports;
    const publication = JSON.parse(readFileSync(join(reports, 'publication.json'), 'utf8'));
    assert.match(publication.analysisReport, /OpenCode report/);
    assert.deepEqual(publication.execution.analysis.tokens, {
        input: 11,
        output: 7,
        reasoning: 3,
        cache: { read: 101, write: 0 },
    });
    assert.deepEqual(publication.execution.analysis.models, ['fixture/review-model']);
    assert.doesNotMatch(
        JSON.stringify(publication),
        /Previous context|fixture-go-key|fixture-gh-token/,
    );
    const result = run('publish', { REVIEW_REPORT_DIR: reports });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(read('published')).body;
    assert.match(body, /<summary>OpenCode analysis report<\/summary>/);
    assert.match(body, /OpenCode report/);
    assert.match(body, /<summary>ReviewRelay pipeline details<\/summary>/);
    assert.match(body, /PR-Agent statistics/);
    assert.equal(run('publish', { REVIEW_REPORT_DIR: reports }).status, 0);
    assert.equal(read('published').trim().split('\n').length, 1);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
});

await test('projects can disable ReviewRelay additions without replacing native output', (t) => {
    const { run, outputs, read } = reviewFixture(t, {
        files: {
            '.reviewrelay.json': JSON.stringify({
                includeAnalysisReport: false,
                includePipelineDetails: false,
            }),
        },
    });
    const analyzed = run('analyze');
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: outputs().reports }).status, 0);
    assert.equal(run('publish', { REVIEW_REPORT_DIR: outputs().reports }).status, 0);
    const body = JSON.parse(read('published')).body;
    assert.match(body, /PR-Agent report/);
    assert.doesNotMatch(body, /<details>|OpenCode report/);
});

await test('large verified analysis is excerpted safely while native findings and the full artifact are retained', (t) => {
    const { run, outputs, read } = reviewFixture(t);
    assert.equal(run('analyze').status, 0);
    const analysis = outputs().reports;
    const report = 'Évidence 😀 <script> & ```\n'.repeat(9000);
    writeFileSync(join(analysis, 'opencode-report.md'), report);
    const manifest = JSON.parse(readFileSync(join(analysis, 'manifest.json'), 'utf8'));
    manifest.files['opencode-report.md'] = createHash('sha256').update(report).digest('hex');
    writeFileSync(join(analysis, 'manifest.json'), JSON.stringify(manifest));
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: analysis }).status, 0);
    const synthesis = outputs().reports;
    assert.equal(
        JSON.parse(readFileSync(join(synthesis, 'publication.json'))).analysisReport,
        report,
    );
    const result = run('publish', { REVIEW_REPORT_DIR: synthesis });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(read('published')).body;
    assert.ok(Buffer.byteLength(body) <= 65536);
    assert.ok(body.startsWith('PR-Agent report'));
    assert.match(body, /Report excerpt/);
    assert.match(body, /Complete analysis artifact/);
    assert.match(body, /&lt;script&gt;/);
    assert.doesNotMatch(body, /\uFFFD/);
    const repeat = run('publish', { REVIEW_REPORT_DIR: synthesis });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(read('published').trim().split('\n').length, 1);
});

await test('presentation settings reject non-boolean values before generation', (t) => {
    for (const field of ['includeAnalysisReport', 'includePipelineDetails']) {
        const { run, fixture } = reviewFixture(t, {
            files: { '.reviewrelay.json': JSON.stringify({ [field]: 'false' }) },
        });
        assert.equal(run('analyze').status, 1);
        assert.ok(!readdirSync(fixture).includes('provider-calls'));
    }
});

await test('pipeline elapsed time rounds the measured half-step and marks missing timestamps unavailable', () => {
    const publication = {
        analysisReport: 'Report',
        analysisSource: { runId: '900', artifactId: null },
    };
    const config = { includeAnalysisReport: false, includePipelineDetails: true };
    const context = {
        repository: 'example/project',
        createdAt: '2026-01-01T00:00:00.000Z',
        now: Date.parse('2026-01-01T00:00:01.550Z'),
    };
    assert.match(
        composeReviewOutput('Native', 'marker', publication, config, context),
        /publication preparation: 1\.6s/,
    );
    assert.match(
        composeReviewOutput('Native', 'marker', publication, config, {
            ...context,
            createdAt: undefined,
        }),
        /publication preparation: unavailable/,
    );
});

await test('report and pipeline presentation controls remain independent', (t) => {
    for (const field of ['includeAnalysisReport', 'includePipelineDetails']) {
        const { run, outputs, read } = reviewFixture(t, {
            files: { '.reviewrelay.json': JSON.stringify({ [field]: false }) },
        });
        assert.equal(run('analyze').status, 0);
        assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: outputs().reports }).status, 0);
        const result = run('publish', { REVIEW_REPORT_DIR: outputs().reports });
        assert.equal(result.status, 0, result.stderr);
        const body = JSON.parse(read('published')).body;
        assert.equal(
            body.includes('<summary>OpenCode analysis report</summary>'),
            field !== 'includeAnalysisReport',
        );
        assert.equal(
            body.includes('<summary>ReviewRelay pipeline details</summary>'),
            field !== 'includePipelineDetails',
        );
    }
});

await test('publication refuses incomplete analysis or invalid source references before writing', (t) => {
    for (const mutation of [
        { analysisReport: '' },
        { analysisSource: { runId: '900', artifactId: 'invalid' } },
    ]) {
        const { run, outputs, fixture } = reviewFixture(t);
        assert.equal(run('analyze').status, 0);
        assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: outputs().reports }).status, 0);
        const dir = outputs().reports;
        const publication = JSON.parse(readFileSync(join(dir, 'publication.json')));
        const value = JSON.stringify({ ...publication, ...mutation });
        writeFileSync(join(dir, 'publication.json'), value);
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json')));
        manifest.files['publication.json'] = createHash('sha256').update(value).digest('hex');
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
        const result = run('publish', { REVIEW_REPORT_DIR: dir });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /analysis report|artifact reference/);
        assert.ok(!readdirSync(fixture).includes('published'));
        assert.ok(!readdirSync(fixture).includes('reference'));
    }
});

await test('descendant analysis continues before any native reference', (t) => {
    const { run, outputs, read, write, git, expectedPull, headSha } = reviewFixture(t);
    const initial = run('analyze', { FIXTURE_ANALYSIS_REPORT: 'Prior report on C1' });
    assert.equal(initial.status, 0, initial.stderr);
    const previous = outputs().reports;

    write('app.txt', 'Product change\nFollow-up change\n');
    git('commit', '-qam', 'Follow-up');
    const nextHead = git('rev-parse', 'HEAD');
    const continuation = {
        HEAD_SHA: nextHead,
        GITHUB_RUN_ID: '901',
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: nextHead },
        }),
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: [{ id: 900, conclusion: 'failure' }] }),
        FIXTURE_PREVIOUS_DIR: previous,
        FIXTURE_ANALYSIS_REPORT: 'Consolidated report on C2',
    };
    const resumed = run('analyze', continuation);
    assert.equal(resumed.status, 0, resumed.stderr);
    const reports = outputs().reports;
    const manifest = JSON.parse(readFileSync(join(reports, 'manifest.json'), 'utf8'));
    assert.equal(manifest.scope.incremental, false);
    assert.equal(manifest.checkpoint?.artifactId, '70');
    assert.equal(manifest.inspection.start, headSha);
    assert.match(read('session-imports'), /Prior report on C1/);
    assert.equal(JSON.parse(read('checkpoint-evidence')).report, 'Prior report on C1\n');
    assert.doesNotMatch(read('opencode.diff'), /^\+Product change/m);
    assert.match(read('opencode.diff'), /^\+Follow-up change/m);
    const synthesized = run('synthesize', { ...continuation, OPENCODE_REPORT_DIR: reports });
    assert.equal(synthesized.status, 0, synthesized.stderr);
    assert.match(read('pr-agent.diff'), /^\+Product change/m);
    assert.equal(read('pr-agent-input.md'), 'Consolidated report on C2\n');
    assert.equal(
        manifest.diffSha256,
        createHash('sha256').update(read('pr-agent.diff')).digest('hex'),
    );
    assert.equal(
        manifest.inspection.diffSha256,
        createHash('sha256').update(read('opencode.diff')).digest('hex'),
    );
    assert.deepEqual(manifest.execution.tokens, {
        input: 11,
        output: 7,
        reasoning: 3,
        cache: { read: 101, write: 0 },
    });
});

function archivedAnalysis(t, options = {}, initial = {}) {
    const fixture = reviewFixture(t, options);
    const { run, outputs, expectedPull, headSha } = fixture;
    const result = run('analyze', initial);
    assert.equal(result.status, 0, result.stderr);
    const previous = outputs().reports;
    const request = (head = headSha, overrides = {}) => ({
        ...initial,
        HEAD_SHA: head,
        GITHUB_RUN_ID: '901',
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: head },
        }),
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: [{ id: 900, conclusion: 'failure' }] }),
        FIXTURE_PREVIOUS_DIR: previous,
        ...overrides,
    });
    const manifest = () =>
        JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8'));
    return { ...fixture, previous, request, manifest };
}

await test('descendant analysis consolidates an excluded-only change', (t) => {
    const support = '.missions/one/evidence/browser.json';
    const { run, outputs, read, write, git, request, manifest } = archivedAnalysis(
        t,
        {},
        {
            PR_REVIEW_EXCLUDE_GLOBS: JSON.stringify([support]),
        },
    );
    write(support, 'Current supporting evidence\n');
    git('commit', '-qam', 'Change supporting evidence');
    const next = request(git('rev-parse', 'HEAD'));
    const result = run('analyze', next);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(outputs().skipped, undefined);
    assert.equal(read('opencode.diff'), '');
    assert.equal(manifest().inspection.diffSha256, createHash('sha256').digest('hex'));
    assert.deepEqual(JSON.parse(read('checkpoint-evidence')).changedPaths, [support]);
    assert.equal(JSON.parse(read('snapshot'))[support], 'Current supporting evidence\n');
    const synth = run('synthesize', { ...next, OPENCODE_REPORT_DIR: outputs().reports });
    assert.equal(synth.status, 0, synth.stderr);
    assert.match(read('pr-agent.diff'), /^\+Product change/m);
    assert.equal(read('pr-agent.diff'), read('publication-diff'));
});

await test('descendant analysis honors the trusted stream mode and overrides', (t) => {
    const config = { reviewId: 'localization', analysisResumeMode: 'full' };
    const { run, outputs, read, write, git, request, manifest } = archivedAnalysis(
        t,
        { files: { 'localization.json': JSON.stringify(config) } },
        {
            REVIEW_CONFIG_PATH: 'localization.json',
            FIXTURE_ARTIFACT_NAME: 'reviewrelay-analyze-42-localization-1',
        },
    );
    write('app.txt', 'Product change\nFollow-up change\n');
    git('commit', '-qam', 'Follow-up');
    const head = git('rev-parse', 'HEAD');
    const result = run('analyze', request(head));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(manifest().reviewId, 'localization');
    assert.equal(manifest().inspection.start, manifest().diffOrigin);
    assert.match(read('session-imports'), /Previous context/);
    assert.equal(read('opencode.diff'), read('publication-diff'));
    const synth = run('synthesize', { ...request(head), OPENCODE_REPORT_DIR: outputs().reports });
    assert.equal(synth.status, 0, synth.stderr);
    assert.equal(read('opencode.diff'), read('pr-agent.diff'));
    const overridden = run(
        'analyze',
        request(head, { REVIEW_OVERRIDES: '{"analysisResumeMode":"delta"}' }),
    );
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(
        manifest().checkpoint,
        null,
        'changed effective mode must invalidate the full-mode archive',
    );
    const calls = read('provider-calls');
    const invalid = run(
        'analyze',
        request(head, { REVIEW_OVERRIDES: '{"analysisResumeMode":"fast"}' }),
    );
    assert.equal(invalid.status, 1);
    assert.equal(read('provider-calls'), calls);
});

await test('descendant analysis checks prefix coverage for newly admitted paths', (t) => {
    const { run, git, write, read, request, manifest, baseSha } = archivedAnalysis(
        t,
        {},
        {
            FIXTURE_NATIVE_SCOPE: JSON.stringify({
                incremental: false,
                start: null,
                first: null,
                paths: ['app.txt'],
            }),
            FIXTURE_SCOPE_BASE: 'true',
        },
    );
    write('app.txt', 'Product change\nFollow-up change\n');
    git('commit', '-qam', 'Follow-up');
    const result = run(
        'analyze',
        request(git('rev-parse', 'HEAD'), {
            FIXTURE_SCOPE_BASE: '',
            FIXTURE_NATIVE_SCOPE: JSON.stringify({
                incremental: false,
                start: baseSha,
                first: null,
                paths: ['app.txt', '.missions/one/spec.md'],
            }),
        }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(manifest().checkpoint, null);
    assert.match(read('opencode.diff'), /Mission contract/);
    assert.match(result.stdout, /usable history and coverage/);
});

await test('descendant analysis uses the effective origin with an off-branch target tip', (t) => {
    const { run, git, write, outputs, baseSha, headSha, expectedPull } = reviewFixture(t);
    git('checkout', '--detach', baseSha);
    write('target.txt', 'Target only\n');
    git('add', 'target.txt');
    git('commit', '-qm', 'Advance target');
    const target = git('rev-parse', 'HEAD');
    git('checkout', '--detach', headSha);
    const request = (head, options = {}) => ({
        BASE_SHA: target,
        HEAD_SHA: head,
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            base: { ...expectedPull.base, sha: target },
            head: { ...expectedPull.head, sha: head },
        }),
        ...options,
    });
    const initial = run('analyze', request(headSha));
    assert.equal(initial.status, 0, initial.stderr);
    const previous = outputs().reports;
    const history = {
        GITHUB_RUN_ID: '901',
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: [{ id: 900 }] }),
        FIXTURE_PREVIOUS_DIR: previous,
    };
    write('app.txt', 'Product change\nAdvance head\n');
    git('commit', '-qam', 'Advance head');
    const resumed = run('analyze', request(git('rev-parse', 'HEAD'), history));
    assert.equal(resumed.status, 0, resumed.stderr);
    const manifest = () =>
        JSON.parse(readFileSync(join(outputs().reports, 'manifest.json'), 'utf8'));
    assert.equal(manifest().diffOrigin, baseSha);
    assert.equal(manifest().checkpoint.head, headSha);

    git('merge', '--no-edit', target);
    const merged = run('analyze', request(git('rev-parse', 'HEAD'), history));
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(manifest().diffOrigin, target);
    assert.equal(manifest().checkpoint, null);
    assert.match(merged.stdout, /usable history and coverage/);
});

await test('descendant analysis selects progress before run recency and fails for selected corruption', (t) => {
    const { run, git, write, read, outputs, request, previous, manifest } = archivedAnalysis(t);
    write('app.txt', 'Product change\nSecond change\n');
    git('commit', '-qam', 'Second change');
    const second = run('analyze', request(git('rev-parse', 'HEAD')));
    assert.equal(second.status, 0, second.stderr);
    const secondArchive = outputs().reports;

    write('app.txt', 'Product change\nSecond change\nThird change\n');
    git('commit', '-qam', 'Third change');
    const runs = [
        { id: 900, updated_at: '2026-11-26' },
        { id: 901, updated_at: '2026-11-25' },
    ];
    const next = request(git('rev-parse', 'HEAD'), {
        GITHUB_RUN_ID: '902',
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: runs }),
        FIXTURE_ARCHIVES: JSON.stringify({ 70: previous, 71: secondArchive }),
        FIXTURE_RUN_ARTIFACTS: JSON.stringify({ 900: [70], 901: [71] }),
    });
    const third = run('analyze', next);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(manifest().checkpoint.artifactId, '71');

    writeFileSync(join(secondArchive, 'opencode-report.md'), 'Corrupted report');
    const calls = read('provider-calls');
    const corrupted = run('analyze', {
        ...next,
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: runs.reverse() }),
    });
    assert.equal(corrupted.status, 1);
    assert.match(corrupted.stderr, /Artifact payload checksum mismatch/);
    assert.equal(read('provider-calls'), calls);
});

await test('synthesis rejects a reconstructed inspection digest mismatch before inference', (t) => {
    const { run, read, outputs, previous } = archivedAnalysis(t);
    const path = join(previous, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.inspection.diffSha256 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest));

    const rejected = run('synthesize', { OPENCODE_REPORT_DIR: previous });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /archived OpenCode report cannot be reused/);
    assert.equal(outputs().state, 'new-review-required');
    assert.equal(read('provider-calls'), 'opencode\n');
});

await test('same-head analysis reuses verified payloads without another OpenCode call', (t) => {
    const { run, outputs, read, request, manifest, previous, fixture, baseSha, headSha } =
        archivedAnalysis(t);
    const failed = run('synthesize', {
        OPENCODE_REPORT_DIR: previous,
        FIXTURE_SYNTHESIS_ERROR: 'RateLimitError: Daily quota exhausted',
    });
    assert.equal(failed.status, 1);
    const overrides = request();
    const action = { ...overrides, FIXTURE_ACTION: 'true' };
    const auth = run('authorize', action);
    assert.equal(auth.status, 0, auth.stderr);
    action.REVIEW_REQUEST = outputs().request;
    const reused = run('analyze', action);
    assert.equal(reused.status, 0, reused.stderr);
    const newArchive = outputs().reports;
    assert.equal(manifest().execution, null);
    assert.equal(manifest().inspection, null);
    assert.deepEqual(manifest().reusedAnalysis, {
        head: headSha,
        runId: '900',
        attempt: '1',
        artifactId: '70',
    });
    assert.equal(manifest().producer.runId, '901');
    for (const name of ['opencode-report.md', 'opencode-session.json'])
        assert.deepEqual(readFileSync(join(newArchive, name)), readFileSync(join(previous, name)));
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
    const reusedAgain = run(
        'analyze',
        request(headSha, {
            GITHUB_RUN_ID: '902',
            FIXTURE_RUNS: JSON.stringify({ workflow_runs: [{ id: 901 }] }),
            FIXTURE_RUN_ARTIFACTS: JSON.stringify({ 901: [71] }),
            FIXTURE_ARCHIVES: JSON.stringify({ 71: newArchive }),
        }),
    );
    assert.equal(reusedAgain.status, 0, reusedAgain.stderr);
    assert.equal(manifest().reusedAnalysis.runId, '900');
    assert.equal(manifest().reusedAnalysis.artifactId, '70');
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
    const synthesize = () =>
        run('synthesize', {
            ...action,
            REVIEW_ARTIFACT_ID: '71',
            FIXTURE_ARCHIVES: JSON.stringify({ 71: newArchive }),
        });
    const archiveManifestPath = join(newArchive, 'manifest.json');
    const validArchiveManifest = readFileSync(archiveManifestPath, 'utf8');
    const inconsistentArchive = JSON.parse(validArchiveManifest);
    inconsistentArchive.reusedAnalysis.head = baseSha;
    writeFileSync(archiveManifestPath, JSON.stringify(inconsistentArchive));
    const rejectedSynthesis = synthesize();
    assert.equal(rejectedSynthesis.status, 1);
    assert.match(rejectedSynthesis.stderr, /archived OpenCode report cannot be reused/);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\n');
    writeFileSync(archiveManifestPath, validArchiveManifest);

    const synth = synthesize();
    assert.equal(synth.status, 0, synth.stderr);
    const synthesisArchive = outputs().reports;
    const publish = () =>
        run('publish', {
            ...action,
            REVIEW_ARTIFACT_ID: '72',
            FIXTURE_ARCHIVES: JSON.stringify({ 72: synthesisArchive }),
        });
    const publicationPath = join(synthesisArchive, 'publication.json');
    const synthesisManifestPath = join(synthesisArchive, 'manifest.json');
    const validPublication = readFileSync(publicationPath, 'utf8');
    const validSynthesisManifest = readFileSync(synthesisManifestPath, 'utf8');
    const inconsistentPublication = JSON.parse(validPublication);
    inconsistentPublication.execution.analysis = JSON.parse(
        readFileSync(join(previous, 'manifest.json'), 'utf8'),
    ).execution;
    const value = JSON.stringify(inconsistentPublication);
    const synthesisManifest = JSON.parse(validSynthesisManifest);
    synthesisManifest.files['publication.json'] = createHash('sha256').update(value).digest('hex');
    writeFileSync(publicationPath, value);
    writeFileSync(synthesisManifestPath, JSON.stringify(synthesisManifest));
    const rejectedPublication = publish();
    assert.equal(rejectedPublication.status, 1);
    assert.match(rejectedPublication.stderr, /Invalid reused analysis provenance for publication/);
    assert.ok(!readdirSync(fixture).includes('published'));
    assert.ok(!readdirSync(fixture).includes('reference'));
    writeFileSync(publicationPath, validPublication);
    writeFileSync(synthesisManifestPath, validSynthesisManifest);

    const published = publish();
    assert.equal(published.status, 0, published.stderr);
    const review = JSON.parse(read('published'));
    assert.equal(review.commit_id, headSha);
    assert.match(review.body, /reused.*run 900.*attempt 1/i);
    assert.match(review.body, /runs\/901\/artifacts\/71/);
    assert.doesNotMatch(review.body, /11 input|OpenCode route/);
    assert.equal(read('provider-calls'), 'opencode\npr-agent\npr-agent\n');
});

await test('same-head analysis does not duplicate a published review with a missing reference', (t) => {
    const { run, outputs, read, request, previous } = archivedAnalysis(t);
    assert.equal(run('synthesize', { OPENCODE_REPORT_DIR: previous }).status, 0);
    const original = outputs().reports;
    const next = request();
    assert.equal(run('analyze', next).status, 0);
    assert.equal(run('synthesize', { ...next, OPENCODE_REPORT_DIR: outputs().reports }).status, 0);
    const another = outputs().reports;
    const partial = run('publish', { REVIEW_REPORT_DIR: original, FIXTURE_REFERENCE_FAILURE: '1' });
    assert.equal(partial.status, 1);
    assert.equal(read('published').trim().split('\n').length, 1);
    const calls = read('provider-calls');
    const skipped = run('analyze', next);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(outputs().skipped, 'true');
    assert.equal(read('provider-calls'), calls);
    const duplicate = run('publish', { ...next, REVIEW_REPORT_DIR: another });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(read('published').trim().split('\n').length, 1);
    const replay = run('publish', { REVIEW_REPORT_DIR: original });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(read('published').trim().split('\n').length, 1);
    assert.equal(read('reference-calls'), '1');
});

await test('same-head analysis publishes and deduplicates each stream independently', (t) => {
    const { run, outputs, read, previous, headSha } = archivedAnalysis(t);
    const synth = run('synthesize', { OPENCODE_REPORT_DIR: previous });
    assert.equal(synth.status, 0, synth.stderr);
    const initial = run('publish', { REVIEW_REPORT_DIR: outputs().reports });
    assert.equal(initial.status, 0, initial.stderr);
    const defaultReference = JSON.parse(read('reference')).body;

    const namedRequest = {
        FIXTURE_ACTION: 'true',
        REVIEW_OVERRIDES: '{"reviewId":"localization"}',
        GITHUB_RUN_ID: '901',
    };
    const auth = run('authorize', namedRequest);
    assert.equal(auth.status, 0, auth.stderr);
    const env = { ...namedRequest, REVIEW_REQUEST: outputs().request };
    const analyzed = run('analyze', env);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal(outputs().skipped, undefined);
    const namedSynthesis = run('synthesize', {
        ...env,
        REVIEW_ARTIFACT_ID: '71',
        FIXTURE_ARCHIVES: JSON.stringify({ 71: outputs().reports }),
    });
    assert.equal(namedSynthesis.status, 0, namedSynthesis.stderr);
    const published = run('publish', {
        ...env,
        REVIEW_ARTIFACT_ID: '72',
        FIXTURE_ARCHIVES: JSON.stringify({ 72: outputs().reports }),
    });
    assert.equal(published.status, 0, published.stderr);
    const [original, named, ...duplicates] = read('published').trim().split('\n').map(JSON.parse);
    assert.deepEqual(duplicates, []);
    assert.equal(original.commit_id, headSha);
    assert.doesNotMatch(original.body, /^<!-- reviewrelay:stream:/);
    assert.equal(named.commit_id, headSha);
    assert.match(named.body, /^<!-- reviewrelay:stream:localization -->\n/);
    assert.doesNotMatch(defaultReference, /^<!-- reviewrelay:stream:/);
    assert.match(JSON.parse(read('reference')).body, /^<!-- reviewrelay:stream:localization -->\n/);
    assert.equal(read('reference-calls'), '11');

    const calls = read('provider-calls');
    assert.equal(calls, 'opencode\npr-agent\nopencode\npr-agent\n');
    for (const stream of [{ GITHUB_RUN_ID: '902' }, env]) {
        const skipped = run('analyze', stream);
        assert.equal(skipped.status, 0, skipped.stderr);
        assert.equal(outputs().skipped, 'true');
    }
    assert.equal(read('provider-calls'), calls);
});

await test('descendant analysis falls back for expired, incompatible or unrelated history', (t) => {
    const { fixture, run, read, write, git, request, manifest, baseSha, previous } =
        archivedAnalysis(t);
    write('app.txt', 'Product change\nFollow-up change\n');
    git('commit', '-qam', 'Follow-up');
    const advanced = git('rev-parse', 'HEAD');
    const cases = [
        {
            FIXTURE_ARTIFACT_PAGES: JSON.stringify([
                { artifacts: [{ id: 70, name: 'reviewrelay-analyze-42-1', expired: true }] },
            ]),
        },
        { FIXTURE_ZIP_GONE: '1' },
        { PR_REVIEW_EXCLUDE_GLOBS: '["app.*"]' },
    ];
    git('checkout', '--detach', baseSha);
    write('app.txt', 'Unrelated change\n');
    mkdirSync(join(fixture, '.missions/one/evidence'), { recursive: true });
    write('.missions/one/evidence/archive.patch', 'Supporting evidence\n');
    git('add', 'app.txt', '.missions/one/evidence/archive.patch');
    git('commit', '-qm', 'Unrelated change');
    const unrelated = git('rev-parse', 'HEAD');
    for (const env of [...cases.map((setting) => request(advanced, setting)), request(unrelated)]) {
        const result = run('analyze', env);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(manifest().checkpoint, null);
        assert.match(result.stdout, /usable history and coverage/);
        assert.ok(!JSON.parse(read('opencode-arguments')).includes('--session'));
    }

    const path = join(previous, 'manifest.json');
    const incompatible = JSON.parse(readFileSync(path, 'utf8'));
    incompatible.compatibility.engine = '1'.repeat(64);
    writeFileSync(path, JSON.stringify(incompatible));
    const changedEngine = run('analyze', request(advanced));
    assert.equal(changedEngine.status, 0, changedEngine.stderr);
    assert.equal(manifest().checkpoint, null);
    assert.match(changedEngine.stdout, /usable history and coverage/);
    assert.ok(!JSON.parse(read('opencode-arguments')).includes('--session'));
});

await test('same-head analysis requires identical scope and leaves stale work archived', (t) => {
    const { run, outputs, read, request, manifest, previous, baseSha, expectedPull } =
        archivedAnalysis(t);
    const next = request();
    const stale = run('synthesize', {
        ...next,
        OPENCODE_REPORT_DIR: previous,
        FIXTURE_PULL: JSON.stringify({
            ...expectedPull,
            head: { ...expectedPull.head, sha: baseSha },
        }),
    });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /PR revision or eligibility changed/);
    assert.equal(read('provider-calls'), 'opencode\n');
    const changedScope = run('analyze', {
        ...next,
        FIXTURE_NATIVE_SCOPE: JSON.stringify({
            incremental: false,
            start: baseSha,
            first: null,
            paths: ['app.txt'],
        }),
    });
    assert.equal(changedScope.status, 0, changedScope.stderr);
    assert.equal(manifest().reusedAnalysis, null);
    assert.notEqual(outputs().reports, previous);
    assert.equal(read('provider-calls'), 'opencode\nopencode\n');
});

await test('descendant analysis breaks equal and incomparable checkpoint ties by artifact ID', (t) => {
    const { run, outputs, write, git, request, manifest, headSha } = archivedAnalysis(t);
    const independentArchive = (runId, attempt) => {
        const result = run(
            'analyze',
            request(git('rev-parse', 'HEAD'), {
                GITHUB_RUN_ID: runId,
                GITHUB_RUN_ATTEMPT: attempt,
                FIXTURE_RUNS: '{"workflow_runs":[]}',
            }),
        );
        assert.equal(result.status, 0, result.stderr);
        return outputs().reports;
    };
    write('app.txt', 'Product change\nLeft branch change\n');
    git('commit', '-qam', 'Left branch');
    const left = git('rev-parse', 'HEAD');
    const firstAttempt = independentArchive('901', '1');
    const secondAttempt = independentArchive('901', '2');

    git('checkout', '--detach', headSha);
    write('right.txt', 'Right branch change\n');
    git('add', 'right.txt');
    git('commit', '-qm', 'Right branch');
    const right = git('rev-parse', 'HEAD');
    const rightArchive = independentArchive('902', '1');
    git('merge', '--no-edit', left);
    const merged = git('rev-parse', 'HEAD');
    const candidate = {
        GITHUB_RUN_ID: '903',
        FIXTURE_ARCHIVES: JSON.stringify({
            99: firstAttempt,
            100: secondAttempt,
            101: rightArchive,
        }),
        FIXTURE_RUNS: JSON.stringify({ workflow_runs: [{ id: 901 }, { id: 902 }] }),
    };
    const runAnalysis = (rightArtifacts) =>
        run(
            'analyze',
            request(merged, {
                ...candidate,
                FIXTURE_RUN_ARTIFACTS: JSON.stringify({ 901: [100, 99], 902: rightArtifacts }),
            }),
        );
    const equal = runAnalysis([]);
    assert.equal(equal.status, 0, equal.stderr);
    assert.deepEqual(manifest().checkpoint, {
        head: left,
        runId: '901',
        attempt: '2',
        artifactId: '100',
    });
    const incomparable = runAnalysis([101]);
    assert.equal(incomparable.status, 0, incomparable.stderr);
    assert.deepEqual(manifest().checkpoint, {
        head: right,
        runId: '902',
        attempt: '1',
        artifactId: '101',
    });
});
