# ReviewRelay

Read [README.md](README.md) for public contracts, native configuration and detailed validation commands. Follow [docs/qualification.md](docs/qualification.md) before publishing a stable release.

- When a public contract changes, update the README, affected examples and [adoption skill](skills/review-relay/SKILL.md) in the same change. Keep the skill's usage references current and its version metadata consistent with the release it documents.
- Extend the shared engine in `bin/` for both the action and reusable workflow. Preserve native OpenCode/PR-Agent configuration, incremental review and session continuation.
- Read instructions and configuration from the frozen trusted base; inspect PR code without executing it. Separate model generation from publication, and give publishers no model credentials. Keep consumer reports and sessions private.
- Keep all artifact-capable jobs in a caller run equally trusted; put builds executing reviewed head code in a separate workflow.
- When changing review output, keep the stream marker on line 1 and the native review identity within the first five lines. Preserve default-stream compatibility.
- For behavior changes, use RED → GREEN → REFACTOR through real operations, mocking only external boundaries. Run the focused regression, then `npm test` and `npm run check`; run affected native/workflow checks from the README.
- Use Node.js 24+ and npm with `sfw npm ci`. Preserve `.npmrc` safeguards and keep native runtime pins in `runtime.json`.
