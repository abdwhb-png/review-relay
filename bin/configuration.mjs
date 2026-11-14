import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

const defaults = {
    schemaVersion: 1,
    autoReview: false,
    manualFallback: false,
    baseBranches: null,
    excludeGlobs: [],
    retentionDays: 0,
    instructionSources: [],
};

export function credentialName(key) {
    return (
        /(?:^|_)(?:key|access_key_id|token|secret|password|authorization|credentials|auth)$/i.test(
            key,
        ) || /^(?:apiKey|accessToken|authToken|clientSecret)$/i.test(key)
    );
}

export function repositoryPath(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        !value.startsWith('/') &&
        !value.split('/').some((part) => part === '..' || part === '.') &&
        !/[\0\r\n\\]/.test(value)
    );
}

export function trustedFiles(ref) {
    if (!ref) return new Map();
    if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('Invalid trusted configuration revision.');
    const result = spawnSync('git', ['ls-tree', '-rz', ref], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot read trusted configuration revision.');
    return new Map(
        result.stdout
            .split('\0')
            .filter(Boolean)
            .flatMap((entry) => {
                const [metadata, ...name] = entry.split('\t');
                return /^100[67]/.test(metadata) ? [[name.join('\t'), metadata.split(' ')[2]]] : [];
            }),
    );
}

export function readTrusted(ref, path) {
    if (!repositoryPath(path)) throw new Error('Invalid repository-relative configuration path.');
    const result = spawnSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot read trusted file: ${path}`);
    return result.stdout;
}

export function validateNativeToml(content, ref, name) {
    const script = `import json,sys,tomllib
model=None
for section, values in tomllib.loads(sys.stdin.read()).items():
    if section.lower() != 'config': continue
    config={key.lower(): value for key,value in values.items()}
    assert config.get('publish_output', False) is False, 'publication is isolated'
    assert not config.get('fallback_models', []), 'fallback is coordinated'
    assert not config.get('global_settings_repo', ''), 'settings must use frozen local sources'
    assert config.get('repo_context_from_default_branch', False) is False, 'context must use frozen base'
    assert config.get('config_branch', sys.argv[1]) == sys.argv[1], 'configuration must use frozen base'
    model=config.get('model', model)
print(json.dumps(model))
`;
    const checked = spawnSync('python3', ['-c', script, ref], { input: content, encoding: 'utf8' });
    if (checked.status !== 0)
        throw new Error(
            `Invalid or incompatible native TOML configuration: ${name}. ReviewRelay requires frozen base context and isolated publication.`,
        );
    return JSON.parse(checked.stdout);
}

export function loadConfiguration(env = process.env) {
    const providerEnv = nativeEnvironment(env.REVIEW_PROVIDER_ENV);
    const ref = env.BASE_SHA || env.GITHUB_WORKFLOW_SHA;
    const files = trustedFiles(ref);
    const path = env.REVIEW_CONFIG_PATH || '.reviewrelay.json';
    if (!repositoryPath(path)) throw new Error('Invalid config-path.');
    if (env.REVIEW_CONFIG_PATH && path !== '.reviewrelay.json' && !files.has(path))
        throw new Error('Configured file is missing at the trusted revision.');
    let config;
    try {
        const project = files.has(path) ? JSON.parse(readTrusted(ref, path)) : {};
        const overrides = JSON.parse(env.REVIEW_OVERRIDES || '{}');
        for (const layer of [project, overrides]) {
            if (!layer || Array.isArray(layer) || typeof layer !== 'object')
                throw new Error('Expected an object.');
        }
        config = { ...defaults, ...project, ...overrides };
    } catch {
        throw new Error('Invalid ReviewRelay JSON configuration.');
    }
    if (
        Object.keys(config).some((key) => !Object.hasOwn(defaults, key)) ||
        config.schemaVersion !== 1 ||
        typeof config.autoReview !== 'boolean' ||
        typeof config.manualFallback !== 'boolean' ||
        !Number.isSafeInteger(config.retentionDays) ||
        config.retentionDays < 0 ||
        (config.baseBranches !== null &&
            (!Array.isArray(config.baseBranches) ||
                !config.baseBranches.length ||
                config.baseBranches.some(
                    (branch) =>
                        typeof branch !== 'string' || !branch.trim() || /[\0\r\n]/.test(branch),
                ))) ||
        !Array.isArray(config.instructionSources) ||
        config.instructionSources.some((source) => !repositoryPath(source)) ||
        !Array.isArray(config.excludeGlobs) ||
        config.excludeGlobs.some((glob) => typeof glob !== 'string')
    )
        throw new Error('Invalid ReviewRelay configuration settings.');
    const instructionPaths = [...files.keys()].filter((name) =>
        config.instructionSources.some((glob) => matchesGlob(name, glob)),
    );
    const nativeToml = [...files.keys()].filter((name) => /(^|\/)\.pr_agent\.toml$/.test(name));
    for (const name of nativeToml) {
        validateNativeToml(readTrusted(ref, name), ref, name);
    }
    for (const source of config.instructionSources) {
        if (!instructionPaths.some((name) => matchesGlob(name, source)))
            throw new Error(`Instruction source matched no trusted file: ${source}`);
    }
    if (instructionPaths.some((path) => /(^|\/)\.env(?:$|\.(?!example$)[^/]+)/i.test(path)))
        throw new Error('Private environment files cannot be instruction sources.');
    return {
        ...config,
        baseBranches: config.baseBranches ?? [env.REVIEW_DEFAULT_BRANCH || 'main'],
        instructionPaths: instructionPaths.sort(),
        instructionPatterns: [...config.instructionSources],
        files,
        ref,
        path,
        providerEnv,
    };
}

function nativeEnvironment(value, allowFallback = true) {
    let engines;
    try {
        engines = JSON.parse(value || '{}');
    } catch {
        throw new Error('Invalid provider-env JSON.');
    }
    if (
        !engines ||
        Array.isArray(engines) ||
        typeof engines !== 'object' ||
        Object.keys(engines).some(
            (key) =>
                !['opencode', 'pr-agent', ...(allowFallback ? ['fallback'] : [])].includes(key),
        )
    )
        throw new Error('provider-env must contain opencode and/or pr-agent objects.');
    if (Object.hasOwn(engines, 'fallback'))
        engines.fallback = nativeEnvironment(JSON.stringify(engines.fallback), false);
    for (const [engine, variables] of Object.entries(engines)) {
        if (engine === 'fallback') continue;
        if (!variables || Array.isArray(variables) || typeof variables !== 'object')
            throw new Error('Native environment must be an object.');
        for (const [key, text] of Object.entries(variables)) {
            if (
                typeof text !== 'string' ||
                text.includes('\0') ||
                !/^[A-Z][A-Z0-9_]*$/.test(key) ||
                /^(?:PATH$|HOME$|ENV$|BASH|SHELL|SHELLOPTS|IFS$|CDPATH$|ZDOTDIR$|LD_|DYLD_|NODE_|BUN_|PYTHON|GIT_|GH_|GITHUB_|RUNNER_|XDG_|REVIEW_|TOOL_)/.test(
                    key,
                ) ||
                /^(?:PR_AGENT_CONFIG_BRANCH|CONFIG__(?:PUBLISH_OUTPUT|CONFIG_BRANCH|CLI_MODE|FALLBACK_MODELS|PROPAGATE_TOOL_ERRORS|REPO_CONTEXT_FROM_DEFAULT_BRANCH|GLOBAL_SETTINGS_REPO))$/.test(
                    key,
                )
            )
                throw new Error(`Reserved or invalid native environment variable: ${key}`);
        }
    }
    return engines;
}
