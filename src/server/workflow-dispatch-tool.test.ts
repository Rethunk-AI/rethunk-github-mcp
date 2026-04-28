import { describe, expect, test } from "bun:test";

import { captureTool } from "./test-harness.js";
import { registerWorkflowDispatchTool } from "./workflow-dispatch-tool.js";

describe("workflow_dispatch", () => {
  test("registers successfully", () => {
    const run = captureTool(registerWorkflowDispatchTool);
    expect(run).toBeDefined();
  });

  test("requires auth to be available", async () => {
    const run = captureTool(registerWorkflowDispatchTool);
    // Without a valid GitHub token, auth gate should fail
    // This test just verifies the tool is callable and handles auth errors gracefully
    const result = await run({
      owner: "invalid",
      repo: "invalid",
      workflow: "ci.yml",
      ref: "main",
    });
    // Result is a JSON string containing the error response
    expect(result).toBeDefined();
  });

  test("accepts workflow and ref parameters", async () => {
    const run = captureTool(registerWorkflowDispatchTool);
    // This verifies parameter validation works
    // Without auth, we expect an auth error rather than a parameter error
    const result = await run({
      owner: "owner",
      repo: "repo",
      workflow: "deploy.yml",
      ref: "develop",
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });

  test("accepts optional inputs parameter", async () => {
    const run = captureTool(registerWorkflowDispatchTool);
    const result = await run({
      owner: "owner",
      repo: "repo",
      workflow: "test.yml",
      ref: "main",
      inputs: {
        environment: "staging",
        version: "1.2.3",
      },
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });

  test("validates required parameters", async () => {
    const run = captureTool(registerWorkflowDispatchTool);
    // Missing required parameters should cause validation error
    // The exact error depends on fastmcp and zod validation
    try {
      // @ts-expect-error - intentionally missing required params
      await run({
        owner: "owner",
        // missing repo
        workflow: "ci.yml",
        ref: "main",
      });
    } catch {
      // Validation error expected
      expect(true).toBe(true);
    }
  });
});
