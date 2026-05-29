# @rethunk/github-mcp

[![CI](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/rethunk-github-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rethunk/github-mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@rethunk/github-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Rollup GitHub tools over MCP** — high-value GitHub reads and writes packaged as concise MCP tools for agents. The server focuses on composite operations that replace several API round-trips with one call.

**npm:** [`@rethunk/github-mcp`](https://www.npmjs.com/package/@rethunk/github-mcp) · **GitHub Packages (on each tag):** [`@rethunk-ai/github-mcp`](https://github.com/Rethunk-AI/rethunk-github-mcp/packages) — see [docs/install.md](docs/install.md) and [HUMANS.md](HUMANS.md) Publishing.

## Tool surface

### Read-only analysis tools

| Tool | What it does |
| ------ | ------------- |
| **`repo_status`** | Multi-repo dashboard: branch HEAD, CI, PRs, issues, latest commit — up to 64 repos in one call |
| **`my_work`** | Cross-repo personal queue: your open PRs, review requests, assigned issues; `blockedOnMe` lens for action items |
| **`pr_preflight`** | Pre-merge safety check: mergeable, reviews, CI, behind-base, commit granularity, computed `safe` verdict; batch-capable |
| **`release_readiness`** | What would ship now: unreleased commits, associated PRs, CI on head, diff stats, and release-asset checksum coverage |
| **`ci_diagnosis`** | Why is CI red: failed run logs (tail-truncated), trigger commit, run URL |
| **`org_pulse`** | Org-wide dashboard: failing CI, stale PRs, unreviewed PRs across recently active repos |
| **`pin_drift`** | Audit upstream pins in a local repo: how far are go.mod, submodule, versions.env, and package.json pins behind upstream? |
| **`ecosystem_activity`** | Merged commit feed across multiple repos since a given timestamp or `"48h"` / `"7d"` duration |
| **`module_pin_hint`** | Return the correct Go pseudo-version string (`v0.0.0-YYYYMMDDHHMMSS-sha12`) for any repo ref |
| **`changelog_draft`** | Draft a `CHANGELOG.md` section for unreleased commits, grouped by PR metadata |
| **`gh_auth_status`** | Check whether the server currently has usable GitHub credentials |
| **`actions_runs_filter`** | List and filter GitHub Actions runs by workflow, status, conclusion, and branch |
| **`security_alerts`** | Roll up Dependabot and Code Scanning alerts by severity across a repository |
| **`branch_protection_status`** | Check branch protection rules for a branch (defaults to the repo default branch) |
| **`deployment_status`** | Check deployment status and latest state per environment |
| **`issue_dedup`** | Find likely-duplicate issues by title similarity before opening a new one |

### Write-capable GitHub tools

| Tool | What it does |
| ------ | ------------- |
| **`pr_comment_batch`** | Submit a single PR review with inline comments in one call |
| **`pr_create`** | Open a pull request from an existing head branch |
| **`issue_from_template`** | Create an issue by rendering a repository issue template |
| **`release_create`** | Create a GitHub release, optionally asking GitHub to generate notes |
| **`workflow_dispatch`** | Trigger a GitHub Actions workflow_dispatch event |
| **`labels_sync`** | Converge a repository's labels to a declared set |
| **`check_run_create`** | Publish a synthetic check run against a commit SHA |
| **`pr_review_thread_ops`** | List, resolve, or unresolve PR review threads; `resolveOutdated` bulk-resolves outdated threads |

Read-only rollup tools default to compact JSON and usually accept `format: "markdown"` for human-readable output. Write-capable tools always return compact JSON and mutate GitHub state.

Local-repo read tools (`repo_status`, `pr_preflight`, `pin_drift`, `ecosystem_activity`) follow the active MCP workspace root when the client exposes roots support, so one global install can target whichever repository is currently open.

## Documentation

| Doc | Audience |
| ----- | ---------- |
| **[docs/install.md](docs/install.md)** | Client wiring, stdio config shape, prerequisites, troubleshooting |
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Canonical tool ids, parameters, JSON shapes, error codes, idempotency |
| **[HUMANS.md](HUMANS.md)** | Operator guide: auth, quick start, common operations, publishing |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Dev setup, verification commands, hooks, PR checklist |
| **[AGENTS.md](AGENTS.md)** | LLM and contributor implementation map, contracts, CI/release notes |
| **[SECURITY.md](SECURITY.md)** | Vulnerability disclosure, token-risk model, secure operating guidance |
| **[TODO.md](TODO.md)** | Remaining feature backlog only |
| **[specs/README.md](specs/README.md)** | Spec workflow entrypoints and current active/done/parked state |
