# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-17

### Changed (breaking)

- `MCP_JSON_FORMAT_VERSION` bumped from `"1"` to `"2"`. All tool JSON responses
  now surface errors through the structured envelope rather than ad-hoc shapes.
- `gateAuth` returns a structured `McpError` envelope on failure instead of a
  string/partial shape. Callers relying on the pre-2.0 shape must migrate.

### Added

- `McpError` envelope + helpers (`mkError`, `errorRespond`) in `src/server/json.ts`
  — uniform `{ code, message, retryable, suggestedFix? }` shape across all tools.
- Octokit error classifier (`classifyError`) mapping HTTP status + rate-limit
  headers to canonical envelope codes (`AUTH_FAILED`, `PERMISSION_DENIED`,
  `NOT_FOUND`, `RATE_LIMITED`, `VALIDATION`, `UPSTREAM_FAILURE`, `INTERNAL`).

### Refactored

All tool error paths migrated to the envelope:

- `repo_status` — per-item errors embedded in envelope.
- `my_work`, `pr_preflight`, `release_readiness`, `ci_diagnosis`, `org_pulse`
  — top-level errors routed through `errorRespond`.
- `pin_drift` — per-pin failures surfaced via envelope.
- `ecosystem_activity` — per-repo errors via envelope.
- `module_pin_hint` — tool errors via envelope.

### Tests

- `pin-drift-tool.test.ts` tracks every `mkdtempSync` dir and cleans up in
  `afterAll`, preventing leaked `$TMPDIR/pin-drift-tool-test-*` directories
  across repeated runs.

### Docs

- `docs/mcp-tools.md` documents the error envelope contract and tool-level
  idempotency guarantees.

## [0.2.1] — prior

Baseline prior to the envelope migration. See git history for details.

## [0.2.0] — prior

Initial public tool surface: `repo_status`, `my_work`, `pr_preflight`,
`release_readiness`, `ci_diagnosis`, `org_pulse`, `pin_drift`,
`ecosystem_activity`, `module_pin_hint`.

[0.3.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.3.0
[0.2.1]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.2.0
