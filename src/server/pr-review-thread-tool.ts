import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, truncateText } from "./json.js";

// ---------------------------------------------------------------------------
// GraphQL shapes
// ---------------------------------------------------------------------------

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      body: string;
    }>;
  };
}

interface ListThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean };
        nodes: ReviewThreadNode[];
      };
    };
  };
}

interface MutationResult {
  resolveReviewThread?: { thread: { id: string } };
  unresolveReviewThread?: { thread: { id: string } };
}

// ---------------------------------------------------------------------------
// Compact thread shape returned by action="list"
// ---------------------------------------------------------------------------

export interface CompactThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  author: string | null;
  bodySnippet: string;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrReviewThreadTool(server: FastMCP): void {
  server.addTool({
    name: "pr_review_thread_ops",
    description:
      "Enumerate a PR's review threads and resolve/unresolve them to close feedback loops. " +
      "action=list returns compact thread metadata (capped at 100 threads per call; truncatedCount is included when more exist). " +
      "action=resolve/unresolve mutates the specified thread IDs and returns resolved/failure lists. " +
      "dryRun=true computes the target set without mutating. " +
      "resolveOutdated=true (with action=resolve) resolves all currently-unresolved AND outdated threads.",
    annotations: { readOnlyHint: false },
    parameters: z.object({
      owner: z.string().describe("GitHub repository owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      prNumber: z.number().int().positive().describe("Pull request number."),
      action: z
        .enum(["list", "resolve", "unresolve"])
        .describe("Operation: list threads, resolve them, or unresolve them."),
      threadIds: z
        .array(z.string())
        .optional()
        .describe(
          "Review thread node IDs to resolve/unresolve. Required for resolve/unresolve unless resolveOutdated is true.",
        ),
      resolveOutdated: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When action=resolve: resolve ALL unresolved+outdated threads instead of using threadIds.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, compute the target thread set and return it WITHOUT mutating (mirrors labels_sync dryRun).",
        ),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, prNumber, action, threadIds, resolveOutdated, dryRun } = args as {
        owner: string;
        repo: string;
        prNumber: number;
        action: "list" | "resolve" | "unresolve";
        threadIds?: string[];
        resolveOutdated?: boolean;
        dryRun?: boolean;
      };

      try {
        // ---------------------------------------------------------------
        // action = list
        // ---------------------------------------------------------------
        if (action === "list") {
          const data = await graphqlQuery<ListThreadsResult>(
            `query($owner: String!, $repo: String!, $prNumber: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                  reviewThreads(first: 100) {
                    totalCount
                    pageInfo { hasNextPage }
                    nodes {
                      id
                      isResolved
                      isOutdated
                      path
                      line
                      comments(first: 1) {
                        nodes {
                          author { login }
                          body
                        }
                      }
                    }
                  }
                }
              }
            }`,
            { owner, repo, prNumber },
          );

          const rt = data.repository.pullRequest.reviewThreads;
          const threads: CompactThread[] = rt.nodes.map((node) => {
            const firstComment = node.comments.nodes[0];
            return {
              id: node.id,
              path: node.path,
              line: node.line,
              isResolved: node.isResolved,
              isOutdated: node.isOutdated,
              author: firstComment?.author?.login ?? null,
              bodySnippet: firstComment ? truncateText(firstComment.body, 120) : "",
            };
          });

          const result: { threads: CompactThread[]; truncatedCount?: number } = { threads };
          if (rt.pageInfo.hasNextPage) {
            result.truncatedCount = rt.totalCount - threads.length;
          }
          return jsonRespond(result);
        }

        // ---------------------------------------------------------------
        // action = resolve / unresolve
        // ---------------------------------------------------------------

        // Determine target thread IDs
        let targetThreadIds: string[];

        if (resolveOutdated && action === "resolve") {
          // Fetch the thread list to find unresolved+outdated
          const data = await graphqlQuery<ListThreadsResult>(
            `query($owner: String!, $repo: String!, $prNumber: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                  reviewThreads(first: 100) {
                    totalCount
                    pageInfo { hasNextPage }
                    nodes {
                      id
                      isResolved
                      isOutdated
                      path
                      line
                      comments(first: 1) {
                        nodes {
                          author { login }
                          body
                        }
                      }
                    }
                  }
                }
              }
            }`,
            { owner, repo, prNumber },
          );
          targetThreadIds = data.repository.pullRequest.reviewThreads.nodes
            .filter((n) => !n.isResolved && n.isOutdated)
            .map((n) => n.id);
        } else if (threadIds && threadIds.length > 0) {
          targetThreadIds = threadIds;
        } else {
          return errorRespond({
            code: "VALIDATION",
            message:
              "threadIds is required for resolve/unresolve unless resolveOutdated=true (resolve only).",
            retryable: false,
          });
        }

        // dryRun: return targets without mutating
        if (dryRun) {
          return jsonRespond({ dryRun: true, action, targetThreadIds });
        }

        // Perform mutations with partial-failure tolerance
        const mutationName = action === "resolve" ? "resolveReviewThread" : "unresolveReviewThread";

        const ops = targetThreadIds.map((threadId) =>
          graphqlQuery<MutationResult>(
            `mutation($threadId: ID!) {
              ${mutationName}(input: { threadId: $threadId }) {
                thread { id }
              }
            }`,
            { threadId },
          ).then(() => ({ ok: true as const, threadId })),
        );

        const settled = await Promise.allSettled(ops);

        const resolved: string[] = [];
        const failures: Array<{ threadId: string; error: string }> = [];

        settled.forEach((result, i) => {
          const threadId = targetThreadIds[i] ?? `thread[${i}]`;
          if (result.status === "fulfilled" && result.value.ok) {
            resolved.push(result.value.threadId);
          } else if (result.status === "rejected") {
            failures.push({
              threadId,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        });

        return jsonRespond({ action, resolved, failures });
      } catch (err) {
        console.error(
          `[pr_review_thread_ops] Failed for ${owner}/${repo}#${prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
