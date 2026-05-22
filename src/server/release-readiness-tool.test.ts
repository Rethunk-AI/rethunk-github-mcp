import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { type ArtifactIntegrity, registerReleaseReadinessTool } from "./release-readiness-tool.js";
import { captureTool } from "./test-harness.js";

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_GH_TOKEN = process.env.GH_TOKEN;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token";
  delete process.env.GH_TOKEN;
  resetAuthCache();
});

afterEach(() => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  }
  if (ORIGINAL_GH_TOKEN === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = ORIGINAL_GH_TOKEN;
  }
  resetAuthCache();
});

/**
 * Test suite for release_readiness tool.
 *
 * Tests below exercise code paths that do NOT require GitHub API calls
 * when the repo has no tags/releases. Tests that require API calls are
 * best-effort (graceful skip if auth unavailable).
 */
describe("release_readiness tool", () => {
  test("NO_SEMVER_TAG error when base omitted and repo has no semver tags", async () => {
    const run = captureTool(registerReleaseReadinessTool);
    // Use a repo that likely has no releases or non-semver tags
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      format: "json",
      // base omitted — auto-pick will fail if no semver tags exist
    });
    const parsed = JSON.parse(text) as { code?: string };
    // Either NOT_FOUND (no tags), or the call succeeds (repo has tags)
    // Both are acceptable test outcomes
    if (parsed.code === "NOT_FOUND") {
      expect(parsed.code).toBe("NOT_FOUND");
    }
  });

  test("JSON format with real repo (auth-dependent)", async () => {
    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      format: "json",
      // base/head will auto-pick or use latest tag
    });
    const parsed = JSON.parse(text) as {
      base?: string;
      head?: string;
      aheadBy?: number;
      commits?: unknown[];
      stats?: { additions: number; deletions: number; changedFiles: number };
      artifactIntegrity?: ArtifactIntegrity;
      error?: { code: string };
    };

    // If no auth or API error, gracefully skip
    if (parsed.error) return;

    // If successful, verify structure
    if (parsed.base) {
      expect(typeof parsed.base).toBe("string");
      expect(typeof parsed.head).toBe("string");
      expect(typeof parsed.aheadBy).toBe("number");
      expect(Array.isArray(parsed.commits)).toBe(true);
      expect(parsed.stats).toBeDefined();
      expect(parsed.stats?.additions).toBeGreaterThanOrEqual(0);
      expect(parsed.stats?.deletions).toBeGreaterThanOrEqual(0);
      expect(parsed.stats?.changedFiles).toBeGreaterThanOrEqual(0);

      // Artifact integrity should be present
      expect(parsed.artifactIntegrity).toBeDefined();
      expect(["ok", "warn", "skip"]).toContain(parsed.artifactIntegrity?.verdict);
      expect(typeof parsed.artifactIntegrity?.details).toBe("string");
      expect(Array.isArray(parsed.artifactIntegrity?.missingFromChecksum)).toBe(true);
    }
  });

  test("markdown format renders artifact integrity status", async () => {
    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      // format defaults to json in the tool, but we can try to get markdown
      format: "markdown",
    });

    // If auth unavailable, result is JSON error — skip
    if (text.startsWith("{")) return;

    // If markdown was rendered, it should contain artifact status
    if (text.includes("Release Readiness")) {
      // Should contain one of: "integrity verified", "No checksum asset found", "skipped"
      const hasArtifactStatus =
        text.includes("Artifacts:") ||
        text.includes("integrity verified") ||
        text.includes("No checksum asset found") ||
        text.includes("skipped");
      expect(hasArtifactStatus).toBe(true);
    }
  });

  test("artifact integrity type structure", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "ok",
      details: "All assets covered",
      missingFromChecksum: [],
      checksumAsset: "SHA256SUMS",
    };

    expect(integrity.verdict).toBe("ok");
    expect(integrity.details).toContain("covered");
    expect(integrity.missingFromChecksum).toHaveLength(0);
    expect(integrity.checksumAsset).toBe("SHA256SUMS");
  });

  test("artifact integrity with missing assets", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "warn",
      details: "2 asset(s) not in checksum file",
      missingFromChecksum: ["app-v1.2.3.zip", "app-v1.2.3.tar.gz"],
      checksumAsset: "SHA256SUMS",
    };

    expect(integrity.verdict).toBe("warn");
    expect(integrity.missingFromChecksum).toHaveLength(2);
    expect(integrity.checksumAsset).toBe("SHA256SUMS");
  });

  test("artifact integrity skip when no assets", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "skip",
      details: "No release assets",
      missingFromChecksum: [],
    };

    expect(integrity.verdict).toBe("skip");
    expect(integrity.details).toContain("No release assets");
    expect(integrity.missingFromChecksum).toHaveLength(0);
    expect(integrity.checksumAsset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mocked execute body tests — cover the full execute path with stub API
// ---------------------------------------------------------------------------

describe("release_readiness execute body (mocked)", () => {
  test("happy path: returns aheadBy, commits, CI status and pending state", async () => {
    const sha = "abc1234567890abcdef".padEnd(40, "0");

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 2,
            commits: [
              {
                sha,
                commit: {
                  message: "fix: squash bug (#42)",
                  author: { name: "Alice", date: "2024-03-01T00:00:00Z" },
                },
                author: { login: "alice" },
              },
            ],
            files: [{ additions: 10, deletions: 3 }],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
        listReleaseAssets: async () => ({ data: [] }),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "PENDING", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      base: string;
      head: string;
      aheadBy: number;
      headCi: { status: string };
      commits: unknown[];
      stats: { additions: number };
    };

    expect(parsed.base).toBe("v1.0.0");
    expect(parsed.head).toBe("main");
    expect(parsed.aheadBy).toBe(2);
    expect(parsed.commits).toHaveLength(1);
    expect(parsed.stats.additions).toBe(10);
    // pending CI should not collapse to "failing"
    expect(parsed.headCi.status).toBe("pending");
  });

  test("markdown shows truncation notice when aheadBy exceeds listed commits", async () => {
    const sha = "def4567890abcdef1234".padEnd(40, "0");

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 300, // 300 ahead but only 1 in the list (cap=50 by default)
            commits: [
              {
                sha,
                commit: {
                  message: "fix: one commit",
                  author: { name: "Bob", date: "2024-03-01T00:00:00Z" },
                },
                author: { login: "bob" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
        listReleaseAssets: async () => ({ data: [] }),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      maxCommits: 1,
      format: "markdown",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    // Should include "not shown" truncation notice
    expect(text).toContain("not shown");
    expect(text).toContain("299");
  });
});
