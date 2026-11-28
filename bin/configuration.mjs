import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
import { readFileSync } from 'node:fs';

const defaults = {
    schemaVersion: 1,
    reviewId: null,
    prAgentConfigPath: '.pr_agent.toml',
    autoReview: false,
    analysisResumeMode: 'delta',
    includeAnalysisReport: true,
    includePipelineDetails: true,
    manualFallback: false,
    manualDraftReview: false,
    baseBranches: null,
    excludeGlobs: [],
    retentionDays: 0,
    instructionSources: [],
};

export function commentCommands(env = process.env) {
    const values = [env.REVIEW_REVIEW_COMMANDS || '', env.REVIEW_IMPROVE_COMMANDS || ''];
    const custom = values.some((value) => value !== '');
    const commands = new Map();
    for (const [index, operation] of ['review', 'improve'].entries()) {
        let names;
        try {
            names = custom ? JSON.parse(values[index] || '[]') : [`/${operation}`];
        } catch {
            throw new Error(`Invalid ${operation}-commands: expected a JSON array.`);
        }
        if (!Array.isArray(names))
            throw new Error(`Invalid ${operation}-commands: expected a JSON array.`);
        for (const name of names) {
            if (typeof name !== 'string' || !/^\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
                throw new Error(
                    `Invalid ${operation}-commands: expected slash command names without arguments.`,
                );
            if (commands.has(name))
                throw new Error(`Duplicate command in caller command lists: ${name}`);
            commands.set(name, operation);
        }
    }
    return commands;
}

export function reviewIdentity(reviewId, env = process.env) {
    if (
        reviewId !== null &&
        (typeof reviewId !== 'string' ||
            reviewId.length > 64 ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewId))
    )
        throw new Error(
            'Invalid reviewId; use a lowercase kebab-case identifier of 1–64 characters.',
        );
    const suffix = reviewId === null ? '' : `-${reviewId}`;
    const root = `reviewrelay-${env.GITHUB_REPOSITORY}-${env.PR_NUMBER}`;
    return {
        checkName: `ReviewRelay PR review${reviewId === null ? '' : ` (${reviewId})`}`,
        externalId: `reviewrelay-${env.GITHUB_RUN_ID}${suffix}`,
        concurrencyGroup: root + suffix,
        sessionHeader: `x-opencode-session: ${root}${suffix}`,
        marker: reviewId === null ? '' : `<!-- reviewrelay:stream:${reviewId} -->`,
        artifactName: (operation) =>
            `reviewrelay-${operation}-${env.PR_NUMBER}${suffix}-${env.GITHUB_RUN_ATTEMPT}`,
        analysisArtifactPattern: new RegExp(
            `^reviewrelay-analyze-${env.PR_NUMBER}${suffix}-[1-9][0-9]*$`,
        ),
    };
}

export function openCodeDefaults(provider = 'primary') {
    if (!['primary', 'fallback'].includes(provider)) throw new Error('Unknown native profile.');
    const primary = JSON.parse(
        readFileSync(new URL('../profiles/primary.json', import.meta.url), 'utf8'),
    );
    return provider === 'primary'
        ? primary
        : {
              ...primary,
              ...JSON.parse(
                  readFileSync(new URL('../profiles/fallback.json', import.meta.url), 'utf8'),
              ),
          };
}

export function credentialName(key) {
    return (
        /(?:^|[_-])(?:key|access_key_id|token|secret|password|authorization|credentials|auth)$/i.test(
            key,
        ) || /^(?:apiKey|accessToken|authToken|clientSecret)$/i.test(key)
    );
}

export function nativeValue(value, key) {
    if (typeof value !== 'string') return value;
    if (key === 'OPENAI_CUSTOM_HEADERS')
        return Object.fromEntries(
            value
                .split('\n')
                .filter((line) => line.includes(':'))
                .map((line) => {
                    const separator = line.indexOf(':');
                    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
                }),
        );
    if (/^[[{]/.test(value.trim())) {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    return value;
}

export function repositoryPath(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        !value.startsWith('/') &&
        !value.split('/').some((part) => !part || part === '..' || part === '.') &&
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

export function composeProviderEnv(providerEnv, env = process.env) {
    const analysisModel = env.REVIEWRELAY_ANALYSIS_MODEL || 'deepseek-v4.1-flash';
    const analysisEffort = env.REVIEWRELAY_ANALYSIS_EFFORT || 'high';
    const synthesisEffort = env.REVIEWRELAY_SYNTHESIS_EFFORT || 'high';
    const fallbackModel =
        env.REVIEWRELAY_OPENROUTER_FALLBACK_MODEL || 'deepseek/deepseek-v4.1-flash-1017';
    const defaults = {
        opencode: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
                model: `opencode-go/${analysisModel}`,
                provider: {
                    'opencode-go': {
                        models: {
                            [analysisModel]: { options: { reasoningEffort: analysisEffort } },
                        },
                    },
                },
            }),
        },
        'pr-agent': { CONFIG__REASONING_EFFORT: synthesisEffort },
        fallback: {
            opencode: {
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    model: `openrouter/${fallbackModel}`,
                    provider: {
                        openrouter: {
                            models: {
                                [fallbackModel]: {
                                    options: { reasoning: { effort: analysisEffort } },
                                },
                            },
                        },
                    },
                }),
            },
            'pr-agent': { CONFIG__MODEL: `openrouter/${fallbackModel}` },
        },
    };
    const engines = JSON.parse(providerEnv || '{}');
    for (const [engine, engineDefaults] of Object.entries(defaults)) {
        if (engine === 'fallback') {
            engines.fallback ??= {};
            for (const [fallbackEngine, fallbackDefaults] of Object.entries(engineDefaults)) {
                engines.fallback[fallbackEngine] = mergeNativeVariables(
                    fallbackDefaults,
                    engines.fallback[fallbackEngine],
                );
            }
        } else {
            engines[engine] = mergeNativeVariables(engineDefaults, engines[engine]);
        }
    }
    return JSON.stringify(engines);
}

function mergeNativeVariables(defaults, overrides) {
    const result = { ...defaults };
    for (const [key, value] of Object.entries(overrides ?? {})) {
        result[key] =
            key === 'OPENCODE_CONFIG_CONTENT'
                ? JSON.stringify(mergeConfig(JSON.parse(defaults[key]), JSON.parse(value)))
                : value;
    }
    return result;
}

function mergeConfig(base, overlay) {
    if (!base || typeof base !== 'object' || Array.isArray(base)) return overlay;
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) result[key] = mergeConfig(base[key], value);
    return result;
}

export function loadConfiguration(env = process.env) {
    const providerEnv = nativeEnvironment(composeProviderEnv(env.REVIEW_PROVIDER_ENV, env));
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
    if (env.REVIEWRELAY_FALLBACK_ENABLED === 'true' || env.REVIEWRELAY_FALLBACK_ENABLED === 'false')
        config.manualFallback = env.REVIEWRELAY_FALLBACK_ENABLED === 'true';
    if (
        Object.keys(config).some((key) => !Object.hasOwn(defaults, key)) ||
        config.schemaVersion !== 1 ||
        !['delta', 'full'].includes(config.analysisResumeMode) ||
        typeof config.autoReview !== 'boolean' ||
        typeof config.includeAnalysisReport !== 'boolean' ||
        typeof config.includePipelineDetails !== 'boolean' ||
        typeof config.manualFallback !== 'boolean' ||
        typeof config.manualDraftReview !== 'boolean' ||
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
    reviewIdentity(config.reviewId, env);
    if (!repositoryPath(config.prAgentConfigPath)) throw new Error('Invalid prAgentConfigPath.');
    if (config.prAgentConfigPath !== '.pr_agent.toml' && !files.has(config.prAgentConfigPath))
        throw new Error('Selected native repository settings are missing at the trusted revision.');
    const instructionPaths = [...files.keys()].filter((name) =>
        config.instructionSources.some((glob) => matchesGlob(name, glob)),
    );
    const nativeToml = [...files.keys()].filter(
        (name) => name === config.prAgentConfigPath || name.endsWith('/.pr_agent.toml'),
    );
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
                /^DOCKER_(?:HOST|CONTEXT|CONFIG|TLS|TLS_VERIFY|CERT_PATH|API_VERSION|AUTH_CONFIG|CUSTOM_HEADERS|CLI_[A-Z0-9_]+|DEFAULT_PLATFORM|CONTENT_TRUST(?:_SERVER)?)$/.test(
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
