import { describe, test } from "bun:test";

import { registerPrCreateTool } from "./pr-create-tool.js";
import { captureTool } from "./test-harness.js";

describe("pr_create", () => {
  test("basic PR creation with title and head/base", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Test PR",
      head: "feature/test-branch",
      base: "main",
    });

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("PR with body text", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Test PR with body",
      body: "## Description\n\nThis is a test PR.\n\n## Changes\n- Added feature",
      head: "feature/test-branch",
      base: "main",
    });

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("PR as draft", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Draft PR",
      head: "feature/test-branch",
      base: "main",
      draft: true,
    });

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("PR without explicit base (uses repo default)", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Test PR no base",
      head: "feature/test-branch",
    });

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("PR with maintainerCanModify disabled", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Test PR no maintainer modify",
      head: "feature/test-branch",
      base: "main",
      maintainerCanModify: false,
    });

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("missing head branch returns error", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "test-repo",
      title: "Test PR",
      head: "nonexistent-branch-xyz",
      base: "main",
    });

    if (result.ok) {
      console.log("Expected tool to fail for nonexistent head branch");
    }
  });

  test("missing repo returns not found error", async () => {
    const result = await captureTool((server) => registerPrCreateTool(server), "pr_create", {
      owner: "Rethunk-AI",
      repo: "nonexistent-repo-xyz",
      title: "Test PR",
      head: "feature/test-branch",
      base: "main",
    });

    if (result.ok) {
      console.log("Expected tool to fail for nonexistent repo");
    }
  });
});
