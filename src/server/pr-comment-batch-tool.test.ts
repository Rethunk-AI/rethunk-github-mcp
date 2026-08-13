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

  describe("side and range params forwarded to createReview", () => {
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

    function spyCreateReview() {
      const createReview = mock(async () => ({
        data: { id: 1, html_url: "https://example.com", state: "COMMENTED" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        pulls: { createReview },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);
      return { createReview, spy };
    }

    test("right-side single-line comment forwards no new keys (regression)", async () => {
      const { createReview, spy } = spyCreateReview();

      await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        event: "COMMENT",
        comments: [{ path: "src/a.ts", line: 3, body: "Fix this" }],
      });

      expect(createReview).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        pull_number: 1,
        event: "COMMENT",
        comments: [{ path: "src/a.ts", line: 3, body: "Fix this" }],
      });

      spy.mockRestore();
    });

    test("side: LEFT forwards side", async () => {
      const { createReview, spy } = spyCreateReview();

      await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        comments: [{ path: "src/a.ts", line: 3, body: "Old code", side: "LEFT" }],
      });

      const call = createReview.mock.calls[0]?.[0] as { comments: unknown[] };
      expect(call.comments).toEqual([
        { path: "src/a.ts", line: 3, body: "Old code", side: "LEFT" },
      ]);

      spy.mockRestore();
    });

    test("startLine + line forwards start_line and line", async () => {
      const { createReview, spy } = spyCreateReview();

      await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        comments: [{ path: "src/a.ts", startLine: 10, line: 14, body: "Range comment" }],
      });

      const call = createReview.mock.calls[0]?.[0] as { comments: unknown[] };
      expect(call.comments).toEqual([
        { path: "src/a.ts", start_line: 10, line: 14, body: "Range comment" },
      ]);

      spy.mockRestore();
    });

    test("startSide + side forwards start_side and side", async () => {
      const { createReview, spy } = spyCreateReview();

      await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        comments: [
          {
            path: "src/a.ts",
            startLine: 10,
            startSide: "LEFT",
            line: 14,
            side: "RIGHT",
            body: "Range comment",
          },
        ],
      });

      const call = createReview.mock.calls[0]?.[0] as { comments: unknown[] };
      expect(call.comments).toEqual([
        {
          path: "src/a.ts",
          start_line: 10,
          start_side: "LEFT",
          line: 14,
          side: "RIGHT",
          body: "Range comment",
        },
      ]);

      spy.mockRestore();
    });

    test("subjectType: file forwards subject_type and no line/side", async () => {
      const { createReview, spy } = spyCreateReview();

      await captureTool(registerPrCommentBatchTool, "pr_comment_batch", {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        comments: [{ path: "src/a.ts", subjectType: "file", body: "File-level comment" }],
      });

      const call = createReview.mock.calls[0]?.[0] as { comments: unknown[] };
      expect(call.comments).toEqual([
        { path: "src/a.ts", subject_type: "file", body: "File-level comment" },
      ]);

      spy.mockRestore();
    });
  });

  describe("comments schema refinements reject invalid combinations", () => {
    function parseComments(comments: unknown) {
      const captured: { parameters?: { safeParse: (v: unknown) => { success: boolean } } } = {};
      const fakeServer = {
        addTool(tool: { parameters: { safeParse: (v: unknown) => { success: boolean } } }) {
          captured.parameters = tool.parameters;
        },
      };
      registerPrCommentBatchTool(
        fakeServer as unknown as Parameters<typeof registerPrCommentBatchTool>[0],
      );
      if (!captured.parameters) throw new Error("tool not registered");
      return captured.parameters.safeParse({
        owner: "o",
        repo: "r",
        pullNumber: 1,
        comments,
      });
    }

    test("subjectType: file with line is rejected", () => {
      const result = parseComments([{ path: "a.ts", subjectType: "file", line: 3, body: "x" }]);
      expect(result.success).toBe(false);
    });

    test("startLine without line is rejected", () => {
      const result = parseComments([{ path: "a.ts", startLine: 5, body: "x" }]);
      expect(result.success).toBe(false);
    });

    test("startLine >= line is rejected", () => {
      const result = parseComments([{ path: "a.ts", startLine: 14, line: 14, body: "x" }]);
      expect(result.success).toBe(false);
    });

    test("startSide without startLine is rejected", () => {
      const result = parseComments([{ path: "a.ts", line: 14, startSide: "LEFT", body: "x" }]);
      expect(result.success).toBe(false);
    });

    test("non-file comment without line is rejected", () => {
      const result = parseComments([{ path: "a.ts", body: "x" }]);
      expect(result.success).toBe(false);
    });

    test("valid range comment is accepted", () => {
      const result = parseComments([{ path: "a.ts", startLine: 10, line: 14, body: "x" }]);
      expect(result.success).toBe(true);
    });
  });
});
