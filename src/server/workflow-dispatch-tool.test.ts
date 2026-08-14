import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { captureTool } from "./test-harness.js";
import { registerWorkflowDispatchTool } from "./workflow-dispatch-tool.js";

describe("workflow_dispatch", () => {
  const run = captureTool(registerWorkflowDispatchTool);
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    resetAuthCache();
  });

  afterEach(() => {
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
    resetAuthCache();
  });

  test("registers successfully", () => {
    expect(run).toBeDefined();
  });

  test("dryRun returns planned envelope without dispatching", async () => {
    let dispatched = false;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => {
          dispatched = true;
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "ci.yml",
        ref: "main",
        dryRun: true,
      }),
    ) as { message: string; dryRun: boolean };

    expect(dispatched).toBe(false);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.message).toContain("dry-run");
    expect(parsed.message).toContain("ci.yml");

    spy.mockRestore();
  });

  test("dispatches successfully and returns message", async () => {
    let capturedWorkflowId: string | number | undefined;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async (params: { workflow_id: string | number }) => {
          capturedWorkflowId = params.workflow_id;
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "deploy.yml",
        ref: "main",
      }),
    ) as { message: string };

    expect(capturedWorkflowId).toBe("deploy.yml");
    expect(parsed.message).toContain("deploy.yml");
    expect(parsed.message).toContain("dispatched successfully");

    spy.mockRestore();
  });

  test("numeric workflow ID string is coerced to number", async () => {
    let capturedWorkflowId: string | number | undefined;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async (params: { workflow_id: string | number }) => {
          capturedWorkflowId = params.workflow_id;
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    await run({
      owner: "o",
      repo: "r",
      workflow: "12345",
      ref: "main",
    });

    expect(capturedWorkflowId).toBe(12345);
    expect(typeof capturedWorkflowId).toBe("number");

    spy.mockRestore();
  });

  test("non-numeric workflow string is NOT coerced", async () => {
    let capturedWorkflowId: string | number | undefined;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async (params: { workflow_id: string | number }) => {
          capturedWorkflowId = params.workflow_id;
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    await run({
      owner: "o",
      repo: "r",
      workflow: "ci.yml",
      ref: "main",
    });

    expect(capturedWorkflowId).toBe("ci.yml");
    expect(typeof capturedWorkflowId).toBe("string");

    spy.mockRestore();
  });

  test("Octokit dispatch failure returns structured error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => {
          throw { status: 404, message: "Workflow not found" };
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "missing.yml",
        ref: "main",
      }),
    ) as { error: { code: string } };

    expect(parsed.error.code).toBe("NOT_FOUND");

    spy.mockRestore();
  });

  test("watch:false keeps the response shape to message only", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => undefined,
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "ci.yml",
        ref: "main",
        watch: false,
      }),
    ) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(["message"]);

    spy.mockRestore();
  });

  test("watch:true resolves runId/url/status/conclusion once the run appears and completes", async () => {
    let listCalls = 0;
    let getCalls = 0;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => undefined,
        listWorkflowRuns: async () => {
          listCalls++;
          if (listCalls === 1) {
            return { data: { workflow_runs: [] } };
          }
          return {
            data: {
              workflow_runs: [
                {
                  id: 999,
                  created_at: new Date().toISOString(),
                  html_url: "https://github.com/o/r/actions/runs/999",
                  status: "in_progress",
                  conclusion: null,
                },
              ],
            },
          };
        },
        getWorkflowRun: async () => {
          getCalls++;
          if (getCalls === 1) {
            return {
              data: {
                id: 999,
                html_url: "https://github.com/o/r/actions/runs/999",
                status: "in_progress",
                conclusion: null,
              },
            };
          }
          return {
            data: {
              id: 999,
              html_url: "https://github.com/o/r/actions/runs/999",
              status: "completed",
              conclusion: "success",
            },
          };
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "ci.yml",
        ref: "main",
        watch: true,
        timeoutSec: 30,
      }),
    ) as { runId: number; url: string; status: string; conclusion: string; timedOut?: boolean };

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(parsed.runId).toBe(999);
    expect(parsed.url).toBe("https://github.com/o/r/actions/runs/999");
    expect(parsed.status).toBe("completed");
    expect(parsed.conclusion).toBe("success");
    expect(parsed.timedOut).toBeUndefined();

    spy.mockRestore();
  }, 15_000);

  test("watch:true reports timedOut with last-known run info when it never completes", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => undefined,
        listWorkflowRuns: async () => ({
          data: {
            workflow_runs: [
              {
                id: 777,
                created_at: new Date().toISOString(),
                html_url: "https://github.com/o/r/actions/runs/777",
                status: "queued",
                conclusion: null,
              },
            ],
          },
        }),
        getWorkflowRun: async () => ({
          data: {
            id: 777,
            html_url: "https://github.com/o/r/actions/runs/777",
            status: "in_progress",
            conclusion: null,
          },
        }),
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "ci.yml",
        ref: "main",
        watch: true,
        timeoutSec: 5,
      }),
    ) as { runId: number; status: string; timedOut: boolean };

    expect(parsed.timedOut).toBe(true);
    expect(parsed.runId).toBe(777);
    expect(parsed.status).toBe("in_progress");

    spy.mockRestore();
  }, 15_000);

  test("accepts optional inputs parameter", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: {
        createWorkflowDispatch: async () => undefined,
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        workflow: "test.yml",
        ref: "main",
        inputs: { environment: "staging", version: "1.2.3" },
      }),
    ) as { message: string };

    expect(parsed.message).toContain("dispatched successfully");

    spy.mockRestore();
  });
});
