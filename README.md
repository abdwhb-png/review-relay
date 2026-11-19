# ReviewRelay

ReviewRelay coordinates OpenCode analysis, native PR-Agent synthesis, and isolated GitHub publication. Use the supplied reusable workflow for the complete lifecycle or compose the same action's operations in your own workflow.

**Version 1.1.1:** published reviews retain native PR-Agent run details and configured footers, qualified through both hosted interfaces. See [qualification](docs/qualification.md) for the evidence and boundaries.

## Agent skill

Copy [skills/review-relay](skills/review-relay/SKILL.md) into your agent's project skill directory, for example `.agents/skills/review-relay/` when supported. Reload skills or start a new session as required by your agent, then invoke `review-relay` to configure and operate the project's GitHub Actions integration. The skill covers adoption, native configuration, review commands, recovery and upgrades using the selected ReviewRelay version's documentation.

## Adopt the complete workflow

Copy [the caller workflow](examples/workflow.yml), replace `REVIEWRELAY_SHA` with the reviewed ReviewRelay commit, and configure your provider credentials as Actions secrets. The caller needs `contents: read`, `actions: read`, `checks: write`, and `pull-requests: write`; the supplied workflow narrows permissions for each job. Enable access to this public action and reusable workflow in the consumer's Actions policy.

The workflow accepts standalone `/review` and `/improve` comments from users with current write, maintain, or admin permission, and manual dispatch with a `pull_request` input from the default branch. Automatic review is off by default. Pull requests must be open, internal to the consumer repository, and target its default branch or an explicitly configured target. They must be ready by default; the orchestration settings below can explicitly permit manual draft reviews. Fork review is outside v1.

The workflow calls `$/action`, so its action and engine resolve to the same commit as the reusable workflow. Consumers declare one version. GitHub.com and Linux x64 runners with Node.js 24+, Python 3.11+, Git, Docker, curl, and tar are required. GitHub Enterprise Server is outside v1. The supplied workflow prepares Node.js; the action delivers its scripts and checksum/digest-pinned runtimes.

## Configure orchestration

`.reviewrelay.json` is optional. A custom `config-path` must exist at the trusted base revision. All fields below are optional; unknown fields and invalid types fail before inference.

| Field                | Default                   | Meaning                                                                                                                                               |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewId`           | `null`                    | Stable named stream identifier; null preserves the historical stream.                                                                                 |
| `prAgentConfigPath`  | `.pr_agent.toml`          | Trusted native repository TOML replacing the root layer.                                                                                              |
| `schemaVersion`      | `1`                       | Configuration contract version.                                                                                                                       |
| `autoReview`         | `false`                   | Review opened, reopened, ready, and synchronized eligible PRs.                                                                                        |
| `manualFallback`     | `false`                   | Permit the fallback route only on authorized manual requests after a classified provider failure.                                                     |
| `manualDraftReview`  | `false`                   | Permit draft PRs for authorized `/review`, `/improve` and manual dispatch. Automatic requests still reject drafts.                                    |
| `baseBranches`       | Repository default branch | Nonempty list of permitted target branch names.                                                                                                       |
| `excludeGlobs`       | `[]`                      | Repository-relative Git globs excluded from the primary diff. `!` rules keep matches regardless of order. Excluded source remains supporting context. |
| `retentionDays`      | `0`                       | Artifact retention; zero uses the consumer repository policy. GitHub enforces its retention bounds.                                                   |
| `instructionSources` | `[]`                      | Repository-relative files or globs to supply as trusted instructions. Each configured source must match a regular tracked file.                       |

Orchestration precedence is defaults, then the file at the frozen base, then the caller's `overrides` JSON object. Source selection is explicit: for example, `"instructionSources": ["CLAUDE.md", "policy/**/*.md"]`. Shared sources are supplied through native instruction/context settings without duplicate text injection; native engine-specific sources retain their own scope. No instruction filename or per-project skill inventory is required. Standard native discovery remains available; ReviewRelay does not assume automatic `CLAUDE.md` discovery in the pinned OpenCode runtime. Native OpenCode instruction globs also select trusted base files, including protection against new head files matching those globs.

For manual reviews of a stacked draft PR, enable `manualDraftReview` and list its permitted target branches in `baseBranches`, for example `{"manualDraftReview": true, "baseBranches": ["main", "stack/profile"]}`. This does not enable automatic reviews or infer allowed bases from the PR. Rights, repository identity and frozen revisions are checked again before generation and publication. New settings must be introduced together with a ReviewRelay version that supports them; older versions reject unknown settings.

## Independent review streams

For multiple reviews on one PR, give each additional stream a stable `reviewId` in its trusted orchestration file. Reuse that ID across PRs; omitting it preserves the historical default stream. IDs use lowercase letters and digits with single separating hyphens, up to 64 characters. Different streams have independent native review history, checks, concurrency, artifacts and session continuation.

Select a separate repository TOML with `prAgentConfigPath` (default `.pr_agent.toml`). This replaces the repository root layer while preserving native host defaults, environment overrides and applicable per-directory settings. A custom file must exist at the frozen base. For an example, adapt [the localization configuration](examples/reviewrelay.localization.json) and provide its trusted instructions and TOML.

[The matrix caller](examples/multi-stream.yml) runs a complete workflow per stream in one run with `fail-fast: false`. Route automatic events and manual commands in the caller; a matrix's single output does not collect all publication URLs. Custom composed callers must pass each stream's own opaque request and artifact IDs, and use its authorization output `concurrency-group` for job concurrency. Generation and publication remain separate permission boundaries.

All participating callers must use the lane-capable version. Opaque requests and manifests now use format 2; configuration remains schema 1. Incompatible old artifacts are rejected or cause the documented fresh-context fallback during history discovery. Existing unscoped native review references remain recognized. Completed analysis can be reused even when another stream leaves the producer run globally failed.

## Configure the native engines

Keep OpenCode JSON/JSONC and PR-Agent TOML in their native formats. The bundled profiles preserve the initial Go / DeepSeek V4.1 Flash / high behavior, including its existing timeout and token settings, as overridable defaults. Models, endpoints, effort, budgets, instructions, presentation, and supported provider credentials remain native settings. ReviewRelay has no renamed model or budget catalog. Native PR-Agent presentation settings, including `config.output_run_details`, are preserved from its complete dry-run Markdown through isolated publication.

OpenCode receives the bundled profile as global defaults, the trusted project's configuration and configuration directories, and native inline invocation settings. PR-Agent receives a bundled native host profile, the frozen repository settings, and native environment overrides through its own loader. `PR_AGENT_EXTRA_CONFIG_URL` may select a repository-relative trusted TOML file instead of the bundled host profile; this replaces that host-default layer, after which normal repository settings still apply. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` must also be canonical repository-relative paths. Remote or host instruction sources, moving cross-repository settings repositories, and sibling-repository instruction context are rejected.

The pinned OpenCode 2.2.6 default-model resolver can omit a variant supplied through a global `model#variant` declaration. The bundled profiles and [native project example](examples/opencode.jsonc) therefore use native per-model settings for reasoning levels; tests verify the actual model request parameters. See the [pinned native resolver](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/model-resolver.ts#L524). Model selection remains native and configurable.

Pass credentials and native invocation overrides through the `provider-env` secret. Its `opencode` and `pr-agent` objects map native environment names to string values. An optional `fallback` object has the same two engine objects, isolating fallback credentials and overrides from the primary route. The default fallback profiles use OpenRouter. Runtime/launcher variables, GitHub identity, and publication controls are reserved. OpenAI-compatible transport receives a stable consumer/PR conversation header by default through the native `OPENAI_CUSTOM_HEADERS` setting; callers can replace it using that native environment variable.

```json
{
    "opencode": { "OPENCODE_API_KEY": "<configured Actions secret>" },
    "pr-agent": { "OPENAI__KEY": "<configured Actions secret>" },
    "fallback": {
        "opencode": { "OPENROUTER_API_KEY": "<configured Actions secret>" },
        "pr-agent": { "OPENROUTER__KEY": "<configured Actions secret>" }
    }
}
```

For another primary provider, select its model and connection settings in the native configuration and supply that provider's native credential variables. For invocation overrides, OpenCode accepts `OPENCODE_CONFIG_CONTENT` as a JSON object serialized into a string; PR-Agent accepts its native `SECTION__KEY` environment names. The engines retain their own merge and list semantics. Configuration fingerprints include native noncredential overrides, so changing a token budget invalidates reuse while rotating a credential does not.

ReviewRelay owns the safety constraints: frozen revisions, inspection-only OpenCode permissions, repository context from the frozen base, generation without native publication, explicit failure propagation, and coordinated fallback. Do not enable `config.publish_output`, native `fallback_models`, or `config.repo_context_from_default_branch` in PR-Agent files; conflicting settings fail. When `.pr_agent.toml` is absent at the frozen base, native repository-settings loading is disabled to prevent its fallback to a moving default branch. Include a root `.pr_agent.toml` when opting into native per-directory settings. Executable OpenCode extensions, MCP configuration, and custom SDK package declarations are outside the inspection sandbox; use the pinned runtime's built-in providers and declarative settings.

## Compose operations

[The composed example](examples/composed.yml) demonstrates independent jobs using the same action. Each action prepares a trusted consumer checkout, so place it before steps that depend on a different checkout. Generation jobs must have a read-only repository/PR token; their advisory check permission is separate. The publisher receives no `provider-env` and runs no model. `/improve` archives native suggestions and their effective native suggestion settings, then the publisher uses the pinned native suggestion validator and formatter with inference disabled. Invocation and fallback presentation settings therefore survive the isolated publication stage.

| Operation    | Inputs                                                                              | Outputs                                                       |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `authorize`  | GitHub event, configuration, provider environment                                   | `allowed`, `command`, frozen `request`, `concurrency-group`   |
| `analyze`    | `request`, same configuration and provider environment                              | Analysis `artifact-id`, or `skipped`                          |
| `synthesize` | `request`, analysis `artifact-id`, same configuration and provider environment      | Synthesis `artifact-id`, recovery `state`                     |
| `improve`    | Authorized improve `request`, configuration and provider environment                | Suggestions `artifact-id`                                     |
| `publish`    | `request`, synthesis or suggestions `artifact-id`; no provider environment          | Publication `state`, review `publication-url` when applicable |
| `finish`     | `request`, `results` JSON for analyze/synthesize/improve/publish, skipped and state | Completes the advisory check                                  |

Treat `request` as an opaque value returned by authorization. It is bound to the original event, actor, run, caller workflow, frozen base/head, and configuration fingerprint. Manual permission is checked again before inference and publication. Advanced callers own orchestration, permissions, finalization, and concurrency; copy the example's per-PR serialization.

## Retention, continuation, and recovery

Reports and native session exports stay in consumer Actions artifacts. They can contain source excerpts and complete conversations; artifact visibility follows that repository's GitHub access policy. The public tool repository receives none of this content. Explicit provider credential values are redacted before archival; no general source-code secret scanner is implied.

Operations download artifacts by ID and verify GitHub producer metadata, consumer identity, schema, exact engine/runtime compatibility, effective configuration fingerprint, frozen revision, native scope, reconstructed diff, and payload checksums. Callers never handle OpenCode's internal session storage. Unknown formats and expired, corrupt, incompatible, or wrong-producer artifacts fail explicitly.

Use **Re-run failed jobs** on the same Actions run to reuse a completed analysis after synthesis failure. Changed revisions or analysis configuration require a new request. A new `/review` uses PR-Agent's native incremental boundary and imports a compatible archived native OpenCode session. No new changes invokes no model. Missing, expired, or incompatible history starts a complete review with an explicit summary; corrupt compatible context blocks. Artifacts from the pre-extraction implementation are not imported. Engine compatibility is conservative: changes to the recorded engine sources, native profiles, or runtime pins require fresh context.

Publication verifies the live revision, writes the review on the frozen head, and checks again before adding the native history reference. A concurrent PR update can therefore fail a run after a correctly anchored review already exists. Retries reconcile hidden archive-bound markers before creating another review, reference, or suggestion. Partial publication remains a failure until its missing effects are confirmed; inference is not repeated to repair publication.

## Develop and verify

Production execution has no npm dependencies. Development uses the lockfile with npm, Socket Firewall, disabled lifecycle scripts, and a seven-day release-age gate. Run `sfw npm ci`, `npm test`, and `npm run check`. `npm run format` formats task files with the pinned Oxfmt version.

`REVIEW_OPERATION=validate node bin/install-runtime.mjs` prepares the checksum-pinned actionlint and writes `ACTIONLINT_BIN` to `GITHUB_ENV`. Set it directly when running outside Actions, then run `npm run check:workflows`. The checker resolves `$/action` to the local action only for actionlint 1.7.12's static interface checks; hosted qualification must establish GitHub's self-reference behavior.

`REVIEW_OPERATION=analyze node bin/install-runtime.mjs` prepares the pinned image and CLI and writes `OPENCODE_BIN` to `GITHUB_ENV`. With that variable set, run `npm run test:native`. Native tests use the real pinned binaries, real PR-Agent/PyGithub, finite external HTTP fixtures, and a local model stub. The native tokenizer library prepares and verifies its own cache once; fixtures then run without external network access. These checks establish native instruction delivery, session continuation, rendering, and suggestion publication/replay against the fixtures, not hosted GitHub or live model-provider compatibility.

Release versions belong to `runtime.json`. Publish a stable tag only after [both hosted qualification paths](docs/qualification.md) pass on the frozen candidate. Upgrades to the pinned OpenCode or PR-Agent versions require their own qualification.

## License

ReviewRelay's source is licensed under [Apache-2.0](LICENSE). The separately downloaded OpenCode and PR-Agent distributions retain their upstream licenses.
