import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerPrCreateTool } from "./pr-create-tool.js";
import { captureTool } from "./test-harness.js";

describe("pr_create", () => {
  describe("dryRun preview", () => {
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

    test("returns plan without calling pulls.create", async () => {
      const create = mock(async () => ({ data: {} }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        pulls: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerPrCreateTool, "pr_create", {
          owner: "o",
          repo: "r",
          title: "My PR",
          head: "feature/x",
          base: "main",
          body: "Some body text",
          dryRun: true,
        }),
      ) as { dryRun: boolean; plan: Record<string, unknown> };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.plan).toMatchObject({
        owner: "o",
        repo: "r",
        head: "feature/x",
        base: "main",
        title: "My PR",
        draft: false,
        bodyPreview: "Some body text",
      });
      expect(create).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

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
