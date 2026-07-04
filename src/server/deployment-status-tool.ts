import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, parallelApi } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { FormatSchema } from "./schemas.js";
import { sha7 } from "./utils.js";

export interface DeploymentEntry {
  id: number;
  environment: string;
  ref: string;
  sha: string;
  state: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface DeploymentStatusResult {
  environmentFilter: string | null;
  deployments: DeploymentEntry[];
  byEnvironment: Record<string, string>;
  truncatedCount: number;
}

function formatDeploymentStatusMarkdown(result: DeploymentStatusResult): string {
  const lines: string[] = [];
  const filterNote = result.environmentFilter ? ` (env: ${result.environmentFilter})` : "";
  lines.push(`## Deployments${filterNote}`);

  if (result.deployments.length === 0) {
    lines.push("No deployments found.");
    return lines.join("\n");
  }

  // Summary by environment
  const envEntries = Object.entries(result.byEnvironment);
  if (envEntries.length > 0) {
    lines.push("### Latest State by Environment");
    for (const [env, state] of envEntries) {
      lines.push(`- **${env}**: ${state}`);
    }
  }

  lines.push("### Deployments");
  for (const d of result.deployments) {
    lines.push(
      `- [#${d.id}] **${d.environment}** \`${d.ref}\` @ \`${d.sha}\` — ${d.state} (${d.creator}, ${d.createdAt})`,
    );
  }

  return lines.join("\n");
}

export function registerDeploymentStatusTool(server: FastMCP): void {
  server.addTool({
    name: "deployment_status",
    description:
      "Check deployment status for a GitHub repository. Answers whether production is healthy and when the last deployment occurred. Optionally filter by environment.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("Owner."),
      repo: z.string().describe("Repo."),
      environment: z
        .string()
        .optional()
        .describe("Filter deployments by environment name (e.g. 'production')."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Maximum number of deployments to fetch (1–50, default 10)."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      try {
        const octokit = getOctokit();
        const { owner, repo, environment, limit } = args;

        const deploymentsResp = await octokit.repos.listDeployments({
          owner,
          repo,
          ...(environment ? { environment } : {}),
          per_page: limit,
        });

        const rawDeployments = deploymentsResp.data;

        // Fetch latest status for each deployment concurrently; tolerate per-deployment failures
        const deployments = await parallelApi(rawDeployments, async (d) => {
          let state = "unknown";
          let statusUrl = d.url;
          try {
            const statusResp = await octokit.repos.listDeploymentStatuses({
              owner,
              repo,
              deployment_id: d.id,
              per_page: 1,
            });
            const latest = statusResp.data[0];
            if (latest) {
              state = latest.state;
              statusUrl = latest.target_url || d.url;
            }
          } catch (statusErr) {
            console.error(
              `[deployment_status] Failed to fetch status for deployment ${d.id}:`,
              statusErr instanceof Error ? statusErr.message : String(statusErr),
            );
          }

          const entry: DeploymentEntry = {
            id: d.id,
            environment: d.environment,
            ref: d.ref,
            sha: sha7(d.sha),
            state,
            creator: d.creator?.login ?? "unknown",
            createdAt: d.created_at,
            updatedAt: d.updated_at,
            url: statusUrl,
          };
          return entry;
        });

        // Build byEnvironment map — listDeployments returns newest-first so first-seen = latest
        const byEnvironment: Record<string, string> = {};
        for (const d of deployments) {
          if (!(d.environment in byEnvironment)) {
            byEnvironment[d.environment] = d.state;
          }
        }

        const result: DeploymentStatusResult = {
          environmentFilter: environment ?? null,
          deployments,
          byEnvironment,
          truncatedCount: 0,
        };

        if (args.format === "markdown") return formatDeploymentStatusMarkdown(result);
        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[deployment_status] Failed for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
