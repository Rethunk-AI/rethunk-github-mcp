# @rethunk/github-mcp — User guide

Rollup GitHub tools for LLMs via MCP. **How the server is installed and wired to clients:** **[docs/install.md](docs/install.md)** only (do not restate that material here).

## Badges

[![CI](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/Rethunk-AI/rethunk-github-mcp?logo=github&label=release)](https://github.com/Rethunk-AI/rethunk-github-mcp/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/blob/main/package.json)

**Implementation map (modules under `src/server/`, entry `src/server.ts`), symbols, and contract bumps** live in **`AGENTS.md`** at the repository root.

**Registered tool ids, parameters, JSON shapes, error codes:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; not duplicated here.

## Authentication

All tools require a GitHub token. The server resolves it in order:

1. **`GITHUB_TOKEN`** environment variable
2. **`GH_TOKEN`** environment variable
3. **`gh auth token`** subprocess (if `gh` CLI is installed)

Set the token in your MCP client's `env` block — see [docs/install.md](docs/install.md).

**Required scopes:** `repo` (for private repository access), `read:org` (for `org_pulse`).

**GitHub Enterprise:** set `GITHUB_API_URL` (defaults to `https://api.github.com`) and optionally `GITHUB_GRAPHQL_URL` in the `env` block.

## Installation

**Package install and MCP clients:** **[docs/install.md](docs/install.md)**.

## Development

Requires **Bun >= 1.3.11** to build this repository (`packageManager` in `package.json`). **Published runtime** (Node/Bun and how to launch the server): **[docs/install.md](docs/install.md)** — *Prerequisites*.

```bash
bun install
bun run build      # rimraf dist + tsc → dist/
bun run check      # Biome
bun run check:fix  # Biome --write
bun run test       # bun test src/
bun run setup-hooks   # once per clone: use .githooks (pre-commit: check; pre-push: CI parity)
```

**Git hooks:** after `setup-hooks`, **pre-commit** runs `bun run check`; **pre-push** runs `bun install --frozen-lockfile`, `bun run build`, `bun run check`, and `bun run test` (same order as CI). Set **`SKIP_GIT_HOOKS=1`** to bypass.

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests and pushes to `main`: **`actions/setup-node` with Node 24** (minimum 22 asserted), then `bun install --frozen-lockfile`, `bun run build`, `bun run check`, `bun run test`. Follow-up **`prerelease-pack`** job runs `npm pack` and uploads a prerelease `.tgz` artifact (retention 90 days).

## Publishing

### GitHub (automated) — version tags only

Tag pushes run [`.github/workflows/release.yml`](.github/workflows/release.yml): build, check, tests, then:

1. **`npm pack`** using the committed **`package.json`** name [`@rethunk/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp) — tarball attached to a **GitHub Release** for that tag.
2. **GitHub Packages** (npm registry): workflow temporarily rewrites name to **`@rethunk-ai/github-mcp`** (required scope for org `Rethunk-AI`) and runs `npm publish` to `https://npm.pkg.github.com` with `GITHUB_TOKEN`.

Prerequisite: push a semver git tag `vX.Y.Z` that **exactly matches** `version` in `package.json`.

### npmjs (manual) — maintainers only

1. On a clean checkout at the release commit, run `bun run prepublishOnly`.
2. Log in: `npm login` so `npm whoami` shows the account that owns `@rethunk` on npmjs.
3. Ensure `package.json` has `"name": "@rethunk/github-mcp"` and `publishConfig.access` is `"public"`.
4. Publish: `npm publish --access public`.

**`package.json` `files`** must keep the whole `dist/` directory so every emitted chunk is packed.
