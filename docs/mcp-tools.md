# MCP tools (canonical reference)

Single source of truth for **registered tool ids**, **parameters**, **JSON output shapes**, and **error codes**.
**Install and MCP clients:** [install.md](install.md). **Dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation map:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-github`**, examples use the prefix **`rethunk-github_`**.

## Tools

| Short id | Client id (server `rethunk-github`) | Purpose |
|----------|--------------------------------------|---------|
| `repo_status` | `rethunk-github_repo_status` | Multi-repo dashboard: default branch HEAD, CI, open PRs/issues, latest commit. Up to 20 repos per call, optional local git state. |
| `my_work` | `rethunk-github_my_work` | Cross-repo personal queue: authored PRs, review requests, assigned issues. Single GraphQL query. |
| `pr_preflight` | `rethunk-github_pr_preflight` | Pre-merge safety check: mergeable, reviews, CI, behind-base, computed `safe` verdict with reasons. |
| `release_readiness` | `rethunk-github_release_readiness` | What would ship if we release now? Unreleased commits, associated PRs, CI on head, diff stats. |
| `ci_diagnosis` | `rethunk-github_ci_diagnosis` | Why is CI red? Resolves failed run, extracts failed job logs (tail-truncated), trigger commit. |
| `org_pulse` | `rethunk-github_org_pulse` | Org-wide activity dashboard: failing CI, stale PRs, unreviewed PRs across all recently-active repos. |

All tools are **read-only** (`readOnlyHint: true`). Pass **`format: "json"`** for structured JSON instead of markdown (default).

## JSON responses

Payloads are minified (`JSON.stringify`, no pretty-print). `MCP_JSON_FORMAT_VERSION` is **`"1"`**. Optional fields are omitted when empty/null.

### Error codes

| Code | Meaning |
|------|---------|
| `github_auth_missing` | No `GITHUB_TOKEN`/`GH_TOKEN` and `gh auth token` failed. |
| `not_found` | Repository, PR, or workflow run does not exist. |
| `no_ci_runs` | No workflow runs found for the given ref/PR. |
| `org_not_found` | GitHub organization does not exist or is inaccessible. |
| `local_repo_no_remote` | Local path has no resolvable GitHub `origin` remote. |
| `graphql_error` | Upstream GitHub GraphQL error (message included). |
| `compare_failed` | `base...head` comparison failed (bad ref, etc.). |
| `query_failed` | General API failure (message included). |
| `ci_diagnosis_failed` | Failed to resolve or diagnose the CI run. |

---

## Tool details

### `repo_status`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repos` | `(RepoRef \| LocalPath)[]` | yes | — | 1–20 repos. Each is `{ owner, repo }` or `{ localPath }`. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "repos": [{
    "owner": "org",
    "repo": "name",
    "defaultBranch": "main",
    "latestCommit": { "sha7": "abc1234", "message": "Fix bug", "author": "alice", "date": "2h ago" },
    "ci": { "status": "success", "failedChecks": [/* only if failing */] },
    "openPRs": 3,
    "draftPRs": 1,
    "openIssues": 12,
    "local": { "branch": "feature", "dirty": 2, "ahead": 1, "behind": 0 }
    // "error": "not_found" — on per-repo failure (does not fail the batch)
  }]
}
```

When `localPath` is given, the tool resolves the GitHub remote from `git remote get-url origin` and includes the `local` object with branch/dirty/ahead/behind.

---

### `my_work`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `username` | `string` | no | authenticated user | GitHub username to query. |
| `maxResults` | `int` | no | `30` | 1–100 results per section. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "username": "alice",
  "authoredPrs": [{ "repo": "org/name", "number": 42, "title": "...", "draft": false, "ci": "SUCCESS", "reviewDecision": "APPROVED", "updatedAt": "..." }],
  "reviewRequests": [{ "repo": "org/name", "number": 45, "title": "...", "author": "bob", "updatedAt": "..." }],
  "assignedIssues": [{ "repo": "org/name", "number": 99, "title": "...", "labels": ["bug"], "updatedAt": "..." }]
}
```

---

### `pr_preflight`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | yes | — | GitHub owner/org. |
| `repo` | `string` | yes | — | Repository name. |
| `number` | `int` | yes | — | PR number. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "number": 42,
  "title": "Fix auth bug",
  "safe": false,
  "reasons": ["CI failing: test-unit", "3 commits behind main"],
  "mergeable": "MERGEABLE",
  "reviewDecision": "APPROVED",
  "reviews": [{ "author": "alice", "state": "APPROVED" }],
  "pendingReviewers": ["charlie"],
  "ci": {
    "status": "FAILURE",
    "checks": [{ "name": "test-unit", "conclusion": "FAILURE", "status": "COMPLETED" }]
  },
  "behindBase": 3,
  "labels": ["bug"],
  "conflicts": false
}
```

The `safe` boolean is computed from: PR must be open, not a draft, no conflicts, approved or no required reviews, CI passing, no pending checks.

`reasons` lists all blockers and warnings. Warnings (e.g. behind base) do not set `safe: false` by themselves.

---

### `release_readiness`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | yes | — | GitHub owner/org. |
| `repo` | `string` | yes | — | Repository name. |
| `base` | `string` | yes | — | Base ref to compare from (e.g. `v1.2.0`). |
| `head` | `string` | no | default branch | Head ref to compare to. |
| `maxCommits` | `int` | no | `50` | 1–200 commits. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "base": "v1.2.0",
  "head": "main",
  "aheadBy": 15,
  "headCi": { "status": "success", "failedChecks": [] },
  "commits": [{
    "sha7": "abc1234",
    "message": "Fix auth bug",
    "author": "alice",
    "date": "2025-04-10T12:00:00Z",
    "pr": { "number": 42, "title": "Fix auth bug", "labels": ["bug"] }
  }],
  "stats": { "additions": 1234, "deletions": 567, "changedFiles": 23 }
}
```

PR associations are extracted from commit message `(#123)` patterns, then resolved via GraphQL (up to 20 PRs per batch).

---

### `ci_diagnosis`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | yes | — | GitHub owner/org. |
| `repo` | `string` | yes | — | Repository name. |
| `ref` | `string` | no | — | Branch or SHA. Finds latest run for this ref. |
| `prNumber` | `int` | no | — | PR number. Alternative to `ref`. |
| `runId` | `int` | no | — | Specific run ID. Highest priority. |
| `maxLogLines` | `int` | no | `150` | 10–500 lines of log output per job. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**Run resolution priority:** `runId` > `prNumber` > `ref` > latest failed run on default branch.

**JSON output:**

```jsonc
{
  "runId": 12345,
  "workflow": "CI",
  "conclusion": "failure",
  "branch": "main",
  "url": "https://github.com/org/repo/actions/runs/12345",
  "triggerCommit": { "sha7": "abc1234", "message": "Bump deps", "author": "alice" },
  "failedJobs": [{
    "name": "build",
    "conclusion": "failure",
    "failedSteps": [{ "name": "logs", "log": "... [last 150 lines] ..." }]
  }]
}
```

Logs are **tail-truncated** (last N lines kept) since failure output is at the bottom.

---

### `org_pulse`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `org` | `string` | yes | — | GitHub organization login. |
| `maxRepos` | `int` | no | `30` | 1–100 repos (ordered by most recently pushed). |
| `staleDays` | `int` | no | `7` | Days without activity before a PR is stale. |
| `includeArchived` | `boolean` | no | `false` | Include archived repositories. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "org": "my-org",
  "scannedRepos": 30,
  "summary": {
    "failingCI": 2,
    "stalePRs": 5,
    "unreviewedPRs": 3,
    "totalOpenPRs": 18,
    "totalOpenIssues": 42
  },
  "attention": [{
    "repo": "my-org/api",
    "ci": "failure",
    "openPRs": 4,
    "openIssues": 8,
    "stalePRs": [{ "number": 12, "title": "...", "author": "bob", "daysSinceUpdate": 14 }],
    "unreviewedPRs": [{ "number": 15, "title": "...", "author": "alice" }],
    "lastPush": "2025-04-09T08:00:00Z"
  }]
}
```

The `attention` array is sorted by urgency: failing CI repos first, then by stale PR count. Healthy repos (no failing CI, no stale/unreviewed PRs) are listed only in markdown mode.

---

## Authentication

All tools require a GitHub token. Resolution order:

1. `GITHUB_TOKEN` environment variable
2. `GH_TOKEN` environment variable (matches `gh` CLI convention)
3. `gh auth token` subprocess fallback (if `gh` CLI is installed and authenticated)

Set the token in the MCP client's `env` block. For GitHub Enterprise, set `GITHUB_API_URL` (and optionally `GITHUB_GRAPHQL_URL`).
