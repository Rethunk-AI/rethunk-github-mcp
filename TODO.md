# TODO / Feature requests — rethunk-github MCP

Feature asks driven by real pain points from agent sessions. This file is future-only: implemented items are removed instead of retained as history.

## High value

### `release_create` — attach artifacts and verification material

**Current state:** `release_create` exists and can create a release with tag/name/body/draft/prerelease plus GitHub-generated notes.

**Remaining pain:** fedbuild-style workflows still need a second step to upload image + RPM + SBOM + provenance + SHA256SUMS + signatures.

**Ask:** extend the tool with artifact attachments, changelog-driven notes, and optional verification-block generation.

### `workflow_dispatch` — watch mode and run resolution

**Current state:** `workflow_dispatch` exists and triggers the event successfully, but GitHub's 204 response means callers still need a follow-up query to find and watch the resulting run.

**Ask:** add `watch`, `timeoutSec`, and final-run resolution so one call can dispatch and observe the workflow outcome.

## Medium value

### `pr_create` — branch push and body generation helpers

**Current state:** `pr_create` opens a PR once the head branch already exists on GitHub.

**Remaining pain:** agents still need shell git to push a local branch first and often want the PR body generated from commit history.

**Ask:** extend the tool with optional branch push, body-from-commits generation, labels, reviewers, and auto-merge knobs.

## Breaking — needs a version decision before implementing

These change the public JSON contract (output shape) and would require an
`MCP_JSON_FORMAT_VERSION` bump plus coordinated consumer updates. Held out of the
additive enhancement sweep deliberately; they need an explicit go/no-go.

### Multi-repo parity for single-repo read tools

**Current state:** `repo_status`, `ecosystem_activity`, and `pr_preflight` accept a `LocalOrRemoteRepoSchema[]` array (up to `MAX_REPOS_PER_REQUEST`). `changelog_draft` and `release_readiness` extend `RepoRefSchema` and accept only one repo.

**Remaining pain:** agents cannot batch a changelog/readiness sweep across an org in one call.

**Ask:** accept `repos[]` on the single-repo read tools. Breaking because the top-level result becomes an array (or `{ repos: [...] }`) instead of a single object — decide whether to preserve the single-object shape when exactly one repo is passed, or bump the format version.

### Standardize the error-envelope nesting convention

**Current state:** tool-level failures return a top-level `{ error: {...} }`. Bulk tools (`repo_status`, `ecosystem_activity`) additionally carry a per-item `error` inside each repo result. The two patterns are not documented as a single rule.

**Ask:** ratify and document the convention — top-level `error` = whole-tool failure; nested `error` = per-item failure in a bulk result — and align any tool that diverges. Breaking only if any tool's current shape changes.

## Low value — nice to have

### `pr_comment_batch` — side and range support

**Current state:** `pr_comment_batch` posts a single review with inline comments on right-side line numbers.

**Ask:** add support for left-side comments, multi-line ranges, and newer review-comment fields GitHub exposes.

### `issue_from_template` — issue forms / YAML templates

**Current state:** `issue_from_template` works well for template files rendered as text with variable substitution.

**Ask:** support richer GitHub Issue Forms / YAML templates so field names and defaults can be filled structurally instead of as raw text substitution.

### `actions_runs_filter` — time-window filtering

**Current state:** `actions_runs_filter` filters by workflow, status, conclusion, branch, and limit.

**Ask:** add a `since` filter so recent-failure lookups do not require a second client-side timestamp pass.
