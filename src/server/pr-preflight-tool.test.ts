import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerPrPreflightTool } from "./pr-preflight-tool.js";
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
// Helpers — build minimal mock shapes
// ---------------------------------------------------------------------------

function makePRPreflightGraphQL(
  overrides?: Partial<{
    state: string;
    isDraft: boolean;
    mergeable: string;
    mergeStateStatus: string;
    reviewDecision: string | null;
  }>,
) {
  return {
    repository: {
      pullRequest: {
        title: "Fix the bug",
        state: overrides?.state ?? "OPEN",
        isDraft: overrides?.isDraft ?? false,
        mergeable: overrides?.mergeable ?? "MERGEABLE",
        mergeStateStatus: overrides?.mergeStateStatus ?? "CLEAN",
        baseRefName: "main",
        headRefName: "fix/bug-123",
        reviewDecision: overrides?.reviewDecision ?? "APPROVED",
        labels: { nodes: [{ name: "fix" }] },
        reviews: {
          nodes: [{ author: { login: "alice" }, state: "APPROVED" }],
        },
        reviewRequests: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: "abc1234567890",
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: { nodes: [] },
                },
              },
            },
          ],
        },
      },
    },
  };
}

function makeOctokitMock(overrides?: { compareCommitsError?: boolean }) {
  return {
    pulls: {
      listCommits: async () => ({ data: [] }),
    },
    repos: {
      getCommit: async () => ({ data: { files: [] } }),
      compareCommits: async () => {
        if (overrides?.compareCommitsError) throw new Error("compare failed");
        return { data: { behind_by: 0 } };
      },
    },
    actions: {
      listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
      listJobsForWorkflowRun: async () => ({ data: { jobs: [] } }),
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Happy-path test (highest priority — tests the full checkOnePR flow)
// ---------------------------------------------------------------------------

describe("pr_preflight tool (mocked)", () => {
  test("happy path: safe-to-merge PR returns safe=true with correct shape (JSON)", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "json",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      number: number;
      title: string;
      safe: boolean;
      reasons: string[];
      reviewDecision: string | null;
      ci: { status: string };
      conflicts: boolean;
      commitGranularity: { verdict: string };
    };

    expect(parsed.number).toBe(42);
    expect(parsed.title).toBe("Fix the bug");
    expect(parsed.safe).toBe(true);
    expect(parsed.reasons).toEqual([]);
    expect(parsed.reviewDecision).toBe("APPROVED");
    expect(parsed.ci.status).toBe("SUCCESS");
    expect(parsed.conflicts).toBe(false);
    expect(parsed.commitGranularity.verdict).toBe("ok");
  });

  test("returns NOT safe when PR has merge conflicts", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({ mergeable: "CONFLICTING" }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "json",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { safe: boolean; conflicts: boolean; reasons: string[] };
    expect(parsed.safe).toBe(false);
    expect(parsed.conflicts).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("conflict"))).toBe(true);
  });

  test("markdown output contains verdict and table", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "markdown",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("PR Preflight");
    expect(text).toContain("Safe to merge");
    expect(text).toContain("| CI |");
  });

  test("VALIDATION error when neither number/numbers/ref provided", async () => {
    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", format: "json" });
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("VALIDATION");
  });
});
