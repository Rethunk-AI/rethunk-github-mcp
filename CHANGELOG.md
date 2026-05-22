# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- markdownlint-disable MD024 -->

## [Unreleased]

## [1.2.0] — 2026-05-22

A correctness, security, and safety pass across the whole tool surface,
driven by a full critical review. Adds preview (`dryRun`) support to the
destructive mutation tools and refreshes all dependencies.

### Added

- **`dryRun`** parameter on **`labels_sync`**, **`release_create`**, and **`workflow_dispatch`** — computes and returns the planned action without mutating GitHub state.
- **`labels_sync`** now returns a **`failures[]`** array (`{ name, action, error }`) so a partial failure surfaces per label instead of discarding completed work.
- **`release_create`** returns a **`warnings`** array when both `body` and `generateNotes` are supplied, and pre-checks the tag to return a `VALIDATION` error instead of silently failing when a release already exists.
- **`release_readiness`** returns **`truncatedCount`** when the compared commit range exceeds the GitHub compare-endpoint cap or `maxCommits`.
- **`actions_runs_filter`** gained a **`format`** parameter for markdown output, matching the rest of the tool surface.
- **`gh_auth_status`** now populates **`scopes`** from the `x-oauth-scopes` response header.

### Changed

- **`pr_comment_batch`** output field **`commentsPosted`** renamed to **`commentsRequested`** — GitHub's review-creation response does not echo created inline comments, so the count is the requested one.
- **`issue_from_template`** variable substitution is now **`{{ key }}`-only**; the greedy legacy `$key` form (which rewrote tokens like `$100`) was removed.
- **`labels_sync`** fully paginates the existing label set, so the `deleteExtra` computation is correct for repositories with more than 100 labels.
- **`fetchPRMetadata`** resolves PRs in batches of 20 instead of truncating at 20.
- **`repo_status`** and **`release_readiness`** render `pending`/`expected` CI states distinctly instead of collapsing every non-success state to "failing".
- The coverage gate now fails if any registered tool file is absent from the coverage report, closing a blind spot that hid five zero-coverage tools.
- All direct and transitive dependencies refreshed to their latest compatible versions.

### Fixed

- **`my_work`** was non-functional — the GraphQL search queries embedded `$username` inside string literals, so every call failed variable validation. Search strings are now built correctly and `username` is validated against `^[A-Za-z0-9-]+$`.
- **`org_pulse`** stale-PR detection ordered PRs `UPDATED_AT DESC` and only fetched the first 10, structurally excluding the stalest PRs; it now orders ascending.
- **`ci_diagnosis`** listed every passing job under "Failed Jobs" on green runs.
- **`asyncPool`** leaked unhandled rejections and silently shrank effective concurrency when a task rejected.
- **`pr_preflight`** commit-granularity check ran up to 250 serial `getCommit` calls; these now run through `parallelApi`.
- **`pin_drift`** head-equality shortcut compared SHAs against tag/branch names, and `package.json` parsing false-matched `file:`/`workspace:`/`link:`/`npm:` specs.
- **`ecosystem_activity`** threw a `TypeError` (misclassified as `INTERNAL`) for not-found repositories; it now returns `NOT_FOUND`.
- **`changelog_draft`** emitted sections in map-insertion order instead of `LABEL_ORDER`.
- **`fetchLatestSemverTag`** picked the first API-ordered tag rather than the highest semver.
- **`timeAgo`**, **`parseSince`**, and **`extractPRNumbers`** hardened against future/clock-skewed dates, semantically-invalid dates, and unsafe-integer overflow.
- A non-numeric **`GITHUB_API_PARALLELISM`** value no longer yields unbounded concurrency.

### Security

- **`fetchCommitHistory`** now passes `since`, `path`, and `limit` as typed GraphQL variables instead of interpolating them into the query string (`path` is partially derived from repository manifest content).
- **`parseGitHubRemoteUrl`** anchors the host pattern, rejecting homograph URLs such as `github.com.evil.com/a/b`.
- **`classifyError`** scrubs GitHub tokens (`gh[pousr]_…`, `token …`) from error envelope messages.
- Auth caches (token, REST, and GraphQL clients) invalidate on a genuine HTTP 401 so a rotated token can be re-resolved without a restart.

### Tests

- Added mocked happy-path coverage for the five previously-untested tools: **`pr_preflight`**, **`ci_diagnosis`**, **`my_work`**, **`org_pulse`**, and **`changelog_draft`**.
- Added `dryRun`, partial-failure, and error-path tests for the mutation tools, plus infrastructure tests for `asyncPool`, URL anchoring, token scrubbing, and date helpers.

### Documentation

- **`docs/mcp-tools.md`** updated for every new parameter, output field, and contract change.

## [1.1.0] — 2026-05-07

### Added

- Write-capable GitHub tools: **`release_create`**, **`workflow_dispatch`**, **`pr_comment_batch`**, **`pr_create`**, **`issue_from_template`**, **`labels_sync`**, and **`check_run_create`**.
- Read-only helper tools: **`gh_auth_status`** and **`actions_runs_filter`**.
- **`release_readiness`** now reports **`artifactIntegrity`** so releases can detect assets missing from checksum manifests.
- **`pr_preflight`** now surfaces **`commitGranularity`** warnings for over-bundled commits.
- **`asyncPool`** / **`parallelApi`** fan-out across batch endpoints, reducing multi-item GitHub round-trips.
- **`specs/`** scaffold (`config.yaml`, `README.md`, and active/done/parked directories) for Citadel/Bastion-style specification tracking.

### Changed

- MCP roots support now lets **`repo_status`**, **`pr_preflight`**, **`pin_drift`**, and **`ecosystem_activity`** default to the active client workspace root when the MCP host exposes roots.
- **`release_create`** now delegates generated release notes to GitHub's native **`generate_release_notes`** flow instead of precomputing them in-process.
- **`bunfig.toml`** excludes **`scripts/**`** from coverage accounting so the line gate reflects product code under **`src/`**.
- Repository docs were refreshed around the read/write tool split, auth/install guidance, future-only backlog handling, and spec workflow; committed workspace-specific **`.cursor`** MCP wiring was removed.
- **`ecosystem-activity-tool`** now imports **`./github-client.js`** as a namespace so tests can reliably **`spyOn(gh, "graphqlQuery")`**, and **`github-auth`** now imports **`node:child_process`** as a namespace for the same reason.

### Fixed

- **`fetchIssueTemplateFileContent`** narrows **`repos.getContent`** responses before reading **`content`**, satisfying Octokit's **`unknown`** payload shape in CI.
- Newly added mutation tools now gate on auth before making GitHub requests, and **`gh_auth_status`** returns **`authenticated: false`** on missing credentials while still classifying unexpected upstream failures.
- Bare catch paths now log and classify upstream failures instead of silently swallowing them.
- **`fetchLatestSemverTag`** and **`fetchPRMetadata`** now distinguish upstream API errors from missing-data cases more reliably.

### Security

- GraphQL queries now use variables for head refs, paths, and **`since`** values, and **`my_work`** no longer interpolates usernames directly into GraphQL search queries.
- **`SECURITY.md`** now documents token separation, mutation risk, and safe validation practices for write-capable tools.

### Tests

- Added or expanded coverage for write-capable tools, issue-template helpers, auth fallback paths, JSON/version helpers, utility helpers, roots support, and **`ecosystem_activity`** GraphQL behavior.
- The coverage gate remains **80%**, but now measures product code rather than helper scripts.

### Documentation

- **`README.md`**, **`HUMANS.md`**, **`docs/install.md`**, **`docs/mcp-tools.md`**, **`AGENTS.md`**, **`CONTRIBUTING.md`**, and **`TODO.md`** now describe the current tool surface and repository workflow.

## [1.0.4] — 2026-04-26

### CI

- **`test:coverage`** now enforces the same **80% line coverage** gate locally as CI (instead of only parsing coverage in the workflow).
- **Release workflow** now runs **`bun run test:coverage`** (with `GITHUB_TOKEN` available to tests), matching the PR CI gate.

### Changed

- **Packaging hygiene**: moved release/coverage helper CLIs under **`scripts/`** so they are not emitted into published **`dist/`**, and excluded **`src/server/test-harness.ts`** from the TypeScript build output.

### Added

- **`release:check`** expands release-time validation (changelog heading for the version, `package.json` ↔ git tag parity when `GITHUB_REF` is set, `files` includes **`dist`**, and rejects obvious test-only artifacts under **`dist/`**).
- **`ecosystem_activity`** tests covering stable **JSON**/**markdown** shapes for local resolution errors and the **64-repo** batch cap.

## [1.0.3] — 2026-04-21

### Changed

- **`repo_status`** and **`ecosystem_activity`**: raised the per-request cap on the `repos` array from **20** to **64**, via shared **`MAX_REPOS_PER_REQUEST`** in **`src/server/schemas.ts`** (aligned with **`@rethunk/mcp-multi-root-git`** inventory default). **`docs/mcp-tools.md`** and **`README.md`** updated.

## [1.0.2] — 2026-04-21

### Fixed

- **`fetchLatestSemverTag`** — `getOctokit()` was called outside the `try/catch` block, so an `AUTH_MISSING` throw propagated as a test failure in environments where the Actions token has limited scope, rather than the function returning `undefined` as intended and documented by the test's own guard comment.

### CI

- Coverage gate added: `bun run test:coverage` enforces an 80% line-coverage minimum. `GITHUB_TOKEN` is now explicitly forwarded to the test step.

### Documentation

- **`CONTRIBUTING.md`** — new file; consolidates dev setup, hook table, commit conventions, CI description, PR checklist, and how-to-add-a-tool guidance.
- **`HUMANS.md`** — Development section replaced with a pointer to `CONTRIBUTING.md`; auth, install reference, and publishing steps remain.
- **`AGENTS.md`** — corrected pre-commit hook description (`check` → `check + test`) and updated canonical-docs link for dev/CI content.

## [1.0.1] — 2026-04-21

### Docs

- **README.md**: added npm version badge; corrected format-default note
  ("JSON, not markdown"); added `changelog_draft` to the tools table;
  clarified npmjs vs GitHub Packages description.
- **`docs/mcp-tools.md`**: full refresh — added `changelog_draft` to the
  tools overview table and its own parameter + JSON-output reference section;
  corrected all `format` parameter defaults from `"markdown"` to `"json"`;
  rewrote `pr_preflight` params to document `localPath`, `numbers[]`, `ref`,
  `includeLogs`, `maxLogLines`, and `grepLog`; marked `release_readiness`
  `base` as optional with auto-semver-tag default; added `my_work`
  `blockedOnMe`; fixed `ci_diagnosis` `maxLogLines` default (150 → 50) and
  added `grepLog`; noted glob support in `pin_drift` `pinFiles`.
- **`AGENTS.md`**: corrected implementation-map symbol list — removed dead
  `spreadWhen`, added `mkLocalRepoNoRemote`, `mkError`, `errorRespond`,
  `spreadDefined` to `json.ts`; expanded `utils.ts` to full export list
  (`parseSince`, `extractFirstPR`, `extractPRNumbers`, `tailTruncate`,
  `CheckNode`, `normalizeFailedChecks`); added `MaxCommitsSchema` /
  `MaxLogLinesSchema` to `schemas.ts`; added `classifyError`,
  `parseGitHubRemoteUrl`, `PRNode`, `fetchPRMetadata`, `fetchLatestSemverTag`
  to `github-client.ts`; fixed stray leading-pipe row formatting on two rows;
  extended Changing-contracts checklist to include `AGENTS.md`.
- **`docs/install.md`**: updated GitHub Packages note — npmjs
  `@rethunk/github-mcp` is now current as of v1.0.0 (was noted as possibly
  lagging).

## [1.0.0] — 2026-04-21

First stable release. The public tool surface (10 tools), JSON response
contract (`MCP_JSON_FORMAT_VERSION: "2"`), and structured error envelope
(`{ code, message, retryable, suggestedFix? }`) are now declared stable.
No breaking changes are expected in the 1.x line.

This release focuses on three themes: **new tool capabilities** that
eliminate common multi-call round-trips, **token economy** improvements
that reduce LLM input/output cost on every call, and **internal
consolidation** that removes ~200 lines of duplicated logic while raising
line coverage from 55 % to 92 %.

### Added

- **`changelog_draft` tool** — generates a formatted `CHANGELOG.md` draft
  from commits between two refs, annotated with PR labels and titles via a
  single batched GraphQL query. Accepts `base` (defaults to latest semver
  tag), `head`, `owner`, `repo`, `maxCommits` (1–200), and `format`.
  Shares the `fetchPRMetadata` + `fetchLatestSemverTag` pipeline already
  used by `release_readiness`, adding zero new API calls for the common
  case.
- **`pr_preflight`: batch mode** — new `numbers: number[]` parameter checks
  multiple PRs in one call; `number` (singular) is still accepted for
  single-PR use.
- **`pr_preflight`: flexible ref input** — the `ref` parameter now accepts a
  bare PR number, a full GitHub PR URL
  (`https://github.com/owner/repo/pull/N`), or an `owner/repo#N` slug in
  addition to the original `owner`/`repo`/`number` split form.
- **`pr_preflight`: `localPath` auto-detection** — pass `localPath: "."` to
  resolve `owner` and `repo` from the local clone's `origin` remote, saving
  a lookup step.
- **`pr_preflight`: combined preflight + CI logs** — `includeLogs: true`
  fetches truncated failing-job logs (up to `maxLogLines` lines, filtered by
  optional `grepLog`) in the same call, eliminating a separate
  `ci_diagnosis` round-trip for the common "PR is failing, why?" workflow.
- **`my_work`: `blockedOnMe` lens** — `blockedOnMe: true` filters to PRs
  where the authenticated user is the current bottleneck: review requested,
  changes requested by others are pending, or CI is failing on a PR they
  own.
- **`ci_diagnosis`: `grepLog` filter** — regex applied server-side to each
  log line before truncation; only matching lines are returned. Cuts output
  tokens dramatically when debugging known failure patterns (e.g.
  `"FAIL|Error|panic"`).
- **`release_readiness`: auto-base** — omitting `base` now resolves the
  latest semver tag (`vX.Y.Z` or `X.Y.Z`) automatically via the REST tags
  API, removing the need to look up or supply the tag manually.
- **`pin_drift`: glob patterns** — `pinFiles` now accepts glob patterns such
  as `"**/go.mod"` or `"packages/*/package.json"` in addition to exact
  relative paths. Patterns are expanded against the directory tree at
  call time.

### Changed

- **Default output format changed to `"json"`** (was `"markdown"`). Every
  tool now defaults to compact minified JSON, which is easier for LLMs to
  parse and cheaper in output tokens. Human-readable markdown is still
  available via `format: "markdown"` on every tool.
- **`ci_diagnosis` `maxLogLines` default: 150 → 50.** The previous default
  produced large outputs for simple failures; 50 lines covers nearly all
  actionable tail content. Pass a higher value explicitly when needed.
- **`release_readiness` commit list** is now a compact bullet list
  (`- sha7 message (#PR)`) instead of a wide markdown table with
  `| sha | message | author | date |` columns, saving significant token
  width on long changelogs.
- All tool and parameter descriptions trimmed of filler phrasing ("This
  tool allows you to…", "Optionally specify…") throughout, reducing system
  prompt token cost for every registered tool.
- Markdown output across all tools (`repo_status`, `my_work`, `org_pulse`,
  `release_readiness`, `pin_drift`) replaces Unicode emoji status indicators
  (✓ ✗ ⧗ 🔴 🟢) with plain-text equivalents (`passing`, `failing`,
  `CI: ok`, `CI: fail`). Each emoji encodes as 3–4 bytes / 1–2 tokens;
  removing them across all output paths lowers average response token cost.
- `repo_status` draft-PR counter now uses the GitHub Search API
  (`search(query: $q, type: ISSUE)`) for an O(1) count instead of fetching
  100 full PR nodes and filtering client-side.

### Fixed

- **`repo_status` draft-PR count always returned 0** — `DRAFT_COUNT_QUERY`
  used `$query` as a GraphQL variable name, which `@octokit/graphql`
  rejects as a reserved word at parse time, causing the draft count to
  silently fail on every call. Renamed to `$q`.
- **`ecosystem_activity` commit subjects misattributed as `pr.title`** — the
  commit subject line was being returned in a `pr.title` field that has no
  meaning for non-PR commits. The field is now omitted; only `pr.number`
  is returned when the commit is associated with a PR.
- **`readPackageVersion` read `package.json` on every call** — result is now
  cached after the first read, eliminating repeated synchronous filesystem
  I/O on every `readMcpServerVersion()` call (used in response envelopes).
- **`truncateText` injected a stray `\n`** before the truncation marker
  (`…\n [truncated]`), producing a spurious blank line in tool output.
  The marker is now appended inline: `abc… [truncated]`.

### Refactored

Significant internal consolidation with no user-visible API change:

- **`src/server/utils.ts`** (new file) — canonical home for all cross-tool
  pure helpers:
  - `timeAgo(dateStr)` — human-readable relative timestamp
  - `parseSince(s)` — parses `"48h"` / `"7d"` / ISO8601 into a GitHub API
    `since` timestamp
  - `extractPRNumbers(msg)` / `extractFirstPR(msg)` — pull `(#N)` refs from
    commit messages
  - `tailTruncate(text, n)` — keep last _n_ lines of CI log output
  - `CheckNode` interface + `normalizeFailedChecks(nodes)` — deduplicate
    status-check rollup handling shared by `repo_status` and
    `release_readiness`
- **`src/server/github-client.ts`** gains three exports previously
  copy-pasted across tool files:
  - `PRNode` interface and `fetchPRMetadata(owner, repo, numbers, opts)` —
    batched GraphQL up to 20 PRs per call
  - `fetchLatestSemverTag(owner, repo)` — resolves latest `vX.Y.Z` tag via
    REST
- **`src/server/schemas.ts`** gains `MaxCommitsSchema` and `MaxLogLinesSchema`
  — replacing four independent `z.number().int().min(1).max(N)` chains that
  were each defined in the tool files that used them.
- **`src/server/json.ts`** gains `mkLocalRepoNoRemote(path)` — single
  factory for the `LOCAL_REPO_NO_REMOTE` error envelope, replacing three
  inline `mkError("LOCAL_REPO_NO_REMOTE", …)` call sites in
  `repo_status`, `ecosystem_activity`, and `pr_preflight`.
- `spreadWhen` un-exported (internal only); its one external caller switched
  to the simpler `spreadDefined` pattern.
- All tool files now import from shared modules, eliminating approximately
  200 lines of duplication across the codebase.
- `parseGitHubOwnerRepo` (local copy in `pin-drift-tool.ts`) replaced by the
  shared `parseGitHubRemoteUrl` from `github-client.ts`.

### Tests

Line coverage raised from **55 % → 92 %** (function coverage 62 % → 91 %):

- **`src/server/utils.test.ts`** (new) — 40 unit tests for all five pure
  utility functions; no network access required.
- **`compare-refs.test.ts`** extended with live-API smoke tests for
  `resolveRef`, `fetchCommitHistory`, and `countBehind`; tests skip
  gracefully when auth is absent.
- **`github-client.test.ts`** extended with `getOctokit`, `fetchLatestSemverTag`,
  and `fetchPRMetadata` coverage.
- **`module-pin-hint-tool.test.ts`** extended with explicit-ref,
  `NOT_FOUND`, and markdown-format paths via `captureTool`.
- **`repo-status-tool.test.ts`** extended with direct `owner`/`repo` and
  markdown-rendering paths; exercises `getLocalGitState` against the live
  working tree.
- **`pin-drift-tool.test.ts`** extended with fixture-file tests (go.mod,
  package.json, glob expansion, ownerAllowlist) that call the actual source
  parsers rather than inline test reimplementations. The go.mod fixture
  drives the full GitHub API fan-out path.
- **`json.test.ts`** extended to cover `mkLocalRepoNoRemote` and the
  `captureTool` error-throw path in `test-harness.ts`.
- Test files that previously re-implemented source logic inline now import
  from real source modules, giving meaningful coverage numbers.

### Docs

- `AGENTS.md` corrects `MCP_JSON_FORMAT_VERSION` (`"1"` → `"2"`) and
  updates the implementation map to include `utils.ts` and
  `changelog-draft-tool.ts`.
- `AGENTS.md` removes a duplicated commit-discipline section that was
  already covered by the global `CLAUDE.md`.

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

[1.2.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Rethunk-AI/rethunk-github-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v1.0.0
[0.3.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.3.0
[0.2.1]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/Rethunk-AI/rethunk-github-mcp/releases/tag/v0.2.0

<!-- markdownlint-enable MD024 -->
