import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { FormatSchema } from "./schemas.js";

export interface BranchProtectionResult {
  branch: string;
  protected: boolean;
  requiredStatusChecks?: {
    strict: boolean;
    contexts: string[];
  };
  requiredReviews?: {
    count: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
  };
  enforceAdmins?: boolean;
  requiredLinearHistory?: boolean;
  allowForcePushes?: boolean;
  requiredSignatures?: boolean;
  restrictions?: { users: string[]; teams: string[] } | null;
}

function formatBranchProtectionMarkdown(result: BranchProtectionResult): string {
  const lines: string[] = [];
  lines.push(`## Branch Protection: \`${result.branch}\``);
  lines.push(`**Protected:** ${result.protected ? "yes" : "no"}`);
  if (!result.protected) return lines.join("\n");

  if (result.requiredStatusChecks) {
    const { strict, contexts } = result.requiredStatusChecks;
    lines.push(`**Required Status Checks:** strict=${strict}, contexts=[${contexts.join(", ")}]`);
  }
  if (result.requiredReviews) {
    const { count, dismissStaleReviews, requireCodeOwnerReviews } = result.requiredReviews;
    lines.push(
      `**Required Reviews:** count=${count}, dismissStale=${dismissStaleReviews}, requireCodeOwners=${requireCodeOwnerReviews}`,
    );
  }
  lines.push(`**Enforce Admins:** ${result.enforceAdmins ?? false}`);
  lines.push(`**Required Linear History:** ${result.requiredLinearHistory ?? false}`);
  lines.push(`**Allow Force Pushes:** ${result.allowForcePushes ?? false}`);
  lines.push(`**Required Signatures:** ${result.requiredSignatures ?? false}`);
  if (result.restrictions !== undefined) {
    if (result.restrictions === null) {
      lines.push("**Restrictions:** none");
    } else {
      lines.push(
        `**Restrictions:** users=[${result.restrictions.users.join(", ")}], teams=[${result.restrictions.teams.join(", ")}]`,
      );
    }
  }
  return lines.join("\n");
}

export function registerBranchProtectionTool(server: FastMCP): void {
  server.addTool({
    name: "branch_protection_status",
    description:
      "Check branch protection rules for a GitHub repository branch. Useful for verifying protection before editing CI so you won't lock yourself out. Omit branch to query the default branch.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("Owner."),
      repo: z.string().describe("Repo."),
      branch: z
        .string()
        .optional()
        .describe("Branch name. Omit to use the repository default branch."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      try {
        const octokit = getOctokit();
        const { owner, repo } = args;

        // Resolve the branch name — this call can 404 (repo not found) and should NOT be swallowed
        let branch = args.branch;
        if (!branch) {
          const repoData = await octokit.repos.get({ owner, repo });
          branch = repoData.data.default_branch;
        }

        // Fetch protection — a 404 here means the branch is NOT protected (not an error)
        let data: Awaited<ReturnType<typeof octokit.repos.getBranchProtection>>["data"];
        try {
          const resp = await octokit.repos.getBranchProtection({ owner, repo, branch });
          data = resp.data;
        } catch (protErr) {
          const e = protErr as { status?: number };
          if (e.status === 404) {
            const result: BranchProtectionResult = { branch, protected: false };
            if (args.format === "markdown") return formatBranchProtectionMarkdown(result);
            return jsonRespond(result);
          }
          // Re-throw for the outer catch to classify
          throw protErr;
        }

        const restrictions =
          data.restrictions != null
            ? {
                users: (data.restrictions.users ?? [])
                  .map((u) => u.login)
                  .filter((l): l is string => typeof l === "string"),
                teams: (data.restrictions.teams ?? [])
                  .map((t) => t.slug)
                  .filter((s): s is string => typeof s === "string"),
              }
            : null;

        const result: BranchProtectionResult = {
          branch,
          protected: true,
          ...(data.required_status_checks != null
            ? {
                requiredStatusChecks: {
                  strict: data.required_status_checks.strict ?? false,
                  contexts: data.required_status_checks.contexts ?? [],
                },
              }
            : {}),
          ...(data.required_pull_request_reviews != null
            ? {
                requiredReviews: {
                  count: data.required_pull_request_reviews.required_approving_review_count ?? 0,
                  dismissStaleReviews:
                    data.required_pull_request_reviews.dismiss_stale_reviews ?? false,
                  requireCodeOwnerReviews:
                    data.required_pull_request_reviews.require_code_owner_reviews ?? false,
                },
              }
            : {}),
          enforceAdmins: data.enforce_admins?.enabled ?? false,
          requiredLinearHistory: data.required_linear_history?.enabled ?? false,
          allowForcePushes: data.allow_force_pushes?.enabled ?? false,
          requiredSignatures: data.required_signatures?.enabled ?? false,
          restrictions,
        };

        if (args.format === "markdown") return formatBranchProtectionMarkdown(result);
        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[branch_protection_status] Failed for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
