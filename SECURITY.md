# Security Policy

## Reporting Security Vulnerabilities

**DO NOT** open a public GitHub issue for security vulnerabilities. Report them responsibly to [security@rethunk.tech](mailto:security@rethunk.tech).

**Response SLA:** We aim to respond to security reports within 24 hours.

When reporting a vulnerability, please include:

- Description of the vulnerability
- Affected component(s) and version(s)
- Steps to reproduce, if applicable
- Potential impact
- Suggested fix, if available

## Scope & Risk Profile

`rethunk-github-mcp` is an MCP server that exposes GitHub API operations to LLMs. It has elevated security implications due to API access, cross-repo visibility, and write-capable automation.

### GitHub API Authentication

- **Critical:** The server authenticates with GitHub via personal access token or app credentials.
- Tokens must never be embedded in code or logs.
- Environment variables such as `GITHUB_TOKEN` require protection.
- Token scopes should be limited to the minimum required operations.
- Prefer separate tokens for read-only rollups vs. write-capable automation.

**Scope requirements by tool category:**

| Category | Minimum scope |
| -------- | ------------- |
| Basic read rollups (`repo_status`, `my_work`, etc.) | `repo` (read) |
| `org_pulse` | `repo` + `read:org` |
| `security_alerts` | `security_events` read (or `repo`) |
| `branch_protection_status` | repository admin or `repo` |
| `deployment_status` | `repo` (deployments read) |
| `issue_dedup` | `repo` (issues read) |
| `pr_review_thread_ops` (resolve/unresolve) | `repo` or `pull_requests:write` |
| Write-capable tools (`pr_create`, `release_create`, etc.) | `repo` (full) |

### API Rate Limiting & Abuse Risk

- **High:** MCP tools batch multiple API calls; rapid rate-limit exhaustion is possible.
- Tools such as `repo_status` and `ecosystem_activity` can execute many API calls per invocation.
- Implement rate-limit detection and backoff in client code.
- Monitor for unusual token usage patterns.

### Data Exposure Risk

- **Medium:** Sensitive repo or org data, including private repository names and CI logs, could be exposed.
- Treat all tool outputs as potentially sensitive.
- Do not expose raw upstream data in logs or error messages.
- Validate all inputs to prevent API-injection style abuse.

### Write-Capable Mutation Risk

- **High:** Some tools create or mutate GitHub state: `pr_create`, `pr_comment_batch`, `issue_from_template`, `release_create`, `workflow_dispatch`, `labels_sync`, `check_run_create`, and `pr_review_thread_ops`.
- `pr_review_thread_ops` (resolve/unresolve) mutates PR review threads and requires PR write scope. `action=list` is read-only in effect.
- Accidental or repeated calls can create duplicate PRs, issues, reviews, releases, workflow runs, or check runs.
- Use least-privilege tokens and prefer test repositories for first-time validation.
- Treat write-capable tokens as operational credentials with tighter blast-radius controls than read-only rollups.

### Cross-Org / Multi-Repo Access

- **High:** Tools operate across multiple repos and orgs if configured.
- Ensure token scopes do not exceed intended access.
- Validate repo access before returning sensitive data.
- Be mindful of PR labels, commit messages, and CI logs that may contain secrets.

## Security Practices

### Token Management

- Use GitHub personal access tokens or app credentials.
- Never commit tokens; use environment variables only.
- Rotate tokens regularly.
- Keep read-only and write-capable tokens separate when possible.
- Monitor token usage through GitHub audit logs.

### API Call Safety

- Validate all input parameters such as repo names, refs, and workflow identifiers.
- Implement exponential backoff for rate-limit responses.
- Set timeouts on API calls to prevent hanging.
- Log API calls without exposing tokens.

### Output Validation

- Do not expose raw GitHub API responses without review.
- Sanitize error messages so tokens and other secrets cannot leak.
- Be mindful of CI logs and commit messages that may contain sensitive material.
- Trim suspiciously large outputs.

### Mutation Safety

- Prefer idempotent write tools where available; `labels_sync` converges to a declared state.
- For non-idempotent tools, assume retries may create additional state and confirm inputs before re-running.
- Use branch protections, repository permissions, and GitHub audit logs as defense in depth.

### Dependency Management

- Keep `octokit` and related GitHub API packages up to date.
- Run `bun audit` regularly and address high or critical vulnerabilities.
- Review major version updates for API contract changes.

## Supported Versions

Latest release only.

| Version | Supported |
| ------- | --------- |
| 1.x | Yes |
| < 1.0 | Limited |

## Known Vulnerabilities

None currently known. Reports are welcome via [security@rethunk.tech](mailto:security@rethunk.tech).

## Third-Party Security

### GitHub API

- Octokit SDK is the official GitHub SDK; monitor it for updates.
- Review the GitHub API changelog for breaking changes and security fixes.
- Be aware of GitHub's own abuse prevention and rate limiting.

### Dependencies

- Keep the Bun runtime updated for security patches.
- Monitor `@octokit/rest` and `@octokit/graphql` releases.
- Keep TypeScript current; stronger typing reduces avoidable runtime mistakes.

## Testing & Validation

- Test read-only tools with read-only tokens before production deployment.
- Test write-capable tools against a throwaway or explicitly approved repository before production use.
- Validate rate-limit handling with heavy multi-repo queries.
- Test error handling with invalid repos or tokens.
- Do not test against production tokens; use a limited-scope test credential.

## Incident Response

If a security vulnerability is discovered:

1. Report immediately to [security@rethunk.tech](mailto:security@rethunk.tech) and do not disclose publicly.
2. Include reproduction steps and affected version(s).
3. Allow 24-48 hours for initial response and triage.
4. Coordinate a disclosure timeline if a patch is required.
5. Credit will be given to the reporter if desired.

## Contact

- **Security Issues:** [security@rethunk.tech](mailto:security@rethunk.tech)
- **General Support:** [support@rethunk.tech](mailto:support@rethunk.tech)
- **Website:** [rethunk.tech](https://rethunk.tech)

---

**Last updated:** 2026-05-07
