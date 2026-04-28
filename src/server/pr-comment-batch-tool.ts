import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface PrCommentBatchResult {
  reviewId: number;
  url: string;
  state: string;
  commentsPosted: number;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrCommentBatchTool(server: FastMCP): void {
  server.addTool({
    name: "pr_comment_batch",
    description:
      "Submit a PR review with inline comments in a single API call. Accepts a review body, inline comments (file/line/body), and event type (COMMENT, APPROVE, REQUEST_CHANGES).",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      pullNumber: z.number().int().positive().describe("Pull request number."),
      body: z.string().optional().describe("Overall review body text."),
      event: z
        .enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
        .optional()
        .default("COMMENT")
        .describe("Review event type: COMMENT, APPROVE, or REQUEST_CHANGES."),
      comments: z
        .array(
          z.object({
            path: z.string().describe("File path relative to repository root."),
            line: z.number().int().positive().describe("Line number for the comment."),
            body: z.string().describe("Inline comment text."),
          }),
        )
        .optional()
        .describe("Array of inline comments (path, line, body)."),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, pullNumber, body, event, comments } = args;

      try {
        const octokit = getOctokit();

        // Build the review request
        const reviewRequest: Parameters<typeof octokit.pulls.createReview>[0] = {
          owner,
          repo,
          pull_number: pullNumber,
          event: event as "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
        };

        // Add body if provided
        if (body?.trim()) {
          reviewRequest.body = body;
        }

        // Add inline comments if provided
        if (comments && comments.length > 0) {
          reviewRequest.comments = comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            body: comment.body,
          }));
        }

        const review = await octokit.pulls.createReview(reviewRequest);

        const result: PrCommentBatchResult = {
          reviewId: review.data.id,
          url: review.data.html_url,
          state: review.data.state,
          commentsPosted: comments?.length ?? 0,
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[pr_comment_batch] Failed to create review for ${owner}/${repo}#${pullNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
