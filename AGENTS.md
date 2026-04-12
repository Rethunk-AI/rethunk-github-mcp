# AGENTS.md — LLM + dev onboarding

IDEs injecting context: don't re-link from rules.

**Package:** [`@rethunk/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp). MCP **stdio** server. Entry [`src/server.ts`](src/server.ts) → FastMCP + `registerRethunkGitHubTools`. Build output [`dist/server.js`](dist/server.js) (publish ships full `dist/`).

**Canonical docs — don't duplicate:**
- Install + per-client wiring → [docs/install.md](docs/install.md)
- Tools, JSON shape, error codes → [docs/mcp-tools.md](docs/mcp-tools.md)
- Dev, CI, publish → [HUMANS.md](HUMANS.md)

## Implementation map

| File | Symbols |
|------|---------|
| [`src/server.ts`](src/server.ts) | `FastMCP`; `readMcpServerVersion()`; `registerRethunkGitHubTools` |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitHubTools` — dispatches to `register*` below |
| [`src/server/json.ts`](src/server/json.ts) | `MCP_JSON_FORMAT_VERSION="1"`, `jsonRespond()` (minified), `spreadWhen`, `spreadDefined`, `truncateLines`, `truncateText` |
| [`src/server/schemas.ts`](src/server/schemas.ts) | `FormatSchema`, `RepoRefSchema`, `LocalOrRemoteRepoSchema` |
| [`src/server/github-auth.ts`](src/server/github-auth.ts) | `gateAuth` (GITHUB_TOKEN → GH_TOKEN → gh CLI), `resetAuthCache` |
| [`src/server/github-client.ts`](src/server/github-client.ts) | `getOctokit` (REST), `graphqlQuery` (typed GraphQL), `asyncPool`, `parallelApi`, `resolveLocalRepoRemote` |
| [`src/server/repo-status-tool.ts`](src/server/repo-status-tool.ts) | `repo_status` — multi-repo dashboard |
| [`src/server/my-work-tool.ts`](src/server/my-work-tool.ts) | `my_work` — cross-repo personal queue |
| [`src/server/pr-preflight-tool.ts`](src/server/pr-preflight-tool.ts) | `pr_preflight` — pre-merge safety check |
| [`src/server/release-readiness-tool.ts`](src/server/release-readiness-tool.ts) | `release_readiness` — what-would-ship-now |
| [`src/server/ci-diagnosis-tool.ts`](src/server/ci-diagnosis-tool.ts) | `ci_diagnosis` — why-is-CI-red |
| [`src/server/org-pulse-tool.ts`](src/server/org-pulse-tool.ts) | `org_pulse` — org-wide activity dashboard |

## API strategy

- **GraphQL** for composite reads (`repo_status`, `my_work`, `pr_preflight`, `release_readiness` PR resolution, `org_pulse`).
- **REST** for: compare endpoint, workflow runs, job log download, behind-base count.
- **Concurrency:** `asyncPool` parallelism 4 (same pattern as `mcp-multi-root-git`).

## Changing contracts

- **`MCP_JSON_FORMAT_VERSION`** (now `"1"`): bump on incompatible JSON changes.
- **Public tool surface:** rename/add → update [docs/mcp-tools.md](docs/mcp-tools.md) + [README.md](README.md).
- **Auth changes:** update [docs/install.md](docs/install.md) `env` examples.

## Validate + CI

Local: `bun run build` | `bun run check` | `bun run test`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs same on PRs + `main` after `bun install --frozen-lockfile`, uploads prerelease `npm pack` artifact. Tag `v*.*.*` matching `package.json` version → [`release.yml`](.github/workflows/release.yml) publishes GitHub Packages as `@rethunk-ai/github-mcp` + cuts GitHub Release. npmjs publish manual (see [HUMANS.md](HUMANS.md)).

Optional [`.githooks/`](.githooks): `bun run setup-hooks` once per clone. pre-commit=`check`; pre-push=frozen install + build + check + test.

## Repo MCP entry (contributors)

Dogfood from clone: [docs/install.md](docs/install.md) — *From source*.

## Commits

Conventional Commits. Small themed commits. Why-focused messages. Stage + commit one invocation per batch.