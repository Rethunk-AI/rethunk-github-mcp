# TODO / Feature requests — rethunk-github MCP

Feature asks driven by real pain points from agent sessions. Each item lists the motivating scenario and the expected tool shape.

## High value

### `release_create` MCP tool

**Pain:** fedbuild workflow produces image + RPM + SBOM (CycloneDX + SPDX) + SLSA provenance + SHA256SUMS + signatures (.sig + .pem). Publishing a release today is `gh release create` in Bash with ~10 `--attach` flags — verbose, error-prone, hits sandbox edge cases.

**Ask:**

```ts
release_create({
  repo: "Rethunk-AI/fedbuild",  // optional; defaults to current
  tag: "v0.6.0",
  name?: "Release 0.6.0",
  notes?: string,               // body; if omitted, pulls latest CHANGELOG.md section
  notesFromChangelog?: boolean, // true → grabs [version] section from CHANGELOG.md
  artifacts: Array<{
    path: string,               // local path
    label?: string,             // display name
    contentType?: string
  }>,
  draft?: boolean,
  prerelease?: boolean,
  // Signing metadata — if provided, surfaces in release body as a verification block:
  signatures?: Array<{
    artifact: string,           // path or label
    sigFile: string,
    certFile?: string,
    type: "cosign-keyless" | "gpg" | "slsa-provenance"
  }>
})
// Returns: { url, uploadedArtifacts: [{ path, downloadUrl, size }] }
```

Optional nicety: `verificationBlock: "auto"` auto-injects a block like `cosign verify-blob --cert ...` template into the notes.

### `pr_preflight` — extend with commit-granularity check

**Pain:** Parallel subagents sometimes bundle commits (sandbox blocks splitting). Current `pr_preflight` doesn't flag "this PR has a 500-line commit that should have been 3 commits".

**Ask:** Add a `commitGranularity` check:
- Flags commits where diff spans 3+ distinct files with unrelated Conventional Commit types
- Flags commits whose subject mentions multiple concerns (e.g. both "feat" and "fix")

Output: advisory, not blocking.

### `workflow_dispatch` MCP tool

**Pain:** Some build steps need a beefier runner than Claude's sandbox (e.g. fedbuild's `make image` needs 20 min + sudo + KVM). Users want to kick off a `workflow_dispatch` on a self-hosted runner and stream status. Today: Bash `gh workflow run ... --ref main -F ...`.

**Ask:**

```ts
workflow_dispatch({
  repo?: string,
  workflow: "release.yml",      // filename or workflow_id
  ref: "main",
  inputs?: Record<string, string>,
  watch?: boolean,              // if true, polls until completion; returns final conclusion
  timeoutSec?: 3600
})
// Returns: { runId, url, conclusion?: "success" | "failure" | "cancelled", logs?: string }
```

### `pr_comment_batch` MCP tool

**Pain:** Line-by-line PR review comments today require multiple `gh api` Bash calls. Agents reviewing PRs waste tokens on the REST shape.

**Ask:**

```ts
pr_comment_batch({
  repo?: string,
  pr: number,
  reviewBody?: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  comments: Array<{
    path: string,
    line: number,
    body: string,
    side?: "LEFT" | "RIGHT"
  }>
})
```

One round-trip, submits as a single review.

## Medium value

### `pr_create_from_commits` MCP tool

**Pain:** After a parallel-subagent batch merges to main, sometimes user wants to open a PR for review instead of pushing. Today: `git push -u origin feature`, `gh pr create --title "..." --body "..."`. Want one call.

**Ask:**

```ts
pr_create({
  repo?: string,
  branch: string,               // local branch to push and open PR from
  base: "main",
  title: string,
  body?: string,
  bodyFromCommits?: boolean,    // generates body from Conventional Commit messages
  draft?: boolean,
  labels?: string[],
  reviewers?: string[],
  autoMerge?: "merge" | "squash" | "rebase"
})
```

### `release_readiness` — extend with artifact integrity check

**Pain:** User runs `release_readiness` today, gets "yes ready". Then discovers the uploaded SBOM is from a prior build. Want tool to verify: does SHA256SUMS cover all artifacts in the release?

**Ask:** Add `artifactIntegrity: "verify"` option: pulls attached release artifacts, recomputes sha256, diffs against the signed SHA256SUMS manifest, reports mismatches.

### `issue_from_template` MCP tool

**Pain:** Filing a drift or incident report means composing the body by hand. Repo has issue templates; tool should use them.

**Ask:**

```ts
issue_create({
  repo?: string,
  template?: "bug.yml" | "drift.yml" | "incident.yml",
  title: string,
  fields: Record<string, string>,  // mapped to template fields
  labels?: string[]
})
```

### `check_run_create` MCP tool

For CI systems that want to post synthetic check runs (e.g. a subagent that runs security review and posts pass/fail as a GH check).

## Low value — nice to have

### `gh_auth_status` MCP tool

Wrap `gh auth status` + token scope inspection. Useful for pre-flight before release/push operations.

### `actions_workflow_list` / `actions_runs_filter`

Structured query: `runs_filter({ repo, workflow, status: "failure", since: "24h", branch?: "main" })`. Avoids multiple `gh run list` invocations.

### `labels_sync` MCP tool

Sync a repo's labels to a declared set (idempotent). Useful for org-wide label hygiene.

## Non-tool asks

### Batch endpoints use server-side parallelism

When a tool takes an array (e.g. `pr_comment_batch`), execute requests in parallel server-side. Agents already think of batch calls as atomic; network fan-out should happen once, not per-comment.
