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
