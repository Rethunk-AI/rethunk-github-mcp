# Contributing

Rethunk AI internal project. External PRs are not expected, but the process is documented for clarity.

## Prerequisites

- **Node.js ≥ 22** — see [docs/install.md](docs/install.md) *Prerequisites* for version notes.
- **Bun ≥ 1.3.13** (`packageManager` in `package.json`) — only needed to build and test from source.
- **Git ≥ 2.28**.

## Development setup

```bash
git clone https://github.com/Rethunk-AI/rethunk-github-mcp.git
cd rethunk-github-mcp
bun install
bun run build       # rimraf dist && tsc → dist/
bun run lint       # Biome lint + format check
bun run format   # auto-fix with Biome
bun run test        # bun test src/
bun run test:coverage  # coverage-threshold wrapper over Bun coverage (scripts/** ignored)
bun run ci  # release-time packaging and changelog sanity checks
bun run setup-hooks    # one-time per clone: wire .githooks/
```

## Git hooks

`bun run setup-hooks` sets `core.hooksPath = .githooks`.

| Hook | Runs |
| ------ | ------ |
| pre-commit | `bun run lint` + `bun run test` |
| pre-push | frozen install + build + check + test (mirrors CI) |

Set `SKIP_GIT_HOOKS=1` to bypass.

## Commit conventions

```text
type(scope): imperative summary ≤72 chars

Body explains WHY this change exists — motivation, context, constraints.
Not a file list. Not a summary of what the diff already shows.
```

| Type | When |
| ------ | ------ |
| `feat` | New capability |
| `fix` | Bug corrected |
| `docs` | Documentation only |
| `refactor` | No behaviour change |
| `test` | Test additions or fixes |
| `chore` | Maintenance, deps, tooling |
| `ci` | CI/CD config |
| `build` | Build system changes |

One logical unit per commit. Max ~7 files. Split by theme, not by file count.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on PRs and pushes to `main`:

1. `bun install --frozen-lockfile`
2. `bun run build`
3. `bun run lint` (Biome)
4. `bun run test:coverage` + 80% line coverage threshold assertion
5. Prerelease `npm pack` artifact uploaded (90-day retention)

Match the CI steps locally before opening a PR.

## Pull request checklist

- [ ] `bun run build` passes.
- [ ] `bun run lint` passes (no Biome errors).
- [ ] `bun run test` passes.
- [ ] Any new tool has a corresponding `*.test.ts` file.
- [ ] Public tool or auth/root behavior changes are reflected in `docs/mcp-tools.md`, `README.md`, `HUMANS.md`, and `AGENTS.md`.
- [ ] Closed feature asks are removed from `TODO.md` instead of left as historical notes.
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`.

## Adding a GitHub tool

1. Create `src/server/<tool-name>-tool.ts` exporting a `register<ToolName>Tool(server: FastMCP)` function.
2. Register it in `src/server/tools.ts` inside `registerRethunkGitHubTools`.
3. Add a test file `src/server/<tool-name>-tool.test.ts`.
4. Update [docs/mcp-tools.md](docs/mcp-tools.md) (tool ID, parameters, JSON shape, error codes, idempotency) plus the overview docs in [README.md](README.md) and [HUMANS.md](HUMANS.md).
5. Update [AGENTS.md](AGENTS.md) when the implementation map, tool list, or CI/release contract changes.
6. Follow contract-change rules in [AGENTS.md](AGENTS.md) — bump `MCP_JSON_FORMAT_VERSION` if the JSON envelope changes incompatibly.

## Code style

Enforced by **Biome** (`biome.json`): recommended rules, 100-char lines, double quotes, semicolons, trailing commas.

TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`. Avoid `any`; if genuinely necessary, add an inline comment explaining why.
