# @rethunk/github-mcp

[![CI](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rethunk/github-mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@rethunk/github-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Rollup GitHub tools over MCP** — high-value composite operations that batch many GitHub API calls into single MCP tool invocations with concise, LLM-optimized output. Not 1:1 API wrappers; each tool replaces 3-6 round-trips.

**npm:** [`@rethunk/github-mcp`](https://www.npmjs.com/package/@rethunk/github-mcp) · **GitHub Packages (on each tag):** [`@rethunk-ai/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp/packages) — see [docs/install.md](docs/install.md) and [HUMANS.md](HUMANS.md) Publishing.

## Tools

| Tool | What it does |
|------|-------------|
| **`repo_status`** | Multi-repo dashboard: branch HEAD, CI, PRs, issues, latest commit — up to 20 repos in one call |
| **`my_work`** | Cross-repo personal queue: your open PRs, review requests, assigned issues; `blockedOnMe` lens for action items |
| **`pr_preflight`** | Pre-merge safety check: mergeable, reviews, CI, behind-base, computed `safe` verdict; batch-capable |
| **`release_readiness`** | What would ship now: unreleased commits, associated PRs, CI on head, diff stats |
| **`ci_diagnosis`** | Why is CI red: failed run logs (tail-truncated), trigger commit, run URL |
| **`org_pulse`** | Org-wide dashboard: failing CI, stale PRs, unreviewed PRs across all active repos |
| **`pin_drift`** | Audit upstream pins in a local repo: how far is each go.mod/submodule/package.json pin behind upstream? |
| **`ecosystem_activity`** | Merged commit feed across multiple repos since a given timestamp or `"48h"` / `"7d"` duration |
| **`module_pin_hint`** | Return the correct Go pseudo-version string (`v0.0.0-YYYYMMDDHHMMSS-sha12`) for any repo ref |
| **`changelog_draft`** | Draft a CHANGELOG.md section for unreleased commits, grouped by PR label; auto-picks latest semver tag as base |

All tools are **read-only** and support **JSON** (default) or **markdown** output.

## Documentation

| Doc | Audience |
|-----|----------|
| **[docs/install.md](docs/install.md)** | Prerequisites, running the package, every supported MCP client, troubleshooting |
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Tool ids, parameters, JSON output shapes, error codes (canonical reference) |
| **[HUMANS.md](HUMANS.md)** | Auth, dev commands, CI, publishing |
| **[AGENTS.md](AGENTS.md)** | Contributors: implementation map, API strategy, contracts, CI |
