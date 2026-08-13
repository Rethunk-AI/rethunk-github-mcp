import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, spreadDefined, truncateText } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlineComment {
  path: string;
  /** Last line of the comment (or of the range, when `startLine` is set). Required unless `subjectType` is "file". */
  line?: number;
  body: string;
  /** Diff side for `line`. RIGHT (the default) is the head/after state; LEFT is the base/before state. */
  side?: "LEFT" | "RIGHT";
  /** First line of a multi-line comment range; `line` is the last line of the range. */
  startLine?: number;
  /** Diff side for `startLine`. */
  startSide?: "LEFT" | "RIGHT";
  /** Comment on a line or on the whole file. */
  subjectType?: "line" | "file";
}

export interface PrCommentBatchResult {
  reviewId: number;
  url: string;
  state: string;
  /** Number of inline comments submitted in the review request. GitHub does not return created comments in the review response, so this reflects the input count (commentsRequested). */
  commentsRequested: number;
}

export interface PrCommentBatchDryRunResult {
  dryRun: true;
  plan: {
    owner: string;
    repo: string;
    prNumber: number;
    event: string;
    commentCount: number;
    comments: { path: string; line?: number; bodySnippet: string }[];
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const InlineCommentSchema = z
  .object({
    path: z.string().describe("File path relative to repository root."),
    line: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .optional()
      .describe(
        'Line number for the comment (last line of the range when startLine is set). Required unless subjectType is "file".',
      ),
    body: z.string().describe("Inline comment text."),
    side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .describe(
        "Diff side for `line`. RIGHT (the default) is the head/after state; LEFT is the base/before state.",
      ),
    startLine: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .optional()
      .describe("First line of a multi-line comment range; `line` is the last line of the range."),
    startSide: z.enum(["LEFT", "RIGHT"]).optional().describe("Diff side for `startLine`."),
    subjectType: z
      .enum(["line", "file"])
      .optional()
      .describe("Comment on a line or on the whole file."),
  })
  .superRefine((comment, ctx) => {
    if (comment.subjectType === "file") {
      for (const field of ["line", "startLine", "side", "startSide"] as const) {
        if (comment[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} must be omitted when subjectType is "file".`,
            path: [field],
          });
        }
      }
      return;
    }

    if (comment.line === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'line is required unless subjectType is "file".',
        path: ["line"],
      });
      return;
    }

    if (comment.startSide !== undefined && comment.startLine === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startSide requires startLine.",
        path: ["startSide"],
      });
    }

    if (comment.startLine !== undefined && comment.startLine >= comment.line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startLine must be less than line.",
        path: ["startLine"],
      });
    }
  });

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrCommentBatchTool(server: FastMCP): void {
  server.addTool({
    name: "pr_comment_batch",
    description:
      "Submit a PR review with inline comments in a single API call. Accepts a review body, inline comments (file/line/body, with optional side, startLine/startSide range, and subjectType), and event type (COMMENT, APPROVE, REQUEST_CHANGES).",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      pullNumber: z.number().int().positive().max(10_000_000).describe("Pull request number."),
      body: z.string().optional().describe("Overall review body text."),
      event: z
        .enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
        .optional()
        .default("COMMENT")
        .describe("Review event type: COMMENT, APPROVE, or REQUEST_CHANGES."),
      comments: z
        .array(InlineCommentSchema)
        .optional()
        .describe(
          "Array of inline comments (path, line, body, side, startLine, startSide, subjectType).",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview only; returns the planned change without mutating."),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, pullNumber, body, event, comments, dryRun } = args;

      try {
        const octokit = getOctokit();

        if (dryRun) {
          const plan: PrCommentBatchDryRunResult["plan"] = {
            owner,
            repo,
            prNumber: pullNumber,
            event: event ?? "COMMENT",
            commentCount: comments?.length ?? 0,
            comments: (comments ?? []).map((c) => ({
              path: c.path,
              ...spreadDefined("line", c.line),
              bodySnippet: truncateText(c.body, 120),
            })),
          };
          return jsonRespond({ dryRun: true, plan });
        }

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

        // Add inline comments if provided. `subject_type` isn't in Octokit's
        // generated request type yet, though GitHub's REST API accepts it for
        // whole-file comments, so the per-item type is widened locally.
        type ReviewCommentRequest = NonNullable<
          Parameters<typeof octokit.pulls.createReview>[0]["comments"]
        >[number] & { subject_type?: "line" | "file" };

        if (comments && comments.length > 0) {
          reviewRequest.comments = comments.map(
            (comment): ReviewCommentRequest => ({
              path: comment.path,
              body: comment.body,
              ...spreadDefined("line", comment.line),
              ...spreadDefined("side", comment.side),
              ...spreadDefined("start_line", comment.startLine),
              ...spreadDefined("start_side", comment.startSide),
              ...spreadDefined("subject_type", comment.subjectType),
            }),
          );
        }

        const review = await octokit.pulls.createReview(reviewRequest);

        const result: PrCommentBatchResult = {
          reviewId: review.data.id,
          url: review.data.html_url,
          state: review.data.state,
          commentsRequested: comments?.length ?? 0,
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
