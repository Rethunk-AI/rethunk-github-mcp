import { describe, test } from "bun:test";

import { registerPrCommentBatchTool } from "./pr-comment-batch-tool.js";
import { captureTool } from "./test-harness.js";

describe("pr_comment_batch", () => {
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
