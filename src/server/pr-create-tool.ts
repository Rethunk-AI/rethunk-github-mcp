import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrCreateResult {
  number: number;
  url: string;
  state: string;
  draft: boolean;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPrCreateTool(server: FastMCP): void {
  server.addTool({
    name: "pr_create",
    description:
      "Create a pull request. Requires a head branch (source) and base branch (target). Returns PR number, URL, state, and draft status.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      title: z.string().describe("Pull request title."),
      body: z.string().optional().describe("Pull request body (markdown)."),
      head: z
        .string()
        .describe(
          "Source branch name (e.g. 'feature/my-branch'). Required; the branch must exist.",
        ),
      base: z.string().describe("Target branch name (e.g. 'main')."),
      draft: z
        .boolean()
        .optional()
        .default(false)
        .describe("Mark the PR as a draft. Defaults to false."),
      maintainerCanModify: z
        .boolean()
        .optional()
        .default(true)
        .describe("Allow repository maintainers to modify the PR. Defaults to true."),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, title, body, head, base, draft, maintainerCanModify } = args;

      try {
        const octokit = getOctokit();

        // Build PR creation request
        // biome-ignore lint/suspicious/noExplicitAny: Octokit type signature requires this pattern
        const requestParams: any = {
          owner,
          repo,
          title,
          head,
          base,
          draft,
          maintainer_can_modify: maintainerCanModify,
        };

        // Add body if provided
        if (body?.trim()) {
          requestParams.body = body;
        }

        const pr = await octokit.pulls.create(requestParams);

        const result: PrCreateResult = {
          number: pr.data.number,
          url: pr.data.html_url,
          state: pr.data.state,
          draft: pr.data.draft || false,
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[pr_create] Failed to create PR for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
