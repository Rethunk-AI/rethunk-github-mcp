import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { registerCiDiagnosisTool } from "./ci-diagnosis-tool.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
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
// Helper — build a minimal Octokit mock for ci_diagnosis
// ---------------------------------------------------------------------------

function makeOctokitMock(overrides?: {
  conclusion?: string | null;
  jobs?: Array<{ id: number; name: string; conclusion: string | null }>;
  noRun?: boolean;
}) {
  const conclusion = overrides?.conclusion ?? "failure";
  const jobs = overrides?.jobs ?? [{ id: 1, name: "Unit Tests", conclusion: "failure" }];
  const run = overrides?.noRun
    ? undefined
    : {
        id: 9001,
        name: "CI",
        conclusion,
        head_branch: "main",
        html_url: "https://github.com/Acme/svc/actions/runs/9001",
        head_sha: "abc1234567890",
        head_commit: {
          message: "fix: squash bug",
          author: { name: "Alice" },
        },
      };

  return {
    actions: {
      getWorkflowRun: async () => ({ data: run }),
      listWorkflowRunsForRepo: async () => ({
        data: { workflow_runs: run ? [run] : [] },
      }),
      listJobsForWorkflowRun: async () => ({ data: { jobs } }),
      downloadJobLogsForWorkflowRun: async () => ({
        data: "Error: test failed\n  at index.ts:42",
      }),
    },
  } as never;
}

describe("ci_diagnosis tool (mocked)", () => {
  test("happy path: failed run returns failedJobs with log snippets (JSON)", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(makeOctokitMock());
    const run = captureTool(registerCiDiagnosisTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      runId: 9001,
      format: "json",
    });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      runId: number;
      workflow: string;
      conclusion: string;
      failedJobs: Array<{ name: string; conclusion: string; failedSteps: Array<{ log: string }> }>;
    };

    expect(parsed.runId).toBe(9001);
    expect(parsed.conclusion).toBe("failure");
    expect(parsed.failedJobs).toHaveLength(1);
    expect(parsed.failedJobs[0]?.name).toBe("Unit Tests");
    expect(parsed.failedJobs[0]?.failedSteps[0]?.log).toContain("Error:");
  });

  test("passing run does not populate failedJobs section in markdown", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        conclusion: "success",
        jobs: [{ id: 2, name: "Build", conclusion: "success" }],
      }),
    );
    const run = captureTool(registerCiDiagnosisTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      runId: 9001,
      format: "markdown",
    });
    octokitSpy.mockRestore();

    // Should show "All jobs passed" not "## Failed Jobs"
    expect(text).toContain("All jobs passed");
    expect(text).not.toContain("## Failed Jobs");
  });

  test("NO_CI_RUNS error when no runs found", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ noRun: true }),
    );
    const run = captureTool(registerCiDiagnosisTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      format: "json",
    });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("NO_CI_RUNS");
  });
});
