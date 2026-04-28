import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";

export interface CheckRunCreateResult {
  id: number;
  url: string;
}

export function registerCheckRunCreateTool(server: FastMCP): void {
  server.addTool({
    name: "check_run_create",
    description:
      "Create a check run on a GitHub repository. Used to report custom CI/CD status and conclusions to a pull request or commit.",
    annotations: { readOnlyHint: false },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      name: z.string().describe("The name of the check run."),
      headSha: z.string().describe("The SHA of the commit to attach the check run to."),
      status: z
        .enum(["queued", "in_progress", "completed"])
        .optional()
        .default("queued")
        .describe("Status of the check run: queued, in_progress, or completed."),
      conclusion: z
        .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out"])
        .optional()
        .describe(
          "Conclusion of the check run. Required when status is completed. One of: success, failure, neutral, cancelled, skipped, timed_out.",
        ),
      title: z.string().optional().describe("Title of the check run."),
      summary: z.string().optional().describe("Summary of the check run."),
    }),
    execute: async (args) => {
      try {
        const { owner, repo, name, headSha, status, conclusion, title, summary } = args;

        // If status is completed, conclusion is required
        if (status === "completed" && !conclusion) {
          return errorRespond({
            code: "VALIDATION",
            message: "Conclusion is required when status is 'completed'.",
            retryable: false,
            suggestedFix:
              "Provide a conclusion: success, failure, neutral, cancelled, skipped, or timed_out.",
          });
        }

        const octokit = getOctokit();

        // Build the request payload with proper types
        const payload: Parameters<typeof octokit.checks.create>[0] = {
          owner,
          repo,
          name,
          head_sha: headSha,
          status: status as "queued" | "in_progress" | "completed",
        };

        // Add conclusion if provided
        if (
          conclusion === "success" ||
          conclusion === "failure" ||
          conclusion === "neutral" ||
          conclusion === "cancelled" ||
          conclusion === "skipped" ||
          conclusion === "timed_out"
        ) {
          payload.conclusion = conclusion;
        }

        // Add output if title or summary is provided
        if (title || summary) {
          payload.output = {
            title: title ?? "Check Run Output",
            summary: summary ?? "",
          };
        }

        const response = await octokit.checks.create(payload);

        const result: CheckRunCreateResult = {
          id: response.data.id,
          url: response.data.html_url ?? "",
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[check_run_create] Failed to create check run for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
