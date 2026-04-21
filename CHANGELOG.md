# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-21

First stable release. The public tool surface, JSON response contract
(`MCP_JSON_FORMAT_VERSION: "2"`), and structured error envelope are now
declared stable. No breaking changes are expected in 1.x.

### Added

- **`changelog_draft` tool** — generates a formatted `CHANGELOG.md` section
  from commits between two refs, grouped by label, with optional version
  header. Shares the same base→head + PR-metadata pipeline as
  `release_readiness`.
- **`pr_preflight`: batch mode** — `numbers: number[]` checks multiple PRs in
  a single call.
- **`pr_preflight`: flexible ref input** — `ref` parameter accepts a PR number,
  a GitHub URL (`https://github.com/owner/repo/pull/N`), or an
  `owner/repo#N` slug in addition to `owner`/`repo`/`number`.
- **`pr_preflight`: `localPath` auto-detection** — pass `localPath: "."` to
  resolve `owner`/`repo` from the local clone's `origin` remote.
- **`pr_preflight`: combined preflight + CI diagnosis** — `includeLogs: true`
  fetches truncated failing-job logs in the same call, removing the need for
  a separate `ci_diagnosis` round-trip.
- **`my_work`: `blockedOnMe` lens** — boolean flag that filters to PRs where
  the authenticated user is the blocker (review requested, changes requested
  by others, or CI failing on their PR).
- **`ci_diagnosis`: `grepLog` filter** — server-side regex filter on log lines,
  reducing output tokens when only specific error patterns are needed.
- **`release_readiness`: auto-base** — omitting `base` now auto-selects the
  latest semver tag (`vX.Y.Z` / `X.Y.Z`), removing the need to look up the
  tag manually.
- **`pin_drift`: glob patterns** — `pinFiles` accepts glob patterns (e.g.
  `"**/go.mod"`) in addition to exact paths.
- **Shared `mkLocalRepoNoRemote` error factory** in `json.ts` — single
  canonical `LOCAL_REPO_NO_REMOTE` envelope used by `repo_status`,
  `ecosystem_activity`, and `pr_preflight`.

### Changed

- **Default output format is now `"json"`** (was `"markdown"`). LLM callers
  benefit from structured output by default; human-readable markdown is still
  available via `format: "markdown"`.
- **`ci_diagnosis` `maxLogLines` default lowered from 150 → 50.** Reduces
  output token cost for the common case; increase explicitly when needed.
- **`release_readiness` commit output** is now a compact bullet list instead
  of a multi-column markdown table, reducing token width.
- All tool and parameter descriptions trimmed of filler phrasing for lower
  prompt-token cost.
- Markdown output across all tools replaces Unicode emoji status indicators
  (✓ ✗ ⧗) with plain-text equivalents (`passing`, `failing`, `CI:ok`,
  `CI:fail`), saving multi-byte token sequences.
- `truncateText` no longer injects a stray `\n` before the truncation marker.

### Fixed

- **`repo_status` draft-PR count** was fetching 100 full PR nodes to count
  drafts; now uses the GitHub Search API for an O(1) count.
- **`ecosystem_activity`** was mislabeling commit subjects as `pr.title`; the
  field is now omitted (only `pr.number` is returned).
- **`readPackageVersion`** now caches its result; previously read
  `package.json` from disk on every invocation.

### Refactored

Significant internal consolidation with no user-visible API change:

- **`src/server/utils.ts`** (new) — canonical home for cross-tool pure
  helpers: `timeAgo`, `parseSince`, `extractPRNumbers`, `extractFirstPR`,
  `tailTruncate`, `CheckNode`, `normalizeFailedChecks`.
- **`src/server/github-client.ts`** gains `PRNode`, `fetchPRMetadata` (batched
  GraphQL, up to 20 PRs), and `fetchLatestSemverTag` — previously duplicated
  verbatim in `changelog_draft` and `release_readiness`.
- **`src/server/schemas.ts`** gains `MaxCommitsSchema` and `MaxLogLinesSchema`
  — previously independent `z.number()` chains in four tool files.
- All tool files adopt shared helpers, eliminating ~200 lines of duplication.
- Test files now import from real source modules instead of re-implementing
  logic inline, giving meaningful coverage to `utils.ts`,
  `module-pin-hint-tool.ts`, and `pin-drift-tool.ts`.

### Docs

- `AGENTS.md` corrected `MCP_JSON_FORMAT_VERSION` (`"1"` → `"2"`) and updated
  the implementation map to include `utils.ts` and `changelog-draft-tool.ts`.

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
