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
    reviews: { nodes: { author: { login: string }; state: string }[] };
    reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } }[] };
    contexts: { nodes: unknown[] };
    ciState: string;
    oid: string;
    labels: { nodes: { name: string }[] };
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
        labels: overrides?.labels ?? { nodes: [{ name: "fix" }] },
        reviews: overrides?.reviews ?? {
          nodes: [{ author: { login: "alice" }, state: "APPROVED" }],
        },
        reviewRequests: overrides?.reviewRequests ?? { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: overrides?.oid ?? "abc1234567890",
                statusCheckRollup: {
                  state: overrides?.ciState ?? "SUCCESS",
                  contexts: overrides?.contexts ?? { nodes: [] },
                },
              },
            },
          ],
        },
      },
    },
  };
}

function makePRPreflightNullPR() {
  return { repository: { pullRequest: null } };
}

function makeOctokitMock(overrides?: {
  compareCommitsError?: boolean;
  behindBy?: number;
  listCommitsData?: { sha: string; commit: { message: string } }[];
  getCommitFiles?: number;
  getCommitError?: boolean;
  listWorkflowRuns?: unknown[];
  listJobsForRun?: unknown[];
  downloadJobLog?: string | "throw";
  listWorkflowRunsThrow?: boolean;
}) {
  return {
    pulls: {
      listCommits: async () => {
        const data = overrides?.listCommitsData ?? [];
        return { data };
      },
    },
    repos: {
      getCommit: async () => {
        if (overrides?.getCommitError) throw new Error("commit detail error");
        const count = overrides?.getCommitFiles ?? 0;
        return {
          data: { files: Array.from({ length: count }, (_, i) => ({ filename: `f${i}` })) },
        };
      },
      compareCommits: async () => {
        if (overrides?.compareCommitsError) throw new Error("compare failed");
        return { data: { behind_by: overrides?.behindBy ?? 0 } };
      },
    },
    actions: {
      listWorkflowRunsForRepo: async () => {
        if (overrides?.listWorkflowRunsThrow) throw new Error("workflow runs error");
        return { data: { workflow_runs: overrides?.listWorkflowRuns ?? [] } };
      },
      listJobsForWorkflowRun: async () => ({ data: { jobs: overrides?.listJobsForRun ?? [] } }),
      downloadJobLogsForWorkflowRun: async () => {
        if (overrides?.downloadJobLog === "throw") throw new Error("log download error");
        return { data: overrides?.downloadJobLog ?? "log content here" };
      },
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

  // ---------------------------------------------------------------------------
  // PR not found (null pullRequest)
  // ---------------------------------------------------------------------------

  test("returns error when PR not found (null pullRequest)", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightNullPR() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 99, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      safe: boolean;
      error: { code: string };
      reasons: string[];
    };
    expect(parsed.safe).toBe(false);
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.reasons.some((r) => r.includes("not found"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // All-bad PR: draft, CLOSED, CONFLICTING, CHANGES_REQUESTED, failing+pending CI,
  // behind base, and oversized commits — exercises all "not safe" reason branches
  // ---------------------------------------------------------------------------

  test("all-bad PR (JSON): safe=false with all reason types and oversized commits", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        state: "CLOSED",
        isDraft: true,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        reviews: {
          nodes: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED" }],
        },
        reviewRequests: {
          nodes: [{ requestedReviewer: { login: "carol" } }],
        },
        ciState: "FAILURE",
        contexts: {
          nodes: [
            { name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" },
            { name: "ci/lint", conclusion: null, status: "IN_PROGRESS" },
          ],
        },
        oid: "deadbeef1234",
        labels: { nodes: [{ name: "bug" }, { name: "blocked" }] },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        behindBy: 3,
        listCommitsData: [{ sha: "aaabbbc1234567", commit: { message: "giant commit\ndetail" } }],
        getCommitFiles: 20, // > 15 threshold → oversized
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 7, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      safe: boolean;
      reasons: string[];
      conflicts: boolean;
      behindBase: number;
      labels: string[];
      commitGranularity: {
        verdict: string;
        oversizedCommits: { sha: string; filesChanged: number }[];
      };
      ci: { status: string };
    };

    expect(parsed.safe).toBe(false);
    expect(parsed.conflicts).toBe(true);
    expect(parsed.behindBase).toBe(3);
    expect(parsed.labels).toEqual(["bug", "blocked"]);
    // All reason categories present
    expect(parsed.reasons.some((r) => r.includes("CLOSED"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("draft"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("conflict"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("Changes requested"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("CI failing"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("CI still running"))).toBe(true);
    expect(parsed.reasons.some((r) => r.includes("behind"))).toBe(true);
    // Oversized commit detected
    expect(parsed.commitGranularity.verdict).toBe("warn");
    expect(parsed.commitGranularity.oversizedCommits.length).toBe(1);
    expect(parsed.commitGranularity.oversizedCommits[0]?.filesChanged).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // All-bad PR: markdown output — exercises all markdown branch paths
  // ---------------------------------------------------------------------------

  test("all-bad PR (markdown): contains blockers, warnings, table rows, oversized section", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        state: "CLOSED",
        isDraft: true,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        reviews: {
          nodes: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED" }],
        },
        ciState: "FAILURE",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
        oid: "deadbeef9999",
        labels: { nodes: [{ name: "bug" }] },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        behindBy: 2,
        listCommitsData: [{ sha: "abc1234567890", commit: { message: "big commit" } }],
        getCommitFiles: 18,
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 7, format: "markdown" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("NOT safe to merge");
    expect(text).toContain("Blockers:");
    expect(text).toContain("Warnings:");
    expect(text).toContain("Changes requested by bob");
    expect(text).toContain("| Labels |");
    expect(text).toContain("Oversized Commits");
    expect(text).toContain("big commit");
  });

  // ---------------------------------------------------------------------------
  // Markdown: pending CI + pending reviewers (reviewDecision=null)
  // Exercises the "Running" CI row and "Pending" reviews row
  // ---------------------------------------------------------------------------

  test("markdown: pending CI and pending reviewers shows Running row", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        reviewDecision: null,
        reviewRequests: {
          nodes: [
            { requestedReviewer: { login: "alice" } },
            { requestedReviewer: { name: "team-eng" } },
          ],
        },
        reviews: { nodes: [] },
        contexts: {
          nodes: [{ name: "ci/lint", conclusion: null, status: "IN_PROGRESS" }],
        },
        ciState: "PENDING",
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 5, format: "markdown" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("Running");
    expect(text).toContain("Pending");
    expect(text).toContain("alice");
    expect(text).toContain("team-eng");
    expect(text).toContain("| Pending reviewers |");
  });

  // ---------------------------------------------------------------------------
  // Markdown: APPROVED review row
  // ---------------------------------------------------------------------------

  test("markdown: APPROVED review shows approved row with reviewer name", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        reviewDecision: "APPROVED",
        reviews: { nodes: [{ author: { login: "reviewer1" }, state: "APPROVED" }] },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 5, format: "markdown" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("APPROVED");
    expect(text).toContain("reviewer1 ok");
  });

  // ---------------------------------------------------------------------------
  // compareCommits failure: behindBase stays 0, no crash
  // ---------------------------------------------------------------------------

  test("compareCommits failure does not crash, behindBase=0", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ compareCommitsError: true }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 42, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { behindBase: number; safe: boolean };
    expect(parsed.behindBase).toBe(0);
    expect(parsed.safe).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // checkCommitGranularity: listCommits throws → fallback "Could not check"
  // ---------------------------------------------------------------------------

  test("checkCommitGranularity: listCommits throws → fallback details", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitMock = {
      pulls: {
        listCommits: async () => {
          throw new Error("listCommits network error");
        },
      },
      repos: {
        getCommit: async () => ({ data: { files: [] } }),
        compareCommits: async () => ({ data: { behind_by: 0 } }),
      },
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
        listJobsForWorkflowRun: async () => ({ data: { jobs: [] } }),
      },
    } as never;
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(octokitMock);

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 42, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      commitGranularity: { verdict: string; details: string };
    };
    expect(parsed.commitGranularity.verdict).toBe("ok");
    expect(parsed.commitGranularity.details).toContain("Could not check");
  });

  // ---------------------------------------------------------------------------
  // checkCommitGranularity: individual getCommit fails → filesChanged = 0 fallback
  // ---------------------------------------------------------------------------

  test("checkCommitGranularity: getCommit failure is swallowed, filesChanged=0", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        listCommitsData: [{ sha: "abc1234567890", commit: { message: "some commit" } }],
        getCommitError: true, // throws → filesChanged = 0 → not oversized
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 42, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      commitGranularity: { verdict: string; oversizedCommits: unknown[] };
    };
    expect(parsed.commitGranularity.verdict).toBe("ok");
    expect(parsed.commitGranularity.oversizedCommits).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // checkOnePR throws → wrapped error result (per-PR catch in batch)
  // ---------------------------------------------------------------------------

  test("checkOnePR: graphqlQuery throws → wrapped error result in single mode", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockRejectedValue(
      Object.assign(new Error("GraphQL boom"), { status: 404 }),
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 42, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      safe: boolean;
      error: { code: string };
    };
    expect(parsed.safe).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Batch mode: numbers[] with multiple PRs → { results: [...] }
  // ---------------------------------------------------------------------------

  test("batch mode: numbers=[10,11] returns { results } shape (JSON)", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", numbers: [10, 11], format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { results: { number: number }[] };
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.map((r) => r.number)).toEqual([10, 11]);
  });

  // ---------------------------------------------------------------------------
  // Batch mode: markdown output joins sections with separator
  // ---------------------------------------------------------------------------

  test("batch mode: numbers=[10,11] markdown joins sections with ---", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", numbers: [10, 11], format: "markdown" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    // Two PR sections separated by ---
    expect(text).toContain("#10");
    expect(text).toContain("#11");
    expect(text).toContain("---");
  });

  // ---------------------------------------------------------------------------
  // ref: GitHub PR URL parsing
  // ---------------------------------------------------------------------------

  test("ref: GitHub PR URL resolves owner/repo/number", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "fallback",
      repo: "fallback",
      ref: "https://github.com/RealOrg/real-repo/pull/123",
      format: "json",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    // graphqlQuery should have been called with the parsed owner/repo/number
    const parsed = JSON.parse(text) as { number: number };
    expect(parsed.number).toBe(123);
  });

  // ---------------------------------------------------------------------------
  // ref: owner/repo#N slug parsing
  // ---------------------------------------------------------------------------

  test("ref: owner/repo#N slug resolves correctly", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "fallback",
      repo: "fallback",
      ref: "MyOrg/my-svc#55",
      format: "json",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { number: number };
    expect(parsed.number).toBe(55);
  });

  // ---------------------------------------------------------------------------
  // ref: bare numeric string
  // ---------------------------------------------------------------------------

  test("ref: bare numeric string uses hint owner/repo", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      ref: "77",
      format: "json",
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { number: number };
    expect(parsed.number).toBe(77);
  });

  // ---------------------------------------------------------------------------
  // ref: garbage string → VALIDATION error
  // ---------------------------------------------------------------------------

  test("ref: garbage string → VALIDATION error", async () => {
    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      ref: "not-a-ref-at-all",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("VALIDATION");
  });

  // ---------------------------------------------------------------------------
  // No owner/repo/localPath → VALIDATION error
  // ---------------------------------------------------------------------------

  test("no owner/repo/localPath → VALIDATION error", async () => {
    const run = captureTool(registerPrPreflightTool);
    const text = await run({ number: 1, format: "json" });
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("VALIDATION");
  });

  // ---------------------------------------------------------------------------
  // localPath with no remote → LOCAL_REPO_NO_REMOTE error
  // ---------------------------------------------------------------------------

  test("localPath with no git remote → LOCAL_REPO_NO_REMOTE error", async () => {
    const resolveSpy = spyOn(githubClient, "resolveLocalRepoRemote").mockReturnValue(undefined);

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      localPath: "/tmp/fake-no-remote",
      number: 1,
      format: "json",
    });

    resolveSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("LOCAL_REPO_NO_REMOTE");
  });

  // ---------------------------------------------------------------------------
  // localPath with valid remote → resolves owner/repo correctly
  // ---------------------------------------------------------------------------

  test("localPath with valid remote resolves owner/repo", async () => {
    const resolveSpy = spyOn(githubClient, "resolveLocalRepoRemote").mockReturnValue({
      owner: "LocalOrg",
      repo: "local-svc",
    });
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      localPath: "/tmp/fake-repo",
      number: 42,
      format: "json",
    });

    resolveSpy.mockRestore();
    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { safe: boolean };
    expect(parsed.safe).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // includeLogs: fetchPRFailingLogs happy path — failing job log appended
  // ---------------------------------------------------------------------------

  test("includeLogs: fetches and appends CI logs for failing jobs", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "FAILURE",
        oid: "failsha123456",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        listWorkflowRuns: [{ id: 101, conclusion: "FAILURE" }],
        listJobsForRun: [{ id: 201, name: "test-job", conclusion: "FAILURE" }],
        downloadJobLog: "step 1 passed\nstep 2 failed: assertion error\n",
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "markdown",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("Failing CI Logs");
    expect(text).toContain("test-job");
    expect(text).toContain("assertion error");
  });

  // ---------------------------------------------------------------------------
  // includeLogs: downloadJobLogsForWorkflowRun throws → "[logs unavailable]"
  // ---------------------------------------------------------------------------

  test("includeLogs: log download failure falls back to [logs unavailable]", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "FAILURE",
        oid: "failsha999",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        listWorkflowRuns: [{ id: 101, conclusion: "FAILURE" }],
        listJobsForRun: [{ id: 201, name: "failing-job", conclusion: "FAILURE" }],
        downloadJobLog: "throw",
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "markdown",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("[logs unavailable]");
  });

  // ---------------------------------------------------------------------------
  // includeLogs: listWorkflowRunsForRepo throws → empty logs, no crash
  // ---------------------------------------------------------------------------

  test("includeLogs: listWorkflowRunsForRepo throws → empty failing logs", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "FAILURE",
        oid: "failsha888",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ listWorkflowRunsThrow: true }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "markdown",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    // Should still return markdown content, no crash, no log block
    expect(text).toContain("PR Preflight");
    expect(text).not.toContain("Failing CI Logs");
  });

  // ---------------------------------------------------------------------------
  // includeLogs: no failing runs → no log block appended
  // ---------------------------------------------------------------------------

  test("includeLogs: empty workflow_runs → no log block in output", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "FAILURE",
        oid: "failsha777",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ listWorkflowRuns: [] }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "markdown",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).not.toContain("Failing CI Logs");
  });

  // ---------------------------------------------------------------------------
  // includeLogs: JSON format with includeLogs appends failingLogs field
  // ---------------------------------------------------------------------------

  test("includeLogs: JSON format includes failingLogs on result", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "FAILURE",
        oid: "failsha111",
        contexts: {
          nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }],
        },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        listWorkflowRuns: [{ id: 101, conclusion: "FAILURE" }],
        listJobsForRun: [{ id: 201, name: "test-job", conclusion: "FAILURE" }],
        downloadJobLog: "the actual log",
      }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "json",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { failingLogs: { job: string; log: string }[] };
    expect(Array.isArray(parsed.failingLogs)).toBe(true);
    expect(parsed.failingLogs[0]?.job).toBe("test-job");
    expect(parsed.failingLogs[0]?.log).toContain("the actual log");
  });

  // ---------------------------------------------------------------------------
  // includeLogs: no failing checks → failingLogs NOT fetched
  // ---------------------------------------------------------------------------

  test("includeLogs: no failing checks → failingLogs not set", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        ciState: "SUCCESS",
        contexts: { nodes: [] },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      number: 42,
      format: "json",
      includeLogs: true,
      maxLogLines: 50,
    });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { failingLogs?: unknown };
    // failingLogs should not be present when there are no failing checks
    expect(parsed.failingLogs).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // reviewDecision=CHANGES_REQUESTED: markdown uses "Changes requested" row
  // ---------------------------------------------------------------------------

  test("markdown: CHANGES_REQUESTED review row shows requester name", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: { nodes: [{ author: { login: "charlie" }, state: "CHANGES_REQUESTED" }] },
      }) as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 3, format: "markdown" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    expect(text).toContain("Changes requested by charlie");
  });

  // ---------------------------------------------------------------------------
  // behind-base count > 0: warning in JSON reasons
  // ---------------------------------------------------------------------------

  test("behindBase > 0 adds warning reason", async () => {
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRPreflightGraphQL() as never,
    );
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ behindBy: 5 }),
    );

    const run = captureTool(registerPrPreflightTool);
    const text = await run({ owner: "Acme", repo: "svc", number: 42, format: "json" });

    graphqlSpy.mockRestore();
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { reasons: string[]; behindBase: number };
    expect(parsed.behindBase).toBe(5);
    expect(parsed.reasons.some((r) => r.includes("behind"))).toBe(true);
  });
});
