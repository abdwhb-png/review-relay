import { createHash } from 'node:crypto';
import {
    closeSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { api } from './github-actions.mjs';
import { credentialName, nativeValue } from './configuration.mjs';

export const artifactSchemaVersion = 4;

export const runtime = JSON.parse(
    readFileSync(new URL('../runtime.json', import.meta.url), 'utf8'),
);
const payloads = {
    analysis: ['opencode-report.md', 'opencode-session.json'],
    synthesis: ['pr-agent-review.json', 'pr-agent-review.md', 'publication.json'],
    suggestions: ['suggestions.json'],
};

export function digest(content) {
    return createHash('sha256').update(content).digest('hex');
}

export function validAnalysisSource(source) {
    return (
        typeof source?.head === 'string' &&
        /^[0-9a-f]{40}$/.test(source.head) &&
        [source.runId, source.attempt, source.artifactId].every(
            (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value),
        )
    );
}

export function publicationMarker(directory) {
    return `<!-- reviewrelay:${digest(readFileSync(join(directory, 'manifest.json')))} -->`;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
        );
    return value;
}

export function configurationDigest(config) {
    const {
        files: _files,
        instructionPaths: _instructionPaths,
        instructionPatterns: _instructionPatterns,
        providerEnv,
        ...orchestration
    } = config;
    function withoutCredentials(value, key) {
        value = nativeValue(value, key);
        if (Array.isArray(value)) return value.map(withoutCredentials);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                credentialName(key) ? '<credential>' : withoutCredentials(item, key),
            ]),
        );
    }
    const native = withoutCredentials(providerEnv);
    return digest(
        JSON.stringify(
            canonical({ orchestration, native, globs: process.env.PR_REVIEW_EXCLUDE_GLOBS || '' }),
        ),
    );
}

function compatibility() {
    const sources = [
        'pr-review.mjs',
        'review-output.mjs',
        'configuration.mjs',
        'artifacts.mjs',
        'pr-agent-native.py',
        'action.mjs',
        '../runtime.json',
        '../profiles/primary.toml',
        '../profiles/fallback.toml',
        '../profiles/primary.json',
        '../profiles/fallback.json',
    ];
    return {
        version: runtime.version,
        engine: digest(
            sources.map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\0'),
        ),
        opencode: runtime.opencode.version,
        prAgent: runtime.prAgent.image,
    };
}

export function archiveIdentity(config) {
    const env = process.env;
    return {
        repository: env.GITHUB_REPOSITORY,
        reviewId: config.reviewId,
        number: Number(env.PR_NUMBER),
        base: env.BASE_SHA,
        head: env.HEAD_SHA,
        configurationSha256:
            process.env.REVIEW_OPERATION === 'publish'
                ? process.env.REVIEW_EXPECTED_CONFIG || configurationDigest(config)
                : configurationDigest(config),
        compatibility: compatibility(),
    };
}

export function writeManifest(directory, kind, config, metadata = {}) {
    if (!Object.hasOwn(payloads, kind)) throw new Error('Unknown artifact kind.');
    const names = payloads[kind];
    const files = Object.fromEntries(
        names.map((name) => [name, digest(readFileSync(join(directory, name)))]),
    );
    const env = process.env;
    const manifest = {
        schemaVersion: artifactSchemaVersion,
        kind,
        ...archiveIdentity(config),
        producer: {
            runId: env.GITHUB_RUN_ID,
            attempt: env.GITHUB_RUN_ATTEMPT,
            workflowRef: env.GITHUB_WORKFLOW_REF,
            workflowSha: env.GITHUB_WORKFLOW_SHA,
        },
        files,
        ...metadata,
    };
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

export function matchesArchiveIdentity(manifest, kind, config, { previousHead } = {}) {
    const expected = archiveIdentity(config);
    if (previousHead) expected.head = previousHead;
    return (
        manifest?.schemaVersion === artifactSchemaVersion &&
        manifest.kind === kind &&
        Object.entries(expected).every(
            ([key, value]) =>
                JSON.stringify(canonical(manifest[key])) === JSON.stringify(canonical(value)),
        )
    );
}

export function readManifest(directory, kind, config, revision) {
    const path = join(directory, 'manifest.json');
    if (!lstatSync(path).isFile()) throw new Error('Manifest must be a regular file.');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!matchesArchiveIdentity(manifest, kind, config, revision))
        throw new Error('Artifact revision, configuration, or engine compatibility mismatch.');
    if (!Object.hasOwn(payloads, kind)) throw new Error('Unknown artifact kind.');
    const names = payloads[kind];
    if (
        !manifest.files ||
        JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(names.toSorted()) ||
        JSON.stringify(readdirSync(directory).sort()) !==
            JSON.stringify([...names, 'manifest.json'].sort())
    )
        throw new Error('Unexpected artifact payload.');
    for (const name of names) {
        const file = join(directory, name);
        if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== manifest.files[name])
            throw new Error('Artifact payload checksum mismatch.');
    }
    return manifest;
}

export function workflowPath() {
    const { GITHUB_REPOSITORY: repository, GITHUB_WORKFLOW_REF: ref } = process.env;
    const prefix = `${repository}/`;
    if (!ref?.startsWith(prefix) || !ref.includes('@refs/heads/'))
        throw new Error('Missing trusted caller workflow identity.');
    const path = ref.slice(prefix.length).split('@')[0];
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
        throw new Error('Invalid caller workflow path.');
    return path;
}

export function downloadArtifact(id, work, metadata) {
    if (!/^[1-9][0-9]*$/.test(String(id))) throw new Error('Invalid artifact ID.');
    const env = process.env;
    const endpoint = `repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${id}`;
    const artifact = metadata ? metadata.artifact : api(endpoint);
    const run = metadata
        ? metadata.run
        : api(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${artifact.workflow_run?.id}`);
    if (
        !artifact ||
        !run ||
        String(artifact.id) !== String(id) ||
        !Number.isSafeInteger(run.id) ||
        run.id !== artifact.workflow_run?.id ||
        artifact.expired ||
        !['pull_request_target', 'issue_comment', 'workflow_dispatch'].includes(run.event) ||
        run.path?.split('@')[0] !== workflowPath() ||
        (run.event !== 'pull_request_target' &&
            run.head_branch !== env.GITHUB_WORKFLOW_REF.split('@refs/heads/')[1]) ||
        run.repository?.full_name !== env.GITHUB_REPOSITORY ||
        run.head_repository?.full_name !== env.GITHUB_REPOSITORY
    )
        throw new Error('Artifact was not produced by the trusted consumer workflow.');
    const directory = mkdtempSync(join(work, 'artifact-'));
    const zipPath = `${directory}.zip`;
    const file = openSync(zipPath, 'wx', 0o600);
    let result;
    try {
        result = spawnSync('gh', ['api', `${endpoint}/zip`], { stdio: ['ignore', file, 'pipe'] });
    } finally {
        closeSync(file);
    }
    if (result.status !== 0) {
        if (metadata && /\(HTTP (404|410)\)/.test(result.stderr?.toString() ?? '')) return null;
        throw new Error('Cannot download the identified artifact.');
    }
    const script = `import json, pathlib, stat, sys, zipfile
allowed = set(json.loads(sys.argv[3]))
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)) or any(name not in allowed for name in names):
        raise ValueError('Unexpected artifact archive entries')
    for entry in archive.infolist():
        if stat.S_ISLNK(entry.external_attr >> 16) or entry.is_dir():
            raise ValueError('Artifact entries must be regular files')
        (pathlib.Path(sys.argv[2]) / entry.filename).write_bytes(archive.read(entry))
`;
    const extracted = spawnSync('python3', [
        '-c',
        script,
        zipPath,
        directory,
        JSON.stringify(['manifest.json', ...new Set(Object.values(payloads).flat())]),
    ]);
    if (extracted.status !== 0) throw new Error('Invalid artifact archive.');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const producer = manifest.producer;
    const trustedAutomaticSource =
        run.event === 'pull_request_target' &&
        /^[a-f0-9]{40}$/.test(producer?.workflowSha || '') &&
        (String(run.id) === env.GITHUB_RUN_ID
            ? producer.workflowSha === env.GITHUB_WORKFLOW_SHA
            : spawnSync(
                  'git',
                  ['merge-base', '--is-ancestor', producer.workflowSha, env.GITHUB_WORKFLOW_SHA],
                  { stdio: 'ignore' },
              ).status === 0);
    const sourceMatches =
        run.event === 'pull_request_target'
            ? manifest.head === run.head_sha && trustedAutomaticSource
            : producer?.workflowSha === run.head_sha;
    if (
        String(producer?.runId) !== String(run.id) ||
        !sourceMatches ||
        producer.workflowRef !== env.GITHUB_WORKFLOW_REF
    )
        throw new Error('Artifact manifest does not match GitHub producer metadata.');
    return directory;
}
