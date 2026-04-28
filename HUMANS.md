# @rethunk/github-mcp — User guide

Rollup GitHub tools for LLMs via MCP. **How the server is installed and wired to clients:** **[docs/install.md](docs/install.md)** only (do not restate that material here).

## Badges

[![CI](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/Rethunk-AI/rethunk-github-mcp?logo=github&label=release)](https://github.com/Rethunk-AI/rethunk-github-mcp/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/blob/main/package.json)

**Implementation map (modules under `src/server/`, entry `src/server.ts`), symbols, and contract bumps** live in **[AGENTS.md](AGENTS.md)** at the repository root.

**Registered tool ids, parameters, JSON shapes, error codes:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; not duplicated here.

## Authentication

All tools require a GitHub token. The server resolves it in order:

1. **`GITHUB_TOKEN`** environment variable
2. **`GH_TOKEN`** environment variable
3. **`gh auth token`** subprocess (if `gh` CLI is installed)

Set the token in your MCP client's `env` block — see [docs/install.md](docs/install.md).

**Required scopes:** `repo` (for private repository access), `read:org` (for `org_pulse`).

**GitHub Enterprise:** set `GITHUB_API_URL` (defaults to `https://api.github.com`) and optionally `GITHUB_GRAPHQL_URL` in the `env` block.

## Installation and running

Full per-client wiring (Cursor, VS Code, Claude Desktop, Zed, CLI): **[docs/install.md](docs/install.md)**.

Quick start — the server speaks MCP over stdio. Start it with any of:

```bash
npx -y @rethunk/github-mcp          # via npmjs (Node ≥ 22)
bunx @rethunk/github-mcp            # via Bun
rethunk-github-mcp                   # if installed globally
```

Minimal MCP client JSON (server name `rethunk-github`):

```json
{
  "mcpServers": {
    "rethunk-github": {
      "command": "npx",
      "args": ["-y", "@rethunk/github-mcp"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

**GitHub Enterprise:** add `GITHUB_API_URL` (and optionally `GITHUB_GRAPHQL_URL`) to the `env` block.

## Common operations

| Goal | Tool |
|------|------|
| Dashboard across multiple repos | `repo_status` (up to 64 repos per call) |
| My open PRs and review queue | `my_work` |
| Pre-merge safety check | `pr_preflight` |
| Why is CI red? | `ci_diagnosis` |
| What would ship if we release now? | `release_readiness` |
| Org-wide failing CI / stale PRs | `org_pulse` |
| How far are my pins behind upstream? | `pin_drift` |
| Recent merged commits across repos | `ecosystem_activity` |
| Go pseudo-version for a commit | `module_pin_hint` |
| Draft CHANGELOG from unreleased commits | `changelog_draft` |

All tools are **read-only**. Default output is JSON; pass `format: "markdown"` for human-readable output. Full parameter reference: **[docs/mcp-tools.md](docs/mcp-tools.md)**.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, build commands, git hooks, commit conventions, CI, and how to add a tool.

## Publishing

### GitHub (automated) — version tags only

Tag pushes run **[`.github/workflows/release.yml`](.github/workflows/release.yml)**: build, check, tests, then:

1. **`npm pack`** using the committed **`package.json`** name **[`@rethunk/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp)** — tarball attached to a **GitHub Release** for that tag.
2. **GitHub Packages** (npm registry): workflow temporarily rewrites name to **`@rethunk-ai/github-mcp`** (required scope for org `Rethunk-AI`) and runs `npm publish` to `https://npm.pkg.github.com` with `GITHUB_TOKEN`.

Prerequisite: push a semver git tag `vX.Y.Z` that **exactly matches** `version` in `package.json`.

### npmjs (manual) — maintainers only

1. On a clean checkout at the release commit, run `bun run prepublishOnly`.
2. Log in: `npm login` so `npm whoami` shows the account that owns `@rethunk` on npmjs.
3. Ensure `package.json` has `"name": "@rethunk/github-mcp"` and `publishConfig.access` is `"public"`.
4. Publish: `npm publish --access public`.

**`package.json` `files`** must keep the whole `dist/` directory so every emitted chunk is packed.
