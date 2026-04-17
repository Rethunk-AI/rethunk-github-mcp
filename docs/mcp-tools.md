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
| `pin_drift` | `rethunk-github_pin_drift` | Audit upstream dependency pins in a local repo: how far is each go.mod/submodule/versions.env/package.json pin behind the upstream default branch? |
| `ecosystem_activity` | `rethunk-github_ecosystem_activity` | Merged chronological commit feed across multiple repos since a given timestamp or relative duration (e.g. `48h`). |
| `module_pin_hint` | `rethunk-github_module_pin_hint` | Return the Go pseudo-version string (`v0.0.0-YYYYMMDDHHMMSS-sha12`) for any repo ref. |

All tools are **read-only** (`readOnlyHint: true`). Pass **`format: "json"`** for structured JSON instead of markdown (default).

## JSON responses

Payloads are minified (`JSON.stringify`, no pretty-print). `MCP_JSON_FORMAT_VERSION` is **`"2"`**. Optional fields are omitted when empty/null.

### Error envelope

Tool-level failures return a top-level `error` object:

```jsonc
{
  "error": {
    "code": "NOT_FOUND",
    "message": "PR Rethunk-AI/github-mcp#42 not found.",
    "retryable": false,
    "suggestedFix": "Verify the PR number."  // optional
  }
}
```

Per-item failures (inside arrays like `repos[]` or `pins[]`) follow the same envelope shape in the item's `error` field. The batch does not fail as a whole when a per-item failure occurs.

Agents can decide programmatically whether to retry (e.g. exponential backoff on `retryable: true`) vs. surface the problem to the user (`retryable: false`).

### Error codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| `AUTH_MISSING` | No `GITHUB_TOKEN`/`GH_TOKEN` and `gh auth token` failed. | no |
| `AUTH_FAILED` | GitHub rejected the token (HTTP 401). | no |
| `NOT_FOUND` | Repository, PR, org, ref, or workflow run does not exist (HTTP 404). | no |
| `PERMISSION_DENIED` | Token lacks scopes or repo access (HTTP 403, not rate limit). | no |
| `RATE_LIMITED` | GitHub rate limit exhausted (HTTP 403 + `x-ratelimit-remaining: 0`). `suggestedFix` includes the reset time. | **yes** |
| `VALIDATION` | Request failed GitHub's input validation (HTTP 422). | no |
| `UPSTREAM_FAILURE` | GitHub 5xx or GraphQL-level error. | **yes** |
| `NO_CI_RUNS` | No workflow runs found for the given ref/PR (`ci_diagnosis`). | no |
| `COMPARE_FAILED` | Reserved: `base...head` comparison failure distinct from a 404. | no |
| `LOCAL_REPO_NO_REMOTE` | Local path has no resolvable GitHub `origin` remote. | no |
| `UNSUPPORTED_LANGUAGE` | `module_pin_hint` was called with a `language` other than `"go"`. | no |
| `AMBIGUOUS_REPO` | Reserved: pin source does not encode which GitHub repo a value belongs to. | no |
| `INTERNAL` | Unrecognized/unexpected failure. | no |

### Idempotency

All current tools are **read-only** (`readOnlyHint: true`) and therefore idempotent: calling any tool twice with the same arguments is equivalent to calling it once. There is no server-side state mutation. Safe to retry transparently on `RATE_LIMITED` or `UPSTREAM_FAILURE`.

Future write-capable tools (e.g. a proposed `release_create`) will document their idempotency semantics explicitly in this section.

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
    // "error": { "code": "NOT_FOUND", "message": "...", "retryable": false }
    //   — on per-repo failure (does not fail the batch)
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

### `pin_drift`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `localPath` | `string` | yes | — | Absolute path to the local repo whose dependency pins to audit. |
| `pinFiles` | `string[]` | no | auto-detect | Files to parse. Auto-detection tries: `go.mod`, `.gitmodules`, `scripts/versions.env`, `package.json`. |
| `ownerAllowlist` | `string[]` | no | — | Only audit pins whose GitHub owner matches one of these values (case-insensitive). Useful to skip third-party upstreams. |
| `grep` | `string` | no | — | Regex filter: only commits whose message matches are counted in `grepMatches`. All commits still count toward `behindBy`. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "localPath": "/home/me/myapp",
  "pins": [{
    "source": "go.mod",
    "owner": "Rethunk-Tech",
    "repo": "bastion-satcom",
    "pinnedRef": "877f8d94448e",
    "pinnedDate": "2026-04-11T12:22:16Z",
    "defaultBranch": "main",
    "headSha": "6589cad7c93e5fd59ece17284b4636c525bf8cf0",
    "behindBy": 17,
    "grepMatches": 3,           // only when grep supplied
    "commits": [{ "sha7": "abc1234", "message": "Fix bug", "author": "alice", "date": "2026-04-12T..." }],
    "stale": true
  }],
  "skipped": [{
    "source": "scripts/versions.env",
    "key": "BASTION_SATCOM_REF",
    "value": "877f8d94448e8cc843e83409dd0a59bb73562e45",
    "reason": "ambiguous_repo"
  }],
  "summary": { "totalPins": 4, "stale": 2, "upToDate": 2 }
}
```

**Pin source notes:**

- `go.mod`: handles `replace` directives and `require` lines with pseudo-versions (`v0.0.0-YYYYMMDDHHMMSS-sha12`). The 12-char SHA prefix is resolved to a full SHA via the GitHub API.
- `.gitmodules`: reads submodule paths + URLs, uses `git ls-tree HEAD <path>` to obtain the pinned commit SHA.
- `scripts/versions.env`: shell `KEY=VALUE` lines whose key ends in `_REF`, `_SHA`, or `_VERSION` and whose value is a 40-char hex SHA. These are always reported under `skipped` with `reason: "ambiguous_repo"` because the file does not encode which GitHub repo each key belongs to.
- `package.json`: `dependencies`/`devDependencies` whose version is a GitHub shorthand (`owner/repo#ref`) or HTTPS GitHub URL.

`behindBy: -1` signals an error resolving that pin. When this happens the pin entry also carries an `error: { code, message, retryable, suggestedFix? }` field explaining why (e.g. `NOT_FOUND`, `RATE_LIMITED`, `UPSTREAM_FAILURE`).

`skipped[].reason` remains a free-text parser-level code (`ambiguous_repo`, `ambiguous_ref`, `not_github`, `ls_tree_no_sha`, `ls_tree_failed`) — it describes a pin that couldn't be parsed at all, not a GitHub-side error.

---

### `ecosystem_activity`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repos` | `(RepoRef \| LocalPath)[]` | yes | — | 1–20 repos. Each is `{ owner, repo }` or `{ localPath }`. |
| `since` | `string` | yes | — | ISO8601 timestamp or relative duration: `"48h"`, `"7d"`. |
| `paths` | `string[]` | no | — | Filter to commits touching these paths (applied per repo via GraphQL `history(path:...)`). Multiple paths are OR'd together. |
| `grep` | `string` | no | — | Regex filter applied client-side to commit message subjects. |
| `maxCommitsPerRepo` | `int` | no | `50` | 1–200 commits fetched per repo before merge. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "since": "2026-04-10T17:19:40Z",
  "repos": [
    { "owner": "Rethunk-Tech", "repo": "bastion-satcom", "commitCount": 12 },
    {
      "owner": "Rethunk-AI",
      "repo": "some-lib",
      "commitCount": 0,
      "error": { "code": "NOT_FOUND", "message": "...", "retryable": false }
    }
  ],
  "commits": [{
    "owner": "Rethunk-Tech",
    "repo": "bastion-satcom",
    "sha7": "abc1234",
    "message": "Fix SATCOM reconnect",
    "author": "alice",
    "date": "2026-04-12T08:00:00Z",
    "pr": { "number": 42, "title": "Fix SATCOM reconnect" }  // null when no (#N) in message
  }],  // merged + sorted date desc
  "summary": {
    "totalCommits": 47,
    "repoBreakdown": { "bastion-satcom": 12, "some-lib": 35 }
  }
}
```

Commits are merged across repos and sorted newest-first. Per-repo errors do not fail the batch.

---

### `module_pin_hint`

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | yes | — | GitHub owner or organization. |
| `repo` | `string` | yes | — | GitHub repository name. |
| `ref` | `string` | no | default branch HEAD | Branch, tag, or SHA to resolve. |
| `language` | `string` | no | `"go"` | Module system. Only `"go"` is supported in MVP. |
| `format` | `"markdown" \| "json"` | no | `"markdown"` | Output format. |

**JSON output:**

```jsonc
{
  "owner": "Rethunk-Tech",
  "repo": "bastion-satcom",
  "ref": "main",
  "resolvedSha": "6589cad7c93e5fd59ece17284b4636c525bf8cf0",
  "committerDate": "2026-04-13T00:17:01Z",
  "goPseudoVersion": "v0.0.0-20260413001701-6589cad7c93e"
}
```

The pseudo-version is formatted as `v0.0.0-YYYYMMDDHHMMSS-<first12SHAchars>` using the committer date in UTC. Use this when pinning a module in `go.mod` via a SHA rather than a release tag.

---

## Authentication

All tools require a GitHub token. Resolution order:

1. `GITHUB_TOKEN` environment variable
2. `GH_TOKEN` environment variable (matches `gh` CLI convention)
3. `gh auth token` subprocess fallback (if `gh` CLI is installed and authenticated)

Set the token in the MCP client's `env` block. For GitHub Enterprise, set `GITHUB_API_URL` (and optionally `GITHUB_GRAPHQL_URL`).
