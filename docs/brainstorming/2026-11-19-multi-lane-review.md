# Independent review streams

Date: 2026-11-19. Status: historical accepted design. Implementation and delivery evidence are owned by the [release qualification record](../qualification.md#version-120).

## Destination

Support independent review streams on one pull request through the reusable workflow and composed action operations, both across separate workflows and within one GitHub Actions run. A general manual review and an automatic localization review must retain separate history, sessions, configuration, checks and recovery.

The accepted approach extends ReviewRelay's existing adapter and lifecycle while preserving PR-Agent's native incremental calculation. The new configuration fields below are a planned contract, not capabilities available in version 1.1.1. Design acceptance authorizes this record, not production implementation or consumer migration.

## Accepted configuration contract

### Stable stream identity

Add an optional `reviewId` to orchestration configuration. Resolve it through the existing precedence: defaults, the trusted file selected by `config-path`, then caller `overrides`.

`reviewId` names a stream such as `localization`; reuse that value across pull requests. Its state is scoped by repository, PR number and review ID. Localization on PR 42 is independent of general review on PR 42 and localization on PR 43. Do not derive stream identity from a workflow filename or configuration fingerprint.

Omitting `reviewId` selects the existing default stream. Preserve its current check names, concurrency key, native anchor markers and recognition of historical references. The default stream ignores named-stream references; named streams ignore unscoped legacy references. Explicitly choosing a new ID starts a separate stream rather than silently adopting another stream's history.

Derive resource names from the resolved identity through shared implementation, rather than independently configurable naming rules:

| Resource                        | Required isolation                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory check and retry lookup | Stream and producer run; preserve the existing default name and external ID when no ID is supplied.                                                   |
| Concurrency                     | Repository, PR and stream; repeated requests for one stream retain the existing cancellation policy.                                                  |
| Artifact upload name            | Operation, PR, stream and attempt within the GitHub run.                                                                                              |
| Requests and artifact manifests | Bind the stream to the frozen revision, configuration and producer provenance.                                                                        |
| Native review references        | Select only references belonging to the stream before native author verification and incremental calculation.                                         |
| Transport header                | Derive the default session/correlation header per stream; preserve explicit native overrides. The header is not an authorization or history boundary. |

Expose the resolved concurrency key from `authorize`. The supplied workflow and composed examples consume it without reconstructing naming conventions. Subsequent operations retain the identity carried by the authorized request and reject inconsistent transfers.

### Native repository settings

Add `prAgentConfigPath`, defaulting to `.pr_agent.toml`, to select the trusted native repository TOML. A custom selection replaces the repository root layer; it must not silently inherit the general root TOML. Keep native host defaults, environment precedence, configuration parsing and applicable native per-directory behavior.

Read the selected file at the frozen base revision. A missing custom file or invalid selected configuration fails explicitly before inference. Preserve the existing handling of an absent default file, including protection against native fallback to a moving branch. Validation must not make an unused general root file act as another stream's effective configuration.

Example specialized orchestration file:

```json
{
    "reviewId": "localization",
    "autoReview": true,
    "prAgentConfigPath": ".pr_agent.localization.toml",
    "instructionSources": ["docs/localization.md"]
}
```

Keep native engine settings in their existing formats. Preserve configurable project instruction sources and native discovery without imposing an instruction filename or a project skill inventory.

### Event and file selection

The caller routes events to streams: for example, manual commands to general review and PR events to localization. Existing automatic-review, draft eligibility and manual fallback policies remain in force.

Use the current `excludeGlobs` semantics, including negated keep rules, for primary-diff selection. For example, `["**", "!locales/**"]` selects the localization paths. Supporting source can remain inspection context. Additional inclusion syntax or command-addressing syntax is not required by this design.

## Execution and recovery

1. Authorization freezes repository, PR revisions, configuration and stream identity in the request. Retain existing permission and eligibility checks.
2. The native adapter presents only the stream's eligible review references during scope preparation and CLI synthesis. Delegate author verification, native review matching, commit selection and rebase handling to PR-Agent. Cover every provider instance used by these paths, not only the initial scope probe.
3. Analysis and synthesis use the selected native settings and archive verified, stream-bound artifacts. Preserve native session exports and complete native Markdown, including configured run details.
4. Publication verifies the request, artifact, producer and frozen live revision. Keep generation read-only and the publisher free of model credentials. Preserve archive-bound publication markers and idempotent reconciliation.
5. Session discovery verifies the relevant stream's analysis artifact rather than requiring the entire producer run to have succeeded. A valid completed analysis must remain usable when another stream fails or is still running. Retain workflow provenance, configuration, revision, compatibility and checksum checks.

Foreign streams are not history candidates. An explicitly supplied artifact from a different stream fails before inference or publication. Corrupt compatible history remains an explicit error; missing or incompatible context follows the existing full-review fallback policy. A synthesis retry reuses that stream's completed analysis; publication recovery does not repeat inference merely to repair missing publication effects.

All participating callers must use a lane-capable version. Historical default references remain recognizable, while archived exports remain subject to the existing exact engine/version compatibility policy. Do not weaken that policy to promise uninterrupted cache reuse across an upgrade.

## Composition boundaries

Support separate workflow callers, multiple complete-workflow calls in one run, a matrix of complete-workflow calls, and custom job chains using the action operations. Both public interfaces continue to use one implementation.

Provide the matrix example with `strategy.fail-fast: false`. Otherwise GitHub can cancel other matrix members when one fails. Preserve individual stream failures rather than suppressing them with `continue-on-error`. A run can be globally failed while another stream's check is successful and its context remains reusable. See [GitHub matrix failure handling](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategyfail-fast).

Keep requests and artifact IDs associated with their stream in custom compositions. Matrix outputs with identical names overwrite each other; a single workflow output is not an automatic collection of every stream's result. The supplied matrix pattern runs a complete lifecycle per member. Custom result aggregation remains caller orchestration. See [job matrix outputs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idoutputs) and [reusable workflow outputs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow).

Validate identifiers so distinct accepted identities cannot collapse into one GitHub concurrency group, whose names are case-insensitive. Specify the exact identifier grammar and public format changes during implementation. See [GitHub concurrency rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Required validation before delivery

Use RED → GREEN → REFACTOR at the production operation boundary, with real internal collaborators and external GitHub/model transports replaced where deterministic coverage requires it. Exercise the pinned native client rather than mocking its review-identity or incremental helpers.

| Regression                                                                | Required observable result                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Localization publishes on C1 before general review, and the reverse order | One stream's reference does not make the other skip C1.                                                                                                                        |
| Both streams receive C2                                                   | Each uses its own incremental boundary and native session; a no-new-changes request is evaluated independently.                                                                |
| A completes and B fails in one run                                        | A's context remains discoverable despite overall run failure. B's failed-job retry reuses its analysis without repeating A, duplicating its publication or updating its check. |
| Wrong-stream artifact, stale revision or invalid selected configuration   | Refuse before the affected model or write operation; retain existing authorization and publication gates.                                                                      |
| Different native TOMLs and trusted instruction sources                    | Observe the intended effective native settings and frozen source reads, without accidental general-root merging.                                                               |
| No review ID                                                              | Preserve default resource names, native markers, historical reference recognition and eligibility rules.                                                                       |

Live GitHub qualification must exercise both public interfaces across separate workflows and a shared run, including the complete-workflow matrix and composed job chains. Verify manual review and applicable suggestions, automatic routing, independent checks and progress, distinct artifacts, session continuation, failed-stage reuse and publication on the exact frozen commits. Inspect reviewed code as data; do not execute it.

Update README configuration guidance, examples and the usage skill with the implementation. Record qualification results only after the checks run. Consumer workflow migration and consumer-specific localization fixes remain subsequent work.

## Evidence and alternatives

Research used ReviewRelay revision `29c2b76471cd003ff1890594042f1139df99c500`; its executable implementation matches the version 1.1.1 consumer snapshot. Files inspected: [review engine](../../bin/pr-review.mjs), [native adapter](../../bin/pr-agent-native.py), [configuration](../../bin/configuration.mjs), [artifacts](../../bin/artifacts.mjs), [action runner](../../bin/action.mjs), [GitHub helpers](../../bin/github-actions.mjs), [reusable workflow](../../.github/workflows/review.yml), [action interface](../../action/action.yml), [infrastructure tests](../../tests/infrastructure/pr-review.test.mjs), [native fixture](../../tests/native/adapter_fixture.py), [runtime pins](../../runtime.json) and [README](../../README.md).

Verified in those sources:

- Native scope can return no new changes before compatible-session lookup, so configuration-separated session artifacts alone do not prevent cross-stream skips.
- Concurrency, check names, retry external IDs and upload names lack a stream identity. Same-run composition exposes additional artifact and retry collisions. The pinned [upload action](https://github.com/actions/upload-artifact/blob/cf430e030ddbb5b0abf93d22962f4752f3646cd9/README.md#not-uploading-to-the-same-artifact) requires unique artifact names.
- Session lookup selects globally successful workflow runs, coupling otherwise completed analysis to unrelated jobs.
- The default transport header is shared but already overridable. Its value alone does not establish a mixture of native OpenCode conversations.
- A custom native host-profile path is applied before repository settings; it does not independently replace the hardcoded native repository root TOML.

Inspection of the exact pinned PR-Agent image covered `GithubProvider.get_previous_review`, `get_incremental_commits`, `get_commit_range`, native identity helpers, provider construction/context caching, repository settings loading and reviewer initialization. The native previous-review selector checks authors and recognizes fixed markers or legacy headings; commit-range calculation uses the selected reference's time. This supports adapting the history view while retaining the native calculation.

An existing hybrid integration test covering filtered diffs and negated keep rules passed. A temporary Git pathspec probe confirmed the whitelist expression above. These checks establish current selector behavior, not the proposed multi-stream behavior. No multi-stream implementation, native end-to-end qualification or hosted review qualification was performed during design.

The user selected adaptation at the ReviewRelay boundary. An artifact-owned progression registry was not selected because it adds publication receipts, reconciliation and retention-dependent progression. Moving namespaces into PR-Agent was not selected because it expands delivery into the native engine or a maintained derivative. Both can be reconsidered only if a concrete requirement changes that trade-off.

Future requests for new inclusion syntax, selecting a named stream through comment arguments, or cross-workflow/version session migration require their own demonstrated need and compatibility analysis. A native dependency upgrade requires requalification of the adapter assumptions. None is a prerequisite for the accepted design.

## Original implementation handoff boundary

At design acceptance, implementation remained pending. Extend existing configuration, identity, adapter, artifact and workflow owners rather than introducing a second orchestrator or replacing native incremental/session mechanisms. Plan focused regressions and live qualification from the accepted cases before changing production behavior. Do not present this design record as evidence that the new feature is implemented or qualified.
