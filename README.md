# ReviewRelay

ReviewRelay coordinates OpenCode analysis, native PR-Agent synthesis, and isolated GitHub publication. Use the supplied reusable workflow for the complete lifecycle or compose the same action's operations in your own workflow.

**Version 1.3.1:** reduce redundant runtime preparation, scope probes, artifact metadata reads and fallback snapshot copies. Public interfaces and native profiles are unchanged. See [qualification](docs/qualification.md#version-131) for measured results and their boundaries.

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

Named streams display their `reviewId` in both the review body and its reference comment, while retaining the hidden identities used for native incremental review.

Select a separate repository TOML with `prAgentConfigPath` (default `.pr_agent.toml`). This replaces the repository root layer while preserving native host defaults, environment overrides and applicable per-directory settings. A custom file must exist at the frozen base. For an example, adapt [the localization configuration](examples/reviewrelay.localization.json) and provide its trusted instructions and TOML.

[The matrix caller](examples/multi-stream.yml) runs a complete workflow per stream in one run with `fail-fast: false`. Route automatic events and manual commands in the caller; a matrix's single output does not collect all publication URLs. Custom composed callers must pass each stream's own opaque request and artifact IDs, and use its authorization output `concurrency-group` for job concurrency. Generation and publication remain separate permission boundaries. Each caller must satisfy the [workflow trust boundary](#workflow-trust-boundary).

All participating callers must use the lane-capable version. Opaque requests and manifests now use format 2; configuration remains schema 1. Incompatible old artifacts are rejected or cause the documented fresh-context fallback during history discovery. Existing unscoped native review references remain recognized. Completed analysis can be reused even when another stream leaves the producer run globally failed.

## Caller-specific comment commands

The reusable workflow and action accept `review-commands` and `improve-commands` as JSON arrays of literal comment commands. Each list starts that caller's own review or suggestion lifecycle with its selected configuration and `reviewId`.

```yaml
with:
    config-path: .reviewrelay.localization.json
    review-commands: '["/review-localization", "/review-fr"]'
    improve-commands: '["/improve-localization"]'
```

Omitting both inputs preserves `/review` and `/improve`. Setting either input replaces the complete comment-command policy: an omitted or empty list disables that operation's comment commands. `[]` is an explicit empty list; an empty input means omitted. Automatic events and manual dispatch remain independent of these lists.

Names must match `/[A-Za-z0-9][A-Za-z0-9_-]*` as a complete command. Matching is case-sensitive and permits trailing whitespace, including a final line break, but no arguments or additional text. Invalid JSON, non-string entries, malformed names and duplicate names within or across lists fail before inference or publication. Unknown commands receive no acknowledgement and start no model.

Pass the same trusted lists to every composed operation. Each operation revalidates the original GitHub event against those lists; changing the selected command's routing or forging the request is rejected. Define the lists from trusted caller configuration, never from PR content or the comment itself. The [composed example](examples/composed.yml) uses scalar YAML anchors to declare each list once; the [matrix example](examples/multi-stream.yml) gives each stream its own lists.

With custom lists the supplied workflow prefilters slash-prefixed comments, then validates exact commands in `authorize`. An unknown slash command can therefore start an authorization job without analysis or publication. The caller can add a narrower event filter. The composed example uses this coarse prefilter too. With default inputs the supplied workflow retains its historical `/review` and `/improve` prefilter.

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

ReviewRelay owns the safety constraints: frozen revisions, inspection-only OpenCode permissions, repository context from the frozen base, generation without native publication, explicit failure propagation, and coordinated fallback. Do not enable `config.publish_output`, native `fallback_models`, or `config.repo_context_from_default_branch` in PR-Agent files; conflicting settings fail. When the default `.pr_agent.toml` is absent at the frozen base, native repository-settings loading is disabled to prevent its fallback to a moving default branch. Include the selected repository TOML when opting into native per-directory settings. Executable OpenCode extensions, MCP configuration, and custom SDK package declarations are outside the inspection sandbox; use the pinned runtime's built-in providers and declarative settings.

## Focus and performance

Give both engines the intended review mission through trusted native instructions. A named stream isolates state; it does not specialize the generic analysis automatically. PR-Agent extra instructions alone do not constrain OpenCode. Verify the archived analysis stayed in scope before enabling automatic specialized review. The [adoption skill](skills/review-relay/SKILL.md#keep-the-review-focused-and-measurable) explains configuration and measurement practices.

Compare equivalent fresh reviews or continuations on frozen revisions, separating setup and publication from model time. Use the existing stage logs and native session/report data; report finding quality alongside latency. Exclusions filter the primary diff while retaining supporting inspection context. Native effort and model choices remain independently configurable; no universal time, token or step ceiling is imposed.

An engine upgrade changes exact archive compatibility and can require a complete first review. This corrective release preserves schema versions but does not relax those checks. Reports, sessions and performance evidence remain under consumer access controls.

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

## Workflow trust boundary

Every job capable of uploading artifacts in a workflow run containing ReviewRelay must belong to the same trusted domain as the review jobs. Verify the complete caller, including reusable workflows, third-party actions, scripts and dependencies executed by its other jobs. Keep builds that execute reviewed head code or less trusted dependencies in a separate workflow. The supplied review workflow and composed examples execute trusted review tools and inspect PR source as data.

GitHub artifact metadata identifies the caller workflow and run. ReviewRelay verifies that provenance, compatibility and payload checksums; those checks do not authenticate the producing job against other artifact-capable jobs in the same run. Streams isolate review state within this shared trust domain. A recomputed checksum cannot establish trust in a substituted archive, and imported native sessions can contain authority such as permission settings. Supporting jobs with different trust levels in the same run requires additional producer authentication and session-authority controls; this release supports the whole-caller trust boundary above.

## Retention, continuation, and recovery

Reports and native session exports stay in consumer Actions artifacts. They can contain source excerpts and complete conversations; artifact visibility follows that repository's GitHub access policy. The public tool repository receives none of this content. Explicit provider credential values are redacted before archival; no general source-code secret scanner is implied.

Operations download artifacts by ID and verify GitHub producer metadata, consumer identity, schema, exact engine/runtime compatibility, effective configuration fingerprint, frozen revision, native scope, reconstructed diff, and payload checksums. Callers never handle OpenCode's internal session storage. Unknown formats and expired, corrupt, incompatible, or wrong-producer artifacts fail explicitly.

Use **Re-run failed jobs** on the same Actions run to reuse a completed analysis after synthesis failure. Changed revisions or analysis configuration require a new request. A new review request uses PR-Agent's native incremental boundary and imports a compatible archived native OpenCode session. No new changes invokes no model. Missing, expired, or incompatible history starts a complete review with an explicit summary; corrupt compatible context blocks. Artifacts from the pre-extraction implementation are not imported. Engine compatibility is conservative: changes to the recorded engine sources, native profiles, or runtime pins require fresh context.

Publication verifies the live revision, writes the review on the frozen head, and checks again before adding the native history reference. A concurrent PR update can therefore fail a run after a correctly anchored review already exists. Retries reconcile hidden archive-bound markers before creating another review, reference, or suggestion. Partial publication remains a failure until its missing effects are confirmed; inference is not repeated to repair publication.

## Develop and verify

Production execution has no npm dependencies. Development uses the lockfile with npm, Socket Firewall, disabled lifecycle scripts, and a seven-day release-age gate. Run `sfw npm ci`, `npm test`, and `npm run check`. `npm run format` formats task files with the pinned Oxfmt version.

`REVIEW_OPERATION=validate node bin/install-runtime.mjs` prepares the checksum-pinned actionlint and writes `ACTIONLINT_BIN` to `GITHUB_ENV`. Set it directly when running outside Actions, then run `npm run check:workflows`. The checker resolves `$/action` to the local action only for actionlint 1.7.12's static interface checks; hosted qualification must establish GitHub's self-reference behavior.

`REVIEW_OPERATION=analyze node bin/install-runtime.mjs` prepares the pinned image and CLI and writes `OPENCODE_BIN` to `GITHUB_ENV`. With that variable set, run `npm run test:native`. Native tests use the real pinned binaries, real PR-Agent/PyGithub, finite external HTTP fixtures, and a local model stub. The native tokenizer library prepares and verifies its own cache once; fixtures then run without external network access. These checks establish native instruction delivery, session continuation, rendering, and suggestion publication/replay against the fixtures, not hosted GitHub or live model-provider compatibility.

Release versions belong to `runtime.json`. Publish a stable tag only after [both hosted qualification paths](docs/qualification.md) pass on the frozen candidate. Upgrades to the pinned OpenCode or PR-Agent versions require their own qualification.

## License

ReviewRelay's source is licensed under [Apache-2.0](LICENSE). The separately downloaded OpenCode and PR-Agent distributions retain their upstream licenses.
