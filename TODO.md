# TODO / Feature requests — rethunk-github MCP

Feature asks driven by real pain points from agent sessions. This file is future-only: implemented items are removed instead of retained as history.

## High value

### `release_create` — attach artifacts and verification material

**Current state:** `release_create` exists and can create a release with tag/name/body/draft/prerelease plus GitHub-generated notes.

**Remaining pain:** fedbuild-style workflows still need a second step to upload image + RPM + SBOM + provenance + SHA256SUMS + signatures.

**Ask:** extend the tool with artifact attachments, changelog-driven notes, and optional verification-block generation.

## Medium value

### `pr_create` — branch push and body generation helpers

**Current state:** `pr_create` opens a PR once the head branch already exists on GitHub.

**Remaining pain:** agents still need shell git to push a local branch first and often want the PR body generated from commit history.

**Ask:** extend the tool with optional branch push, body-from-commits generation, labels, reviewers, and auto-merge knobs.
