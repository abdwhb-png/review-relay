# Release qualification

This document owns the evidence required to publish the first stable ReviewRelay version. Local implementation and fixture results do not establish hosted operation. No hosted qualification or stable release is recorded yet.

## Required hosted paths

| Path                                                | Required evidence                                                                                           | Status                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Complete reusable workflow in the original consumer | Frozen ReviewRelay SHA, consumer PR and run URLs, actual native settings, artifacts and correct-head review | Pending authorization and execution |
| Composed operations in a second consumer            | Different layout, explicit `CLAUDE.md`, distinct native configuration, the same frozen tool SHA             | Pending authorization and execution |

For each path, retain the consumer-controlled run and PR evidence for these outcomes:

- An authorized request is acknowledged and progression is visible; an unauthorized request produces no inference or publication.
- The actual provider/model and native settings match the selected configuration. The primary and manual fallback credentials remain independently scoped.
- The initial review archives a complete native session and publishes at the exact reviewed head. Only the publishing job has PR write permission during publication.
- Additional commits continue that session with PR-Agent's native incremental scope. A request without additional changes invokes neither model.
- A controlled synthesis failure leaves the successful analysis available. Re-running failed jobs reuses its original artifact rather than repeating analysis.
- A stale or incompatible artifact is refused. Publication and suggestions target the frozen commit, and publication retries do not duplicate confirmed effects.
- `/improve` generates applicable native suggestions with a read-only PR token, then publishes them without model credentials or another inference call.
- The complete workflow's `$/action` reference resolves the action and engine from the same tool commit. The composed workflow uses that identical tool revision.

Use a controlled external-boundary failure for synthesis qualification. Do not introduce a production failure-injection input or publish private reports into the public tool repository. Obtain approval before changing consumer workflows or credentials. Keep existing consumer CI independent of ReviewRelay.

## Local evidence

The local candidate was checked on 2026-11-14 with Node.js 24.18.0 and the runtime versions and checksums recorded in `runtime.json`.

| Executed check                                                  | Result and boundary                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test tests/infrastructure/pr-review.test.mjs`           | 36 tests passed. Real Git repositories and production modules; GitHub and container commands replaced at their external boundaries. Includes authorization, configuration, incremental context, artifact compatibility, failed synthesis reuse, stale revisions, fallback, credential redaction and publication replay.                                                                              |
| `npm run check`                                                 | JavaScript syntax, Python AST parsing, Oxlint with warnings denied, and Oxfmt checks passed.                                                                                                                                                                                                                                                                                                         |
| `ACTIONLINT_BIN=<verified binary> node bin/check-workflows.mjs` | Product workflows and public examples passed actionlint 1.7.12. The static self-reference substitution described in the README does not prove hosted resolution.                                                                                                                                                                                                                                     |
| `OPENCODE_BIN=<verified binary> node bin/check-native.mjs`      | Six native scenarios passed against the pinned OpenCode binary and PR-Agent image: scope, review rendering, inline suggestions, confirmed suggestion replay, summarized suggestions with archived native settings, and OpenCode instructions/session continuation. The tests used finite PyGithub HTTP fixtures and a local model stub, without external network access after tokenizer preparation. |

The OpenCode native scenario delivered explicit `CLAUDE.md` and glob instructions to the actual model request, exported/imported the native session, retained earlier context, switched the configured provider on continuation, and refused an attempted shell execution. These bounded checks do not establish arbitrary sandbox escape resistance or live provider compatibility. Native suggestion scenarios confirmed the frozen commit, frozen instruction reads and publication without model credentials.

The separate consumer fixture's two Python baseline tests passed. The prepared original-consumer patch passed `git apply --check` against its recorded source revision, and its caller workflow passed actionlint. Those private integration materials stay outside the public tool source. No consumer checkout was modified by applying the patch.

Hosted GitHub execution, real provider inference, consumer secrets, cross-job artifact transfer on Actions, `$/action` resolution and both required consumer qualification paths remain unverified. Preserve the exact candidate revision with the hosted evidence before recording a release result.

## Stable release gate

Freeze the candidate SHA and its intended version in `runtime.json`, run the complete local checks, then qualify both hosted paths against that SHA. Any behavior change invalidates affected evidence. Only after those paths pass may the exact candidate receive its stable release tag and optional moving major alias. A successful fixture run or an approved design is insufficient.
