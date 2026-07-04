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
      failedJobs: Array<{ name: string; conclusion: string; log: string }>;
    };

    expect(parsed.runId).toBe(9001);
    expect(parsed.conclusion).toBe("failure");
    expect(parsed.failedJobs).toHaveLength(1);
    expect(parsed.failedJobs[0]?.name).toBe("Unit Tests");
    expect(parsed.failedJobs[0]?.log).toContain("Error:");
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

  test("prNumber path: fetches run via PR head SHA, grepLog filters log lines, markdown shows Failed Jobs", async () => {
    const run = {
      id: 7777,
      name: "CI",
      conclusion: "failure",
      head_branch: "fix/thing",
      html_url: "https://github.com/Acme/svc/actions/runs/7777",
      head_sha: "deadbeef1234",
      head_commit: { message: "fix: a thing", author: { name: "Bob" } },
    };
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      pulls: {
        get: async () => ({ data: { head: { sha: "deadbeef1234" } } }),
      },
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [run] } }),
        listJobsForWorkflowRun: async () => ({
          data: { jobs: [{ id: 55, name: "Lint", conclusion: "failure" }] },
        }),
        downloadJobLogsForWorkflowRun: async () => ({
          data: "noise line\nError: lint failed\nanother noise line\n",
        }),
      },
    } as never);

    const tool = captureTool(registerCiDiagnosisTool);
    const text = await tool({
      owner: "Acme",
      repo: "svc",
      prNumber: 99,
      grepLog: "Error",
      format: "markdown",
    });
    octokitSpy.mockRestore();

    expect(text).toContain("## Failed Jobs");
    expect(text).toContain("Error: lint failed");
    expect(text).not.toContain("noise line");
  });

  test("ref path: picks failed run over first run; log download throws → logs unavailable", async () => {
    const successRun = {
      id: 1001,
      name: "CI",
      conclusion: "success",
      head_branch: "main",
      html_url: "https://github.com/Acme/svc/actions/runs/1001",
      head_sha: "aaa0000000001",
      head_commit: { message: "chore: bump", author: { name: "Carol" } },
    };
    const failedRun = {
      id: 1002,
      name: "CI",
      conclusion: "failure",
      head_branch: "main",
      html_url: "https://github.com/Acme/svc/actions/runs/1002",
      head_sha: "bbb0000000002",
      head_commit: { message: "feat: new thing", author: { name: "Dave" } },
    };
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        listWorkflowRunsForRepo: async () => ({
          data: { workflow_runs: [successRun, failedRun] },
        }),
        listJobsForWorkflowRun: async () => ({
          data: { jobs: [{ id: 66, name: "Test", conclusion: "failure" }] },
        }),
        downloadJobLogsForWorkflowRun: async () => {
          throw new Error("logs expired");
        },
      },
    } as never);

    const tool = captureTool(registerCiDiagnosisTool);
    const text = await tool({
      owner: "Acme",
      repo: "svc",
      ref: "main",
      format: "json",
    });
    octokitSpy.mockRestore();
    errSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      runId: number;
      failedJobs: Array<{ log: string }>;
    };
    expect(parsed.runId).toBe(1002);
    expect(parsed.failedJobs[0]?.log).toBe("[logs unavailable]");
  });

  test("outer catch: classifyError response when getWorkflowRun throws", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        getWorkflowRun: async () => {
          throw new Error("network failure");
        },
      },
    } as never);

    const tool = captureTool(registerCiDiagnosisTool);
    const text = await tool({
      owner: "Acme",
      repo: "svc",
      runId: 9999,
      format: "json",
    });
    octokitSpy.mockRestore();
    errSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: unknown };
    expect(parsed.error).toBeDefined();
  });
});
