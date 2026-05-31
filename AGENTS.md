# AGENTS.md — LLM + dev onboarding

IDEs injecting context: don't re-link from rules.

**Package:** [`@rethunk/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp). MCP **stdio** server. Entry [`src/server.ts`](src/server.ts) → FastMCP + `registerRethunkGitHubTools`. Build output [`dist/server.js`](dist/server.js) (publish ships full `dist/`).

**Canonical docs — don't duplicate:**

- Install + per-client wiring → [docs/install.md](docs/install.md)
- Tools, JSON shape, error codes → [docs/mcp-tools.md](docs/mcp-tools.md)
- Dev setup, CI, commit conventions → [CONTRIBUTING.md](CONTRIBUTING.md)
- Auth, publish → [HUMANS.md](HUMANS.md)

## Implementation map

| File | Symbols |
| ------ | --------- |
| [`src/server.ts`](src/server.ts) | `FastMCP`; `readMcpServerVersion()`; `registerRethunkGitHubTools` |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitHubTools` — dispatches to `register*` below |
| [`src/server/roots.ts`](src/server/roots.ts) | `resolveOptionalLocalPath` — normalize MCP workspace roots / localPath overrides |
| [`src/server/json.ts`](src/server/json.ts) | `MCP_JSON_FORMAT_VERSION="2"`, `jsonRespond()` (minified), `errorRespond`, `mkError`, `mkLocalRepoNoRemote`, `spreadDefined`, `truncateLines`, `truncateText` |
| [`src/server/utils.ts`](src/server/utils.ts) | `timeAgo`, `parseSince`, `extractPRNumbers`, `extractFirstPR`, `tailTruncate`, `CheckNode` (interface), `normalizeFailedChecks` — shared across tool files |
| [`src/server/schemas.ts`](src/server/schemas.ts) | `FormatSchema`, `RepoRefSchema`, `LocalOrRemoteRepoSchema`, `MaxCommitsSchema`, `MaxLogLinesSchema`, **`MAX_REPOS_PER_REQUEST`** (64; caps `repo_status` / `ecosystem_activity` `repos[]`) |
| [`src/server/github-auth.ts`](src/server/github-auth.ts) | `gateAuth` (GITHUB_TOKEN → GH_TOKEN → gh CLI), `resetAuthCache` |
| [`src/server/github-client.ts`](src/server/github-client.ts) | `getOctokit` (REST), `graphqlQuery` (typed GraphQL), `asyncPool`, `asyncPoolSettled`, `parallelApi`, `parallelApiSettled`, `withRetry`, `withTimeout`, `classifyError`, `parseGitHubRemoteUrl`, `resolveLocalRepoRemote`, `PRNode` (interface), `fetchPRMetadata`, `fetchLatestSemverTag` |
| [`src/server/repo-status-tool.ts`](src/server/repo-status-tool.ts) | `repo_status` — multi-repo dashboard |
| [`src/server/my-work-tool.ts`](src/server/my-work-tool.ts) | `my_work` — cross-repo personal queue |
| [`src/server/pr-preflight-tool.ts`](src/server/pr-preflight-tool.ts) | `pr_preflight` — pre-merge safety check |
| [`src/server/pr-comment-batch-tool.ts`](src/server/pr-comment-batch-tool.ts) | `pr_comment_batch` — submit review + inline comments |
| [`src/server/pr-create-tool.ts`](src/server/pr-create-tool.ts) | `pr_create` — open a pull request from an existing branch |
| [`src/server/issue-from-template-tool.ts`](src/server/issue-from-template-tool.ts) | `issue_from_template`; `fetchIssueTemplateDirectory`; `findTemplate`; `fetchIssueTemplateFileContent`; `substituteVariables` |
| [`src/server/release-readiness-tool.ts`](src/server/release-readiness-tool.ts) | `release_readiness` — what-would-ship-now |
| [`src/server/release-create-tool.ts`](src/server/release-create-tool.ts) | `release_create` — create a GitHub release |
| [`src/server/ci-diagnosis-tool.ts`](src/server/ci-diagnosis-tool.ts) | `ci_diagnosis` — why-is-CI-red |
| [`src/server/org-pulse-tool.ts`](src/server/org-pulse-tool.ts) | `org_pulse` — org-wide activity dashboard |
| [`src/server/pin-drift-tool.ts`](src/server/pin-drift-tool.ts) | `pin_drift` — upstream pin drift audit |
| [`src/server/ecosystem-activity-tool.ts`](src/server/ecosystem-activity-tool.ts) | `ecosystem_activity` — cross-repo commit feed |
| [`src/server/module-pin-hint-tool.ts`](src/server/module-pin-hint-tool.ts) | `module_pin_hint` — Go pseudo-version formatter |
| [`src/server/changelog-draft-tool.ts`](src/server/changelog-draft-tool.ts) | `changelog_draft` — CHANGELOG.md section from unreleased commits |
| [`src/server/workflow-dispatch-tool.ts`](src/server/workflow-dispatch-tool.ts) | `workflow_dispatch` — trigger GitHub Actions workflow_dispatch |
| [`src/server/gh-auth-status-tool.ts`](src/server/gh-auth-status-tool.ts) | `gh_auth_status` — auth preflight |
| [`src/server/actions-runs-filter-tool.ts`](src/server/actions-runs-filter-tool.ts) | `actions_runs_filter` — filter Actions runs |
| [`src/server/labels-sync-tool.ts`](src/server/labels-sync-tool.ts) | `labels_sync` — converge repository labels |
| [`src/server/check-run-create-tool.ts`](src/server/check-run-create-tool.ts) | `check_run_create` — publish synthetic GitHub check runs |
| [`src/server/security-alerts-tool.ts`](src/server/security-alerts-tool.ts) | `registerSecurityAlertsTool`; `security_alerts` — Dependabot + Code Scanning rollup |
| [`src/server/pr-review-thread-tool.ts`](src/server/pr-review-thread-tool.ts) | `registerPrReviewThreadTool`; `CompactThread` (interface); `pr_review_thread_ops` — list/resolve/unresolve PR review threads |
| [`src/server/branch-protection-tool.ts`](src/server/branch-protection-tool.ts) | `registerBranchProtectionTool`; `BranchProtectionResult` (interface); `branch_protection_status` — branch protection rules |
| [`src/server/deployment-status-tool.ts`](src/server/deployment-status-tool.ts) | `registerDeploymentStatusTool`; `DeploymentEntry`, `DeploymentStatusResult` (interfaces); `deployment_status` — deployment state per environment |
| [`src/server/issue-dedup-tool.ts`](src/server/issue-dedup-tool.ts) | `registerIssueDedupTool`; `normalizeTitle`, `jaccardSimilarity`, `DedupMatch`, `DedupResult` (interfaces); `issue_dedup` — duplicate issue detection |
| [`src/server/compare-refs.ts`](src/server/compare-refs.ts) | Shared: `resolveRef`, `fetchCommitHistory`, `countBehind` |

## API strategy

- **GraphQL** for composite reads (`repo_status`, `my_work`, `pr_preflight`, `release_readiness` PR resolution, `org_pulse`).
- **REST** for: compare endpoint, workflow runs, job log download, behind-base count, release assets, and every write-capable GitHub mutation endpoint.
- **Concurrency:** `asyncPool` parallelism 4 (same pattern as `mcp-multi-root-git`).

## Changing contracts

- **`MCP_JSON_FORMAT_VERSION`** (now `"2"`): bump on incompatible JSON changes.
- **Public tool surface:** rename/add/remove → update [docs/mcp-tools.md](docs/mcp-tools.md) + [README.md](README.md) + [HUMANS.md](HUMANS.md) + [AGENTS.md](AGENTS.md).
- **Auth or mutation-scope changes:** update [docs/install.md](docs/install.md) `env` examples + [SECURITY.md](SECURITY.md) guidance.
- **Closed backlog items:** remove them from [TODO.md](TODO.md) rather than keeping a shipped-history section.

## Validate + CI

Local: `bun run ci` | `bun run test:coverage`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs install → `bun run ci` → `test:coverage` on PRs and `main`, then uploads a prerelease `npm pack` artifact. Tag `v*.*.*` matching `package.json` version → [`release.yml`](.github/workflows/release.yml) reruns `bun run ci` plus coverage, publishes GitHub Packages as `@rethunk-ai/github-mcp`, and cuts the GitHub Release tarball.

Optional [`.githooks/`](.githooks): `bun run setup-hooks` once per clone. pre-commit=`check + test`; pre-push=frozen install + build + check + test.

## Repo MCP entry (contributors)

Dogfood from clone: [docs/install.md](docs/install.md) — *From source*.
