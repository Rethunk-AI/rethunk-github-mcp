import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowDispatchResult {
  message: string;
  runId?: number;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerWorkflowDispatchTool(server: FastMCP): void {
  server.addTool({
    name: "workflow_dispatch",
    description:
      "Trigger a GitHub Actions workflow via workflow_dispatch event. GitHub returns 204 with no body, so run ID must be polled separately if needed.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      workflow: z.string().describe("Workflow file name (e.g. 'ci.yml') or workflow ID."),
      ref: z.string().describe("Branch or tag to run the workflow on (e.g. 'main')."),
      inputs: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional workflow input parameters as key-value pairs."),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, workflow, ref, inputs } = args;

      try {
        const octokit = getOctokit();

        // workflow_id can be a string (filename) or number (ID)
        const workflowId = Number.isNaN(Number(workflow)) ? workflow : Number(workflow);

        await octokit.actions.createWorkflowDispatch({
          owner,
          repo,
          workflow_id: workflowId,
          ref,
          inputs: inputs ?? {},
        });

        const result: WorkflowDispatchResult = {
          message: `Workflow '${workflow}' dispatched successfully on ${owner}/${repo}:${ref}. GitHub returns 204 (no run ID); poll workflow runs to find the dispatched run.`,
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[workflow_dispatch] Failed to dispatch workflow '${workflow}' for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
