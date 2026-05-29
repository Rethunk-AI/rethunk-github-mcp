import { describe, expect, test } from "bun:test";

import {
  buildCompactRepoStatus,
  formatCompactRepoStatusMarkdown,
  formatRepoStatusMarkdown,
  registerRepoStatusTool,
} from "./repo-status-tool.js";
import { MAX_REPOS_PER_REQUEST } from "./schemas.js";
import { captureTool } from "./test-harness.js";
import { timeAgo } from "./utils.js";

function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("timeAgo", () => {
  test("< 60s → now", () => {
    expect(timeAgo(msAgo(5_000))).toBe("now");
  });

  test("30 minutes → 30m ago", () => {
    expect(timeAgo(msAgo(30 * 60 * 1_000))).toBe("30m ago");
  });

  test("59 minutes → 59m ago", () => {
    expect(timeAgo(msAgo(59 * 60 * 1_000))).toBe("59m ago");
  });

  test("3 hours → 3h ago", () => {
    expect(timeAgo(msAgo(3 * 3_600 * 1_000))).toBe("3h ago");
  });

  test("2 days → 2d ago", () => {
    expect(timeAgo(msAgo(2 * 86_400 * 1_000))).toBe("2d ago");
  });

  test("6 days → 6d ago (not weeks)", () => {
    expect(timeAgo(msAgo(6 * 86_400 * 1_000))).toBe("6d ago");
  });

  test("2 weeks → 2w ago", () => {
    expect(timeAgo(msAgo(14 * 86_400 * 1_000))).toBe("2w ago");
  });
});

describe("formatRepoStatusMarkdown", () => {
  test("renders failing CI, draft PRs, and local state", () => {
    const text = formatRepoStatusMarkdown([
      {
        owner: "Rethunk-AI",
        repo: "rethunk-github-mcp",
        defaultBranch: "main",
        latestCommit: {
          sha7: "abc1234",
          message: "tighten status output",
          author: "damon",
          date: "2h ago",
        },
        ci: {
          status: "failure",
          failedChecks: [{ name: "Unit tests", conclusion: "FAILURE" }],
        },
        openPRs: 3,
        draftPRs: 1,
        openIssues: 5,
        local: { branch: "main", dirty: 0, ahead: 1, behind: 0 },
      },
    ]);

    expect(text).toContain("## Rethunk-AI/rethunk-github-mcp (main)");
    expect(text).toContain("Latest: `abc1234` tighten status output");
    expect(text).toContain("CI: failing: Unit tests");
    expect(text).toContain("PRs: 3 open (1 draft) · Issues: 5 open");
    expect(text).toContain("[Local: main, 0 dirty, 1 ahead / 0 behind]");
  });

  test("renders errors and missing CI", () => {
    const text = formatRepoStatusMarkdown([
      {
        owner: "Rethunk-AI",
        repo: "missing",
        error: {
          code: "NOT_FOUND",
          message: "Repository not found.",
          retryable: false,
        },
      },
      {
        owner: "Rethunk-AI",
        repo: "no-ci",
        openPRs: 0,
        openIssues: 0,
      },
    ]);

    expect(text).toContain("Error (NOT_FOUND): Repository not found.");
    expect(text).toContain("## Rethunk-AI/no-ci (?)");
    expect(text).toContain("CI: not configured");
  });
});

// ---------------------------------------------------------------------------
// compact output helpers (no API calls)
// ---------------------------------------------------------------------------

describe("buildCompactRepoStatus / formatCompactRepoStatusMarkdown", () => {
  const sampleResults = [
    {
      owner: "Rethunk-AI",
      repo: "alpha",
      openPRs: 3,
      draftPRs: 1,
      openIssues: 2,
      ci: { status: "failure", failedChecks: [{ name: "lint", conclusion: "FAILURE" }] },
      local: { branch: "main", dirty: 0, ahead: 0, behind: 2 },
    },
    {
      owner: "Rethunk-AI",
      repo: "beta",
      openPRs: 0,
      openIssues: 0,
      ci: { status: "success" },
    },
    {
      owner: "Rethunk-AI",
      repo: "missing",
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    },
  ];

  test("compact JSON: condensed shape, lacks verbose arrays, totals correct", () => {
    const compact = buildCompactRepoStatus(sampleResults);

    // totals
    expect(compact.totals.repos).toBe(3);
    expect(compact.totals.errors).toBe(1);
    expect(compact.totals.openPRs).toBe(3); // only non-error repos
    expect(compact.totals.failingChecks).toBe(1);

    // per-repo entries exclude error repos
    expect(compact.repos).toHaveLength(2);
    const alpha = compact.repos[0];
    if (!alpha) throw new Error("Expected alpha entry");
    expect(alpha.repo).toBe("Rethunk-AI/alpha");
    expect(alpha.failingChecks).toBe(1);
    expect(alpha.behindBy).toBe(2);
    expect(alpha.hasAlerts).toBe(true);

    // no verbose failedChecks arrays or latestCommit objects
    expect("failedChecks" in alpha).toBe(false);
    expect("latestCommit" in alpha).toBe(false);

    // compact JSON string is smaller than the full JSON
    const fullJson = JSON.stringify({ repos: sampleResults });
    const compactJson = JSON.stringify(compact);
    expect(compactJson.length).toBeLessThan(fullJson.length);
  });

  test("compact markdown: short bullet list, no commit detail lines", () => {
    const md = formatCompactRepoStatusMarkdown(sampleResults);
    expect(md).toContain("Rethunk-AI/alpha");
    expect(md).toContain("CI: 1 failing");
    expect(md).toContain("behind: 2");
    // error repo appears as error line
    expect(md).toContain("Error (NOT_FOUND)");
    // no commit SHA lines
    expect(md).not.toContain("Latest:");
    // no full table headers from formatRepoStatusMarkdown
    expect(md).not.toContain("##");
  });

  test("default formatRepoStatusMarkdown output unchanged (full detail)", () => {
    const first = sampleResults[0];
    if (!first) throw new Error("Expected sampleResults[0]");
    const md = formatRepoStatusMarkdown([first]);
    expect(md).toContain("## Rethunk-AI/alpha");
    expect(md).toContain("CI: failing: lint");
    expect(md).toContain("[Local: main, 0 dirty, 0 ahead / 2 behind]");
  });
});

// ---------------------------------------------------------------------------
// repo_status tool integration (via captureTool)
//
// Tests below exercise code paths that do NOT call the GitHub API:
//   - local_repo_no_remote: auth passes → resolveLocalRepoRemote("/tmp") returns
//     undefined (no git repo / no origin) → error returned before any API call.
//
// Requires GitHub auth (GITHUB_TOKEN / GH_TOKEN / `gh auth token`).
// On a developer machine with `gh` configured or CI with GITHUB_TOKEN set,
// auth passes and these tests exercise the post-auth logic.
// ---------------------------------------------------------------------------

describe("repo_status tool (captureTool)", () => {
  test(`batch size above legacy 20: ${MAX_REPOS_PER_REQUEST} localPath entries accepted`, async () => {
    const run = captureTool(registerRepoStatusTool);
    const repos = Array.from({ length: MAX_REPOS_PER_REQUEST }, () => ({
      localPath: "/tmp",
    }));
    const text = await run({ repos, format: "json" });
    const parsed = JSON.parse(text) as {
      repos?: Array<{ error?: { code: string } }>;
    };
    if (!parsed.repos) return; // no auth
    expect(parsed.repos).toHaveLength(MAX_REPOS_PER_REQUEST);
    expect(parsed.repos[0]?.error?.code).toBe("LOCAL_REPO_NO_REMOTE");
  });

  test("LOCAL_REPO_NO_REMOTE: JSON format", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({ repos: [{ localPath: "/tmp" }], format: "json" });
    const parsed = JSON.parse(text) as {
      repos?: Array<{ error?: { code: string; retryable: boolean } }>;
    };
    // If auth unavailable, repos key is absent — skip assertion gracefully
    if (!parsed.repos) return;
    expect(parsed.repos[0]?.error?.code).toBe("LOCAL_REPO_NO_REMOTE");
    expect(parsed.repos[0]?.error?.retryable).toBe(false);
  });

  test("LOCAL_REPO_NO_REMOTE: markdown format", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({ repos: [{ localPath: "/tmp" }] });
    // Auth error returns JSON; markdown path contains the error code
    if (text.startsWith("{")) return;
    expect(text).toContain("LOCAL_REPO_NO_REMOTE");
  });

  test("real localPath: exercises getLocalGitState and API path", async () => {
    // process.cwd() is a valid git repo with a GitHub origin — exercises getLocalGitState
    const run = captureTool(registerRepoStatusTool);
    const text = await run({ repos: [{ localPath: process.cwd() }], format: "json" });
    const parsed = JSON.parse(text) as {
      repos?: Array<{
        owner?: string;
        repo?: string;
        error?: { code: string };
        local?: { branch: string; dirty: number; ahead: number; behind: number };
      }>;
    };
    if (!parsed.repos) return; // no auth
    const entry = parsed.repos[0];
    if (!entry || entry.error) return; // API error (permissions, etc.)
    // Local git state should be populated
    if (entry.local) {
      expect(typeof entry.local.branch).toBe("string");
      expect(entry.local.branch.length).toBeGreaterThan(0);
      expect(typeof entry.local.dirty).toBe("number");
      expect(typeof entry.local.ahead).toBe("number");
      expect(typeof entry.local.behind).toBe("number");
    }
    expect(entry.owner).toBe("Rethunk-AI");
    expect(entry.repo).toBe("rethunk-github-mcp");
  });

  test("direct owner+repo: JSON format — exercises else branch and API result handling", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({
      repos: [{ owner: "Rethunk-AI", repo: "rethunk-github-mcp" }],
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      repos?: Array<{
        owner?: string;
        repo?: string;
        defaultBranch?: string;
        latestCommit?: { sha7: string };
        error?: { code: string };
      }>;
    };
    if (!parsed.repos) return; // no auth
    const entry = parsed.repos[0];
    if (!entry || entry.error) return; // API error — skip
    expect(entry.owner).toBe("Rethunk-AI");
    expect(entry.repo).toBe("rethunk-github-mcp");
    expect(typeof entry.defaultBranch).toBe("string");
    if (entry.latestCommit) {
      expect(entry.latestCommit.sha7).toHaveLength(7);
    }
  });

  test("direct owner+repo: markdown format — covers markdown rendering path", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({
      repos: [{ owner: "Rethunk-AI", repo: "rethunk-github-mcp" }],
      // default format is markdown
    });
    // If auth is absent, result is JSON error — skip gracefully
    if (text.startsWith("{")) return;
    // Always starts with the repo heading regardless of success/error
    expect(text).toContain("## Rethunk-AI/rethunk-github-mcp");
    // If API succeeded, PR counts are present
    if (!text.includes("Error (")) {
      expect(text).toContain("PRs:");
    }
  });
});
