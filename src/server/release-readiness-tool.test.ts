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

// ---------------------------------------------------------------------------
// ArtifactIntegrity type shape tests (pure, no network)
// ---------------------------------------------------------------------------

describe("ArtifactIntegrity type", () => {
  test("ok verdict with all assets covered", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "ok",
      details: "All assets covered by checksum file",
      missingFromChecksum: [],
      checksumAsset: "SHA256SUMS",
    };
    expect(integrity.verdict).toBe("ok");
    expect(integrity.missingFromChecksum).toHaveLength(0);
    expect(integrity.checksumAsset).toBe("SHA256SUMS");
  });

  test("warn verdict with missing assets", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "warn",
      details: "2 asset(s) not in checksum file",
      missingFromChecksum: ["app-v1.2.3.zip", "app-v1.2.3.tar.gz"],
      checksumAsset: "SHA256SUMS",
    };
    expect(integrity.verdict).toBe("warn");
    expect(integrity.missingFromChecksum).toHaveLength(2);
  });

  test("skip verdict when no assets", () => {
    const integrity: ArtifactIntegrity = {
      verdict: "skip",
      details: "No release assets",
      missingFromChecksum: [],
    };
    expect(integrity.verdict).toBe("skip");
    expect(integrity.checksumAsset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fully mocked execute body tests — zero live network calls
// ---------------------------------------------------------------------------

describe("release_readiness execute body (mocked)", () => {
  // -------------------------------------------------------------------------
  // A: Happy path — auto-pick head+base, PR metadata resolved, CI success,
  //    checksum-ok integrity, JSON output. Covers:
  //    - head auto-pick (repos.get)
  //    - fetchLatestSemverTag spy returning a tag
  //    - PR number extraction + fetchPRMetadata non-empty Map
  //    - checkArtifactIntegrity ok path
  //    - JSON render, repos[] envelope
  // -------------------------------------------------------------------------
  test("happy path: auto-pick head+base, PR resolved, CI success, checksum ok (JSON)", async () => {
    const sha = "abc1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "feat: add feature (#7)",
                  author: { name: "Alice", date: "2025-01-01T00:00:00Z" },
                },
                author: { login: "alice" },
              },
            ],
            files: [{ additions: 20, deletions: 5 }],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9001 } }),
        listReleaseAssets: async () => ({
          data: [
            { id: 1, name: "app.zip" },
            { id: 2, name: "SHA256SUMS" },
          ],
        }),
        getReleaseAsset: async () => ({
          data: "deadbeef  app.zip\n",
        }),
      },
    } as never);

    const latestTagSpy = spyOn(githubClient, "fetchLatestSemverTag").mockResolvedValue("v2.0.0");

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(
      new Map([
        [
          7,
          {
            number: 7,
            title: "Add feature",
            labels: { nodes: [{ name: "enhancement" }] },
          } as never,
        ],
      ]),
    );

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      // base and head omitted — auto-pick
      format: "json",
    });

    octokitSpy.mockRestore();
    latestTagSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{
        owner: string;
        repo: string;
        base: string;
        head: string;
        aheadBy: number;
        headCi: { status: string };
        commits: Array<{ sha7: string; pr?: { number: number; title: string; labels: string[] } }>;
        stats: { additions: number; deletions: number; changedFiles: number };
        artifactIntegrity: ArtifactIntegrity;
        truncatedCount?: number;
      }>;
    };

    expect(parsed.repos).toHaveLength(1);
    const entry = parsed.repos[0];
    if (!entry) throw new Error("Expected repos[0]");
    expect(entry.owner).toBe("Acme");
    expect(entry.repo).toBe("svc");
    expect(entry.base).toBe("v2.0.0");
    expect(entry.head).toBe("main");
    expect(entry.aheadBy).toBe(1);
    expect(entry.headCi.status).toBe("success");
    expect(entry.commits).toHaveLength(1);
    // PR metadata was resolved and merged into the commit
    expect(entry.commits[0]?.pr?.number).toBe(7);
    expect(entry.commits[0]?.pr?.labels).toEqual(["enhancement"]);
    expect(entry.stats.additions).toBe(20);
    expect(entry.stats.deletions).toBe(5);
    // Checksum "ok" — all assets covered
    expect(entry.artifactIntegrity.verdict).toBe("ok");
    expect(entry.artifactIntegrity.checksumAsset).toBe("SHA256SUMS");
    expect(entry.truncatedCount).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // B: CI pending + assets without checksum file → markdown output.
  // -------------------------------------------------------------------------
  test("pending CI + no checksum asset → markdown shows pending and artifacts warn", async () => {
    const sha = "bbb1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "fix: something",
                  author: { name: "Bob", date: "2025-01-02T00:00:00Z" },
                },
                author: { login: "bob" },
              },
            ],
            files: [{ additions: 2, deletions: 1 }],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9002 } }),
        listReleaseAssets: async () => ({
          // Two assets, neither matches checksum pattern
          data: [
            { id: 10, name: "app.zip" },
            { id: 11, name: "app.tar.gz" },
          ],
        }),
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "PENDING", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.5.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    expect(text).toContain("## Acme/svc");
    expect(text).toContain("CI: pending");
    expect(text).toContain("Artifacts:");
    // warn path — "No checksum asset found"
    expect(text).toContain("No checksum asset found");
    // missing count: 2 assets
    expect(text).toContain("2 uncovered");
  });

  // -------------------------------------------------------------------------
  // C: Zero commits + failing CI → markdown shows "(no commits)" and failing.
  // -------------------------------------------------------------------------
  test("zero commits + failing CI → markdown shows no-commits and CI failing", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 0,
            commits: [],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release tag");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              nodes: [{ name: "test", conclusion: "FAILURE" }],
            },
          },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    expect(text).toContain("*(no commits)*");
    expect(text).toContain("CI: failing");
    expect(text).toContain("test");
    expect(text).toContain("Artifacts: skipped");
  });

  // -------------------------------------------------------------------------
  // C2: Long commit message → JSON path truncates to 72 chars (same bound as
  //     markdown), instead of emitting the raw first line untruncated.
  // -------------------------------------------------------------------------
  test("long commit message → JSON output truncates to 72 chars", async () => {
    const longSubject =
      "feat: this is a deliberately long commit subject line that exceeds the seventy-two character truncation bound used elsewhere";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha: "ddd1234567890abcdef1234567890abcdef123456",
                commit: {
                  message: `${longSubject}\n\nExtended body text that must not appear.`,
                  author: { name: "Carol", date: "2025-01-03T00:00:00Z" },
                },
                author: { login: "carol" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release tag");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as { repos: Array<{ commits: Array<{ message: string }> }> };
    expect(parsed.repos[0]?.commits[0]?.message).toBe(`${longSubject.slice(0, 72)}… [truncated]`);
    expect(parsed.repos[0]?.commits[0]?.message).not.toContain("Extended body text");
  });

  // -------------------------------------------------------------------------
  // D: fetchLatestSemverTag returns null → per-repo NOT_FOUND error (batch
  //    itself still succeeds — a single repo's base-resolution failure is a
  //    per-item error, not a whole-tool failure).
  // -------------------------------------------------------------------------
  test("no semver tag found → per-repo NOT_FOUND error", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
      },
    } as never);

    const latestTagSpy = spyOn(githubClient, "fetchLatestSemverTag").mockResolvedValue(null);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      // base omitted — auto-pick will get null
      format: "json",
    });

    octokitSpy.mockRestore();
    latestTagSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{
        owner: string;
        repo: string;
        error?: { code: string; suggestedFix?: string };
      }>;
    };
    expect(parsed.repos[0]?.error?.code).toBe("NOT_FOUND");
    expect(parsed.repos[0]?.owner).toBe("Acme");
    expect(parsed.repos[0]?.repo).toBe("svc");
  });

  // -------------------------------------------------------------------------
  // E: getReleaseAsset throws (parse-error path inside checkArtifactIntegrity).
  // -------------------------------------------------------------------------
  test("getReleaseAsset throws → artifactIntegrity warn with parse-fail details", async () => {
    const sha = "ccc1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "chore: bump",
                  author: { name: "Eve", date: "2025-01-03T00:00:00Z" },
                },
                author: { login: "eve" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9003 } }),
        listReleaseAssets: async () => ({
          data: [
            { id: 20, name: "app.zip" },
            { id: 21, name: "SHA256SUMS" },
          ],
        }),
        getReleaseAsset: async () => {
          throw new Error("asset download failed");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v3.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ artifactIntegrity: ArtifactIntegrity }>;
    };
    expect(parsed.repos[0]?.artifactIntegrity.verdict).toBe("warn");
    expect(parsed.repos[0]?.artifactIntegrity.details).toContain("Failed to parse checksum file");
    expect(parsed.repos[0]?.artifactIntegrity.checksumAsset).toBe("SHA256SUMS");
  });

  // -------------------------------------------------------------------------
  // F: listReleaseAssets throws (outer catch in checkArtifactIntegrity).
  // -------------------------------------------------------------------------
  test("listReleaseAssets throws → artifactIntegrity warn with error details", async () => {
    const sha = "ddd1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "fix: something else",
                  author: { name: "Frank", date: "2025-01-04T00:00:00Z" },
                },
                author: { login: "frank" },
              },
            ],
            files: [{ additions: 1, deletions: 0 }],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9004 } }),
        listReleaseAssets: async () => {
          throw new Error("asset listing failed");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v4.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ artifactIntegrity: ArtifactIntegrity }>;
    };
    expect(parsed.repos[0]?.artifactIntegrity.verdict).toBe("warn");
    expect(parsed.repos[0]?.artifactIntegrity.details).toContain("Error checking integrity");
    expect(parsed.repos[0]?.artifactIntegrity.details).toContain("asset listing failed");
  });

  // -------------------------------------------------------------------------
  // G: graphqlQuery rejects after fetchPRMetadata is spied → fetchHeadCI error.
  // -------------------------------------------------------------------------
  test("graphqlQuery rejects in fetchHeadCI → headCi.status is error_fetching", async () => {
    const sha = "eee1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "refactor: cleanup",
                  author: { name: "Grace", date: "2025-01-05T00:00:00Z" },
                },
                author: { login: "grace" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
      },
    } as never);

    // Spy on fetchPRMetadata so graphqlQuery rejection only hits fetchHeadCI
    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    // graphqlQuery rejects → fetchHeadCI catches and returns error_fetching
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockRejectedValue(
      new Error("GraphQL network error"),
    );

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ headCi: { status: string; failedChecks: unknown[] } }>;
    };
    expect(parsed.repos[0]?.headCi.status).toBe("error_fetching");
    expect(parsed.repos[0]?.headCi.failedChecks).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // H: compareCommitsWithBasehead throws → per-repo classifyError, batch
  //    itself still returns a `repos[]` envelope rather than a top-level error.
  // -------------------------------------------------------------------------
  test("compareCommitsWithBasehead throws → per-repo classifyError response", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => {
          throw new Error("Network timeout");
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { repos: Array<{ error?: { code: string } }> };
    const entry = parsed.repos[0];
    if (!entry?.error) throw new Error("Expected repos[0].error");
    expect(typeof entry.error.code).toBe("string");
    expect(entry.error.code.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // I: Truncation notice in markdown when aheadBy > listed commits.
  // -------------------------------------------------------------------------
  test("markdown shows truncation notice when aheadBy exceeds maxCommits", async () => {
    const sha = "fff1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 300,
            commits: [
              {
                sha,
                commit: {
                  message: "fix: one commit",
                  author: { name: "Hank", date: "2025-01-06T00:00:00Z" },
                },
                author: { login: "hank" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      maxCommits: 1,
      format: "markdown",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    expect(text).toContain("not shown");
    expect(text).toContain("299");
    expect(text).toContain("CI: not configured");
  });

  // -------------------------------------------------------------------------
  // J: listReleaseAssets returns empty → artifactIntegrity skip.
  // -------------------------------------------------------------------------
  test("listReleaseAssets returns empty → artifactIntegrity skip (no assets)", async () => {
    const sha = "aaa1234567890abcdef1234567890abcdef123456";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "docs: update readme",
                  author: { name: "Iris", date: "2025-01-07T00:00:00Z" },
                },
                author: { login: "iris" },
              },
            ],
            files: [{ additions: 3, deletions: 1 }],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9005 } }),
        // Empty assets → verdict "skip"
        listReleaseAssets: async () => ({ data: [] }),
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v5.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    // Artifact skip because no assets
    expect(text).toContain("Artifacts: skipped");
    // CI success path
    expect(text).toContain("CI: passing");
    // Integrity verified path NOT hit (verdict is skip, not ok)
    expect(text).not.toContain("integrity verified");
  });

  // -------------------------------------------------------------------------
  // K: Checksum ok path in markdown ("integrity verified").
  // -------------------------------------------------------------------------
  test("checksum ok → markdown shows 'Artifacts: integrity verified'", async () => {
    const sha = "bbb9876543210fedcba9876543210fedcba98765";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "feat: new thing",
                  author: { name: "Jack", date: "2025-01-08T00:00:00Z" },
                },
                author: { login: "jack" },
              },
            ],
            files: [{ additions: 5, deletions: 0 }],
          },
        }),
        getReleaseByTag: async () => ({ data: { id: 9006 } }),
        listReleaseAssets: async () => ({
          data: [
            { id: 30, name: "app.zip" },
            { id: 31, name: "SHA256SUMS" },
          ],
        }),
        getReleaseAsset: async () => ({
          // checksum file lists app.zip — all covered
          data: "deadbeef  app.zip\n",
        }),
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        object: {
          statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
        },
      },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v6.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    expect(text).toContain("Artifacts: integrity verified");
    expect(text).toContain("CI: passing");
  });

  // -------------------------------------------------------------------------
  // L: Multi-repo success — two repos in one request, both resolved from the
  //    same mocked GitHub client, each entry carrying its own owner/repo.
  // -------------------------------------------------------------------------
  test("multi-repo: repos[] with two owner/repo entries both succeed", async () => {
    const sha = "1112223334445556667778889990001112223334";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            ahead_by: 1,
            commits: [
              {
                sha,
                commit: {
                  message: "chore: release prep",
                  author: { name: "Kim", date: "2025-01-09T00:00:00Z" },
                },
                author: { login: "kim" },
              },
            ],
            files: [],
          },
        }),
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [
        { owner: "Acme", repo: "svc-one" },
        { owner: "Acme", repo: "svc-two" },
      ],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ owner: string; repo: string; error?: unknown; aheadBy?: number }>;
    };
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos.map((r) => r.repo).sort()).toEqual(["svc-one", "svc-two"]);
    for (const entry of parsed.repos) {
      expect(entry.owner).toBe("Acme");
      expect(entry.error).toBeUndefined();
      expect(entry.aheadBy).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // M: Per-repo error isolation — one repo's compare call fails while its
  //    sibling still returns a full result in the same batch.
  // -------------------------------------------------------------------------
  test("per-repo error isolation: one repo fails, sibling still returns a result", async () => {
    const sha = "9998887776665554443332221110009998887776";

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async ({ repo }: { repo: string }) => {
          if (repo === "broken") throw new Error("compare failed for broken repo");
          return {
            data: {
              ahead_by: 1,
              commits: [
                {
                  sha,
                  commit: {
                    message: "fix: works fine",
                    author: { name: "Lee", date: "2025-01-10T00:00:00Z" },
                  },
                  author: { login: "lee" },
                },
              ],
              files: [],
            },
          };
        },
        getReleaseByTag: async () => {
          throw new Error("not a release");
        },
      },
    } as never);

    const fetchPRSpy = spyOn(githubClient, "fetchPRMetadata").mockResolvedValue(new Map());
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: { object: { statusCheckRollup: null } },
    } as never);

    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({
      repos: [
        { owner: "Acme", repo: "broken" },
        { owner: "Acme", repo: "healthy" },
      ],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    fetchPRSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      error?: { code: string };
      repos: Array<{ repo: string; error?: { code: string }; aheadBy?: number }>;
    };
    // The batch as a whole succeeded — no whole-tool error envelope.
    expect(parsed.error).toBeUndefined();
    expect(parsed.repos).toHaveLength(2);
    const broken = parsed.repos.find((r) => r.repo === "broken");
    const healthy = parsed.repos.find((r) => r.repo === "healthy");
    expect(broken?.error?.code).toBeDefined();
    expect(healthy?.error).toBeUndefined();
    expect(healthy?.aheadBy).toBe(1);
  });

  // -------------------------------------------------------------------------
  // N: Workspace-root fallback — omitting `repos` falls back to the active
  //    MCP root; a root with no resolvable GitHub remote surfaces as a
  //    per-repo LOCAL_REPO_NO_REMOTE error, proving the root was consumed.
  // -------------------------------------------------------------------------
  test("omitting repos falls back to the workspace root", async () => {
    const run = captureTool(registerReleaseReadinessTool, undefined, undefined, ["file:///tmp"]);
    const text = await run({ format: "json" });

    const parsed = JSON.parse(text) as {
      repos?: Array<{ owner: string; repo: string; error?: { code: string } }>;
    };
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos?.[0]?.error?.code).toBe("LOCAL_REPO_NO_REMOTE");
  });

  // -------------------------------------------------------------------------
  // O: No repos and no workspace root → whole-tool VALIDATION error.
  // -------------------------------------------------------------------------
  test("no repos and no workspace root → VALIDATION error", async () => {
    const run = captureTool(registerReleaseReadinessTool);
    const text = await run({ format: "json" });

    const parsed = JSON.parse(text) as { error?: { code: string } };
    expect(parsed.error?.code).toBe("VALIDATION");
  });
});
