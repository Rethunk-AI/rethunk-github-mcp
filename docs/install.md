# Installing @rethunk/github-mcp

This package is an MCP **stdio** server. The client starts the process and communicates over stdin/stdout.

**See also:** [mcp-tools.md](mcp-tools.md) (tool ids, parameters, JSON shapes), [HUMANS.md](../HUMANS.md) (dev, CI, publishing), [AGENTS.md](../AGENTS.md) (contributors).

## Table of contents

- [Prerequisites](#prerequisites)
- [GitHub Packages](#github-packages)
- [Ways to run the binary](#ways-to-run-the-binary)
- [Configuration shape (stdio)](#configuration-shape-stdio)
- [Cursor](#cursor)
- [Visual Studio Code (GitHub Copilot)](#visual-studio-code-github-copilot)
- [Claude Desktop](#claude-desktop)
- [Zed](#zed)
- [Other clients and CLIs](#other-clients-and-clis)
- [From source (this repository)](#from-source-this-repository)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **GitHub token:** All tools require a GitHub personal access token. Set **`GITHUB_TOKEN`** or **`GH_TOKEN`** in the environment, or have **`gh`** CLI authenticated (`gh auth login`). Required scopes: **`repo`** (for private repos), **`read:org`** (for `org_pulse`). See [mcp-tools.md](mcp-tools.md#authentication).
- **Node.js >= 22** if you use **`npx`**, or **Bun** if you use **`bunx`** / **`bun`** (see `package.json` `engines` / `packageManager`).

## GitHub Packages

Every **version tag** on this repo is published to the **GitHub npm registry** as **`@rethunk-ai/github-mcp`** (scope matches the GitHub org). The **npmjs** package name **`@rethunk/github-mcp`** is updated **manually** by maintainers and may lag; prefer GitHub Packages for CI-aligned installs.

1. Create a [GitHub personal access token](https://github.com/settings/tokens) with at least **`read:packages`**.
2. In **`~/.npmrc`** or the project **`.npmrc`** (do not commit secrets):

   ```ini
   @rethunk-ai:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
   ```

3. Install or run:

   ```bash
   npx -y @rethunk-ai/github-mcp
   ```

## Ways to run the binary

Confirm the package runs (each starts the stdio server until EOF). **npmjs** name:

```bash
npx -y @rethunk/github-mcp
bunx @rethunk/github-mcp
npm install -g @rethunk/github-mcp && rethunk-github-mcp
```

**GitHub Packages** name (after configuring `.npmrc`):

```bash
npx -y @rethunk-ai/github-mcp
bunx @rethunk-ai/github-mcp
```

Published entrypoint: **`dist/server.js`** (see `bin` / `exports`).

## Configuration shape (stdio)

Across clients you always provide:

- A **command** (e.g. `npx`, `bunx`, `bun`, `node`).
- **Arguments** that resolve to this package's server.
- An **`env`** block with your GitHub token.

Register the server under a stable name (this documentation uses **`rethunk-github`**). Tools appear as `{serverName}_{toolName}` (e.g. `rethunk-github_repo_status`).

## Cursor

**User scope:** `~/.cursor/mcp.json`. **Project scope:** `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "rethunk-github": {
      "command": "npx",
      "args": ["-y", "@rethunk/github-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

After editing, reload MCP (Command Palette: reload / restart MCP).

## Visual Studio Code (GitHub Copilot)

**`.vscode/mcp.json`** or user MCP config (Command Palette: **MCP: Open User Configuration**):

```json
{
  "servers": {
    "rethunk-github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rethunk/github-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Claude Desktop

Config file (create if missing):

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "rethunk-github": {
      "command": "npx",
      "args": ["-y", "@rethunk/github-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "rethunk-github": {
      "command": "npx",
      "args": ["-y", "@rethunk/github-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Other clients and CLIs

Any MCP host that supports **stdio** can use the same **command / args / env** pattern. Map:

- **Command:** `npx` (or `bunx`, `node`, etc.)
- **Args:** e.g. `["-y", "@rethunk/github-mcp"]`
- **Env:** `{ "GITHUB_TOKEN": "..." }`

Official protocol overview: [modelcontextprotocol.io](https://modelcontextprotocol.io/).

## From source (this repository)

For contributors working inside a clone of [rethunk-github-mcp](https://github.com/Rethunk-AI/rethunk-github-mcp):

1. **Dependencies, build, and CI parity:** **[HUMANS.md](../HUMANS.md)** — *Development*.
2. **Run the dev server** (no `dist/` required): `GITHUB_TOKEN=ghp_... bun src/server.ts` (stdio MCP).

**MCP registration for a local checkout:** this repo ships `.cursor/mcp.json` using `bun` + `["src/server.ts"]`; open the workspace at the repository root.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `github_auth_missing` | Set `GITHUB_TOKEN` or `GH_TOKEN` in the `env` block of your MCP config, or run `gh auth login`. |
| Tools missing / stale | Restart the MCP host or use its "reload MCP / reset tools" action. |
| `npx` / `bun` not found | Install Node >= 22 or Bun; use full paths in config if `PATH` is minimal. |
| `org_not_found` | Verify the org login; the token needs `read:org` scope for org access. |
| Rate limits | GitHub API has rate limits (5,000/hr REST, 5,000 points/hr GraphQL). Reduce `maxRepos`/`maxResults` if hitting limits. |
| GitHub Enterprise | Set `GITHUB_API_URL` (and optionally `GITHUB_GRAPHQL_URL`) in the `env` block. |
