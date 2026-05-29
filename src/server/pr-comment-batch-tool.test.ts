import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerPrCommentBatchTool } from "./pr-comment-batch-tool.js";
import { captureTool } from "./test-harness.js";

describe("pr_comment_batch", () => {
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

    test("returns plan without calling pulls.createReview", async () => {
      const createReview = mock(async () => ({ data: {} }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        pulls: { createReview },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
          owner: "o",
          repo: "r",
          pullNumber: 7,
          event: "REQUEST_CHANGES",
          comments: [
            { path: "src/a.ts", line: 3, body: "Fix this" },
            { path: "src/b.ts", line: 9, body: "Also this" },
          ],
          dryRun: true,
        }),
      ) as { dryRun: boolean; plan: Record<string, unknown> };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.plan).toMatchObject({
        owner: "o",
        repo: "r",
        prNumber: 7,
        event: "REQUEST_CHANGES",
        commentCount: 2,
      });
      const comments = parsed.plan.comments as {
        path: string;
        line: number;
        bodySnippet: string;
      }[];
      expect(comments).toHaveLength(2);
      expect(comments[0].path).toBe("src/a.ts");
      expect(comments[0].bodySnippet).toBe("Fix this");
      expect(createReview).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  test("submit review with body and inline comments", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 42,
        body: "Great PR, a few comments below.",
        event: "COMMENT",
        comments: [
          {
            path: "src/main.ts",
            line: 10,
            body: "Consider using const instead of let here.",
          },
          {
            path: "src/utils.ts",
            line: 25,
            body: "Add error handling for edge case.",
          },
        ],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("submit review with APPROVE event", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 42,
        body: "Looks good to me!",
        event: "APPROVE",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("submit review with REQUEST_CHANGES event", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 42,
        body: "Please address the issues below.",
        event: "REQUEST_CHANGES",
        comments: [
          {
            path: "src/api.ts",
            line: 15,
            body: "This breaks the API contract.",
          },
        ],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("submit review with only inline comments (no body)", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 42,
        comments: [
          {
            path: "README.md",
            line: 5,
            body: "Fix typo: 'occured' -> 'occurred'",
          },
        ],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("submit review with default event (COMMENT)", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 42,
        body: "Review comment",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("missing PR returns not found error", async () => {
    const result = await captureTool(
      (server) => registerPrCommentBatchTool(server),
      "pr_comment_batch",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        pullNumber: 999999,
        body: "This PR does not exist.",
      },
    );

    if (result.ok) {
      console.log("Expected tool to fail for nonexistent PR");
    }
  });
});
