---
name: review-relay
description: Use when adopting, configuring, operating, upgrading, or troubleshooting ReviewRelay in a GitHub repository. Do not use for general code review or ReviewRelay engine development.
license: Apache-2.0
---

# ReviewRelay

Install and operate ReviewRelay in the current project using its versioned GitHub Actions interfaces. Produce a reviewable integration that preserves native engine configuration, trusted instructions, and isolated publication.

## When to Use

Use for initial adoption, project configuration, review commands, failed-run recovery, missing review output, or a consumer version upgrade.

## When Not to Use

Do not use to perform an unrelated code review, modify ReviewRelay internals, or build a standalone review CLI.

## 1. Inspect the consumer

Read applicable project instructions and inspect the branch, worktree, existing review workflows, native engine settings, instruction files, and GitHub Actions policy. Preserve unrelated changes and existing credential channels.

Identify the repository default branch, intended PR targets, instruction conventions, provider choices, and whether the project already uses ReviewRelay. Resolve missing choices from existing configuration before asking the user. Do not assume a particular framework, provider, instruction filename, or branch name.

## 2. Select one version and its documentation

Use the official repository: https://github.com/abdwhb-png/review-relay.

For an existing installation, inspect its pinned revision first. For a new installation or requested upgrade, verify the selected release and resolve it to a full commit SHA. Read that revision's README, relevant examples, and qualification record before editing.

Treat those version-matched files as the interface and configuration authority. Do not copy configuration catalogs into project documentation, guess unsupported settings, or silently track a moving branch.

## 3. Configure the project

Keep orchestration settings in ReviewRelay's supported project configuration and engine settings in native OpenCode JSON/JSONC and PR-Agent TOML. Preserve existing settings and use only the changes the project needs.

Select trusted instruction files or globs from the project, including its existing AGENTS.md, CLAUDE.md, custom guidance, or native instruction configuration. Verify that explicit sources exist at the trusted base revision. Do not assume every instruction convention is automatically discovered.

Keep automatic review and provider fallback explicitly controlled. Enable manual draft review or additional target branches only when needed. Use native presentation settings for output such as Agent run details.

For multiple streams, preserve each stable reviewId and select its trusted native TOML with prAgentConfigPath when needed. Read the chosen version's multi-stream examples. Keep each authorized request and artifact ID attached to its stream; consume the returned concurrency-group rather than inventing names. In a matrix, use fail-fast: false and account for GitHub's output aggregation rules. A globally failed producer run does not by itself invalidate a completed stream's verified context.

## 4. Integrate the versioned interface

Prefer the supplied reusable workflow for the complete lifecycle. Start from its version-matched caller example and pin the workflow to the selected full SHA; it resolves its own matching action.

Use composed operations only when the consumer needs custom orchestration. Start from the composed example, retain its authorization, permissions, concurrency and finalization, and keep every operation on the same revision. Verify the complete caller against the selected version's README workflow trust boundary, including jobs reached through reusable workflows and third-party actions. Keep every artifact-capable job in the same trusted domain as ReviewRelay; move builds executing reviewed head code or less trusted dependencies into a separate workflow before activation. Stream identities and archive checksums do not establish trust between jobs.

Reference the delivered workflow or action instead of copying ReviewRelay's engine scripts into the consumer. The action prepares its review runtimes; adopting it does not require application dependencies.

Configure provider credentials through existing Actions secrets or another authorized secure channel. Adapt the example's native provider settings to the selected provider. Never request secrets in chat or commit their values.

Preserve read-only generation and a separate publisher without model credentials. Read instructions and configuration from trusted revisions, and never execute reviewed PR code.

## 5. Validate and activate

Inspect the resulting diff and run the project's available focused workflow/configuration checks. Verify the SHA, supported inputs, secret references, permissions, event routing and instruction sources. Static checks do not establish a working hosted review.

Follow the user's existing authorization for publishing, merging and running workflows. Ensure workflows and configuration are active on the default or target base branch as required before qualification.

For an authorized live check, use an eligible same-repository PR and request one review. Verify authorization, each required stage, the frozen head commit, publication, and consumer-owned report artifacts. Check Agent run details when enabled. Report missing credentials or unavailable live validation explicitly.

## 6. Operate and recover

Use standalone /review or /improve comments from a user with current write, maintain or admin permission, or manual dispatch from the default branch with its PR-number input.

After additional commits, request a new review to use native incremental review and compatible archived session continuation. A no-new-changes result should invoke no model.

After synthesis failure, use GitHub's Re-run failed jobs on the same run to reuse completed analysis. If revisions or analysis configuration changed, start a new request.

For publication failure, inspect the failed stage and retry its existing artifact rather than repeating inference. Preserve provenance checks and publication markers.

Diagnose authorization, trusted configuration, native settings and stage logs before changing providers or versions. Keep reports and sessions under the consumer's access controls. Do not bypass artifact compatibility checks; expired or incompatible history can require a full review.

## 7. Upgrade deliberately

Read the target release notes and qualification boundaries, resolve its full SHA, and review configuration compatibility before replacing the consumer pin. Preserve native settings and credentials unless their change was requested.

Validate the affected integration and qualify live behavior within the authorized scope. Report when the version change requires fresh review context.

## Completion

Report the selected release and full SHA, changed files, configuration choices, secret readiness without values, checks actually run, hosted evidence if available, and any remaining activation step. Distinguish a prepared integration from an active, qualified installation.

Do not create extra project documentation unless it owns information the project needs to retain.
