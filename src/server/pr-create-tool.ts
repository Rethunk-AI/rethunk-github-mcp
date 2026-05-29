import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, truncateText } from "./json.js";
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

export interface PrCreateDryRunResult {
  dryRun: true;
  plan: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    draft: boolean;
    bodyPreview: string;
  };
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
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, compute and return the planned PR creation (owner/repo/head/base/title/draft/bodyPreview) WITHOUT executing any mutation.",
        ),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, title, body, head, base, draft, maintainerCanModify, dryRun } = args;

      try {
        const octokit = getOctokit();

        if (dryRun) {
          const plan: PrCreateDryRunResult["plan"] = {
            owner,
            repo,
            head,
            base: base ?? "main",
            title,
            draft: draft ?? false,
            bodyPreview: body ? truncateText(body, 200) : "",
          };
          return jsonRespond({ dryRun: true, plan });
        }

        // Build PR creation request
        const requestParams: Parameters<typeof octokit.pulls.create>[0] = {
          owner,
          repo,
          title,
          head,
          base,
          draft,
          maintainer_can_modify: maintainerCanModify,
          ...(body?.trim() ? { body } : {}),
        };

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
