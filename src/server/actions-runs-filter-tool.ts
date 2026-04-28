import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  createdAt: string;
  url: string;
}

export interface ActionsRunsFilterResult {
  runs: WorkflowRun[];
}

export function registerActionsRunsFilterTool(server: FastMCP): void {
  server.addTool({
    name: "actions_runs_filter",
    description:
      "List and filter GitHub Actions workflow runs for a repository. Filter by workflow name, status, conclusion, and branch.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      workflow: z.string().optional().describe("Workflow name or ID to filter by."),
      status: z
        .enum(["queued", "in_progress", "completed"])
        .optional()
        .describe("Filter by status: queued, in_progress, or completed."),
      conclusion: z
        .enum(["success", "failure", "cancelled"])
        .optional()
        .describe("Filter by conclusion: success, failure, or cancelled."),
      branch: z.string().optional().describe("Filter by branch name."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of runs to return (default 20)."),
    }),
    execute: async (args) => {
      try {
        const octokit = getOctokit();
        const { owner, repo, workflow, status, conclusion, branch, limit } = args;

        // Prepare API call parameters with proper types
        const apiParams: Parameters<typeof octokit.actions.listWorkflowRunsForRepo>[0] = {
          owner,
          repo,
          per_page: Math.min(limit, 100),
        };

        // Add optional parameters with proper type casting
        if (status === "queued" || status === "in_progress" || status === "completed") {
          apiParams.status = status;
        }
        if (conclusion === "success" || conclusion === "failure" || conclusion === "cancelled") {
          apiParams.conclusion = conclusion;
        }
        if (branch) {
          apiParams.head_branch = branch;
        }

        // List workflow runs
        const response = await octokit.actions.listWorkflowRunsForRepo(apiParams);

        // Filter by workflow name if provided
        let runs = response.data.workflow_runs || [];
        if (workflow) {
          runs = runs.filter((run) =>
            (run.name ?? "").toLowerCase().includes(workflow.toLowerCase()),
          );
        }

        // Map to output format and limit results
        const result: ActionsRunsFilterResult = {
          runs: runs.slice(0, limit).map((run) => ({
            id: run.id,
            name: run.name ?? "",
            status: run.status ?? "",
            conclusion: run.conclusion,
            branch: run.head_branch ?? "",
            createdAt: run.created_at ?? "",
            url: run.html_url ?? "",
          })),
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[actions_runs_filter] Failed to list workflow runs for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
