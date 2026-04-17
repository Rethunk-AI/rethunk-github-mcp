import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema, RepoRefSchema } from "./schemas.js";

interface ReviewNode {
  author: { login: string };
  state: string;
}

interface CheckContext {
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string;
  state?: string;
}

interface PRPreflightData {
  repository: {
    pullRequest: {
      title: string;
      state: string;
      isDraft: boolean;
      mergeable: string;
      mergeStateStatus: string;
      baseRefName: string;
      headRefName: string;
      reviewDecision: string | null;
      labels: { nodes: { name: string }[] };
      reviews: { nodes: ReviewNode[] };
      reviewRequests: {
        nodes: { requestedReviewer: { login?: string; name?: string } }[];
      };
      commits: {
        nodes: {
          commit: {
            statusCheckRollup: {
              state: string;
              contexts: { nodes: CheckContext[] };
            } | null;
          };
        }[];
      };
    } | null;
  };
}

const PR_PREFLIGHT_QUERY = `
query PRPreflight($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft mergeable mergeStateStatus
      baseRefName headRefName reviewDecision
      labels(first: 20) { nodes { name } }
      reviews(last: 20) { nodes { author { login } state } }
      reviewRequests(first: 10) {
        nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name conclusion status }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export function registerPrPreflightTool(server: FastMCP): void {
  server.addTool({
    name: "pr_preflight",
    description:
      "Pre-merge safety check for a pull request. Returns mergeable state, review " +
      "approvals, CI status, commits behind base, pending reviewers, and a computed " +
      "'safe to merge' verdict with reasons.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      number: z.number().int().positive().describe("PR number."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, number: prNumber } = args;

      try {
        const data = await graphqlQuery<PRPreflightData>(PR_PREFLIGHT_QUERY, {
          owner,
          repo,
          number: prNumber,
        });

        const pr = data.repository.pullRequest;
        if (!pr) {
          return errorRespond(mkError("NOT_FOUND", `PR ${owner}/${repo}#${prNumber} not found.`));
        }

        // Behind-base count via REST compare
        let behindBy = 0;
        try {
          const octokit = getOctokit();
          const cmp = await octokit.repos.compareCommits({
            owner,
            repo,
            base: pr.baseRefName,
            head: pr.headRefName,
          });
          behindBy = cmp.data.behind_by ?? 0;
        } catch {
          // comparison not available
        }

        // De-duplicate reviews: latest per author
        const reviewMap = new Map<string, ReviewNode>();
        for (const r of pr.reviews.nodes) reviewMap.set(r.author.login, r);
        const reviews = [...reviewMap.values()];

        // Pending reviewers
        const pendingReviewers = pr.reviewRequests.nodes
          .map((n) => n.requestedReviewer.login ?? n.requestedReviewer.name ?? "unknown")
          .filter(Boolean);

        // CI
        const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
        const ciStatus = rollup?.state ?? "UNKNOWN";
        const checks = (rollup?.contexts.nodes ?? []).map((c) => ({
          name: c.name ?? c.context ?? "unknown",
          conclusion: c.conclusion ?? c.state ?? null,
          status: c.status ?? c.state ?? "UNKNOWN",
        }));

        const labels = pr.labels.nodes.map((l) => l.name);

        // Compute verdict
        const reasons: string[] = [];
        let safe = true;

        if (pr.state !== "OPEN") {
          safe = false;
          reasons.push(`PR is ${pr.state}`);
        }
        if (pr.isDraft) {
          safe = false;
          reasons.push("PR is a draft");
        }
        if (pr.mergeable === "CONFLICTING") {
          safe = false;
          reasons.push("Has merge conflicts");
        }
        if (pr.reviewDecision === "CHANGES_REQUESTED") {
          safe = false;
          const who = reviews
            .filter((r) => r.state === "CHANGES_REQUESTED")
            .map((r) => r.author.login);
          reasons.push(`Changes requested by ${who.join(", ")}`);
        } else if (pr.reviewDecision !== "APPROVED" && pendingReviewers.length > 0) {
          safe = false;
          reasons.push("Not yet approved");
        }

        const failingChecks = checks.filter(
          (c) => c.conclusion === "FAILURE" || c.conclusion === "failure",
        );
        if (failingChecks.length > 0) {
          safe = false;
          reasons.push(`CI failing: ${failingChecks.map((c) => c.name).join(", ")}`);
        }
        const pendingChecks = checks.filter(
          (c) => c.conclusion === null && c.status !== "COMPLETED",
        );
        if (pendingChecks.length > 0) {
          safe = false;
          reasons.push("CI still running");
        }
        if (behindBy > 0) {
          reasons.push(`${behindBy} commits behind ${pr.baseRefName}`);
        }

        const result = {
          number: prNumber,
          title: pr.title,
          safe,
          reasons,
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision,
          reviews: reviews.map((r) => ({ author: r.author.login, state: r.state })),
          pendingReviewers,
          ci: { status: ciStatus, checks },
          behindBase: behindBy,
          labels,
          conflicts: pr.mergeable === "CONFLICTING",
        };

        if (args.format === "json") return jsonRespond(result);

        // Markdown
        const icon = safe ? "✓" : "✗";
        const verdict = safe ? "Safe to merge" : "NOT safe to merge";
        const blockers = reasons.filter((r) => !r.includes("commits behind"));
        const warnings = reasons.filter((r) => r.includes("commits behind"));

        let md = `# PR Preflight: ${owner}/${repo}#${prNumber}\n\n`;
        md += `## ${icon} ${verdict}\n\n`;

        if (blockers.length > 0) {
          md += "**Blockers:**\n";
          for (const b of blockers) md += `- ✗ ${b}\n`;
          md += "\n";
        }
        if (warnings.length > 0) {
          md += "**Warnings:**\n";
          for (const w of warnings) md += `- ⚠ ${w}\n`;
          md += "\n";
        }

        md += "| Check | Status |\n|-------|--------|\n";

        // Reviews
        if (pr.reviewDecision === "APPROVED") {
          const who = reviews
            .filter((r) => r.state === "APPROVED")
            .map((r) => `${r.author.login} ✓`);
          md += `| Reviews | ✓ APPROVED (${who.join(", ")}) |\n`;
        } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
          const who = reviews
            .filter((r) => r.state === "CHANGES_REQUESTED")
            .map((r) => r.author.login);
          md += `| Reviews | ✗ Changes requested by ${who.join(", ")} |\n`;
        } else {
          md += `| Reviews | ⚠ Pending (${pendingReviewers.join(", ") || "none"}) |\n`;
        }

        // CI
        if (failingChecks.length > 0) {
          md += `| CI | ✗ ${failingChecks.length}/${checks.length} failing |\n`;
        } else if (pendingChecks.length > 0) {
          md += `| CI | ⚠ Running (${pendingChecks.length}/${checks.length}) |\n`;
        } else {
          md += "| CI | ✓ Passing |\n";
        }

        md += `| Conflicts | ${pr.mergeable === "CONFLICTING" ? "✗ Has conflicts" : "✓ None"} |\n`;
        if (pendingReviewers.length > 0) {
          md += `| Pending reviewers | ${pendingReviewers.join(", ")} |\n`;
        }
        if (labels.length > 0) {
          md += `| Labels | ${labels.join(", ")} |\n`;
        }

        return md;
      } catch (err) {
        return errorRespond(classifyError(err));
      }
    },
  });
}
