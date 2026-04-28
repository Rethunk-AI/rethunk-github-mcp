# Security Policy

## Reporting Security Vulnerabilities

**DO NOT** open a public GitHub issue for security vulnerabilities. Instead, please report them responsibly to:

**Email:** security@rethunk.tech  
**Response SLA:** We aim to respond to security reports within 24 hours.

When reporting a vulnerability, please include:
- Description of the vulnerability
- Affected component(s) and version(s)
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (optional)

## Scope & Risk Profile

`rethunk-github-mcp` is an MCP server that exposes GitHub API operations to LLMs. It has elevated security implications due to API access and batch operations.

### GitHub API Authentication
- **Critical:** Server authenticates with GitHub via personal access token or app credentials
- Tokens must never be embedded in code or logs
- Environment variables (GITHUB_TOKEN) require protection
- Token scopes should be limited to minimum required operations

### API Rate Limiting & Abuse Risk
- **High:** MCP tools batch multiple API calls; potential for rapid rate limit exhaustion
- Tools like `repo_status` and `ecosystem_activity` can execute 10-50+ API calls per invocation
- Implement rate-limit detection and backoff in client code
- Monitor for unusual token usage patterns

### Data Exposure Risk
- **Medium:** Sensitive repo/org data (private repo names, CI logs, secret patterns in code) could be exposed
- All tool outputs should be treated as potentially sensitive
- Do not expose in logs or error messages
- Validate all inputs to prevent API injection attacks

### Cross-Org / Multi-Repo Access
- **High:** Tools operate across multiple repos and orgs if configured
- Ensure token scopes do not exceed intended access
- Validate repo access before returning sensitive data
- Be mindful of PR labels, commit messages, CI logs that may contain secrets

## Security Practices

### Token Management
- Use GitHub Personal Access Tokens (PAT) or App credentials
- Never commit tokens; use environment variables only
- Rotate tokens regularly
- Use minimal scopes (e.g., `repo:read` for read-only tools)
- Monitor token usage via GitHub's audit log

### API Call Safety
- Validate all input parameters (repo names, branch names, etc.)
- Implement exponential backoff for rate limit 429 responses
- Set timeouts on API calls to prevent hanging
- Log API calls (without exposing tokens) for audit trails

### Output Validation
- Do not expose raw GitHub API responses without review
- Sanitize error messages (don't expose token leakage)
- Be mindful of CI logs, commit messages that may contain secrets
- Trim log output if suspiciously long

### Dependency Management
- Keep `octokit` and related GitHub API packages up-to-date
- Run `bun audit` regularly; address high/critical vulnerabilities
- Review major version updates for API contract changes

## Supported Versions

Latest release only.

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ Yes    |
| < 1.0   | ⚠️ Limited|

## Known Vulnerabilities

None currently known. Reports are welcome via security@rethunk.tech.

## Third-Party Security

### GitHub API
- Octokit SDK is official GitHub SDK; generally secure but monitor updates
- Review GitHub API changelog for breaking changes and security fixes
- Be aware of GitHub's own abuse prevention and rate limiting

### Dependencies
- Bun runtime: keep updated for security patches
- octokit/rest, octokit/graphql: official libraries, monitor for updates
- TypeScript: type safety helps prevent runtime issues

## Testing & Validation

- Test tools with read-only tokens before production deployment
- Validate rate limit handling with heavy multi-repo queries
- Test error handling with invalid repos/tokens
- Do not test against production tokens; use a test token with limited access

## Incident Response

If a security vulnerability is discovered:

1. **Report immediately** to security@rethunk.tech (do not disclose publicly)
2. **Include reproduction steps** and affected version(s)
3. **Allow 24-48 hours** for initial response and triage
4. **Coordinate disclosure** timeline if patch is required
5. **Credit will be given** to the reporter (if desired)

## Contact

- **Security Issues:** security@rethunk.tech
- **General Support:** support@rethunk.tech
- **Website:** https://rethunk.tech

---

**Last updated:** 2026-04-27
