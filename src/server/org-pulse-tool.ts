import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// GraphQL types
// ---------------------------------------------------------------------------

interface PullRequestNode {
  number: number;
  title: string;
  updatedAt: string;
  isDraft: boolean;
  author: { login: string } | null;
  reviewDecision: string | null;
  reviewRequests: { totalCount: number };
}

interface RepoNode {
  name: string;
  nameWithOwner: string;
  pushedAt: string;
  isArchived: boolean;
  defaultBranchRef: {
    name: string;
    target: {
      statusCheckRollup: { state: string } | null;
    };
  } | null;
  pullRequests: {
    totalCount: number;
    nodes: PullRequestNode[];
  };
  issues: { totalCount: number };
}

interface OrgPulseQueryResult {
  organization: {
    repositories: {
      nodes: RepoNode[];
    };
  } | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

interface StalePRItem {
  number: number;
  title: string;
  author: string;
  daysSinceUpdate: number;
}

interface UnreviewedPRItem {
  number: number;
  title: string;
  author: string;
}

interface RepoAttentionItem {
  repo: string;
  ci: string;
  openPRs: number;
  openIssues: number;
  stalePRs: StalePRItem[];
  unreviewedPRs: UnreviewedPRItem[];
  lastPush: string;
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const ORG_PULSE_QUERY = `
query OrgPulse($org: String!, $first: Int!) {
  organization(login: $org) {
    repositories(first: $first, orderBy: {field: PUSHED_AT, direction: DESC}, isArchived: false) {
      nodes {
        name
        nameWithOwner
        pushedAt
        isArchived
        defaultBranchRef {
          name
          target {
            ... on Commit {
              statusCheckRollup { state }
            }
          }
        }
        pullRequests(states: OPEN, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount
          nodes {
            number
            title
            updatedAt
            isDraft
            author { login }
            reviewDecision
            reviewRequests(first: 1) { totalCount }
          }
        }
        issues(states: OPEN) { totalCount }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ciState(repo: RepoNode): string {
  const rollup = repo.defaultBranchRef?.target?.statusCheckRollup;
  if (!rollup) return "none";
  return rollup.state.toLowerCase();
}

/** Higher score = more urgent. Used to sort the attention list. */
function urgencyScore(item: RepoAttentionItem): number {
  return (
    (item.ci === "failure" ? 100 : 0) +
    item.stalePRs.length * 10 +
    item.unreviewedPRs.length * 5 +
    item.openPRs
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerOrgPulseTool(server: FastMCP): void {
  server.addTool({
    name: "org_pulse",
    description:
      "Org-wide health dashboard: scans recently-active repos and surfaces failing CI, stale PRs, unreviewed PRs.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      org: z.string().describe("GitHub organization login."),
      maxRepos: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(30)
        .describe("Repos to scan (by most-recently-pushed)."),
      staleDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(7)
        .describe("Days without activity before a PR is considered stale."),
      includeArchived: z.boolean().optional().default(false).describe("Include archived repos."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      let data: OrgPulseQueryResult;
      try {
        data = await graphqlQuery<OrgPulseQueryResult>(ORG_PULSE_QUERY, {
          org: args.org,
          first: args.maxRepos,
        });
      } catch (err) {
        console.error(
          `[org_pulse] Failed to fetch org pulse for ${args.org}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }

      if (!data.organization) {
        return errorRespond(
          mkError("NOT_FOUND", `Organization '${args.org}' not found or inaccessible.`, {
            suggestedFix: "Verify the org login and that your token has access.",
          }),
        );
      }

      const allRepos = data.organization.repositories.nodes.filter(
        (r) => args.includeArchived || !r.isArchived,
      );

      const now = Date.now();
      const attentionItems: RepoAttentionItem[] = [];
      const healthyRepoNames: string[] = [];

      for (const repo of allRepos) {
        const ci = ciState(repo);
        const openPRNodes = repo.pullRequests.nodes;

        const stalePRs: StalePRItem[] = openPRNodes
          .filter((pr) => {
            if (pr.isDraft) return false;
            const days = Math.floor((now - new Date(pr.updatedAt).getTime()) / 86_400_000);
            return days >= args.staleDays;
          })
          .map((pr) => ({
            number: pr.number,
            title: pr.title,
            author: pr.author?.login ?? "unknown",
            daysSinceUpdate: Math.floor((now - new Date(pr.updatedAt).getTime()) / 86_400_000),
          }));

        const unreviewedPRs: UnreviewedPRItem[] = openPRNodes
          .filter(
            (pr) =>
              !pr.isDraft && pr.reviewDecision !== "APPROVED" && pr.reviewRequests.totalCount > 0,
          )
          .map((pr) => ({
            number: pr.number,
            title: pr.title,
            author: pr.author?.login ?? "unknown",
          }));

        const needsAttention = ci === "failure" || stalePRs.length > 0 || unreviewedPRs.length > 0;

        if (needsAttention) {
          attentionItems.push({
            repo: repo.nameWithOwner,
            ci,
            openPRs: repo.pullRequests.totalCount,
            openIssues: repo.issues.totalCount,
            stalePRs,
            unreviewedPRs,
            lastPush: repo.pushedAt,
          });
        } else {
          healthyRepoNames.push(repo.name);
        }
      }

      attentionItems.sort((a, b) => urgencyScore(b) - urgencyScore(a));

      const failingCI = attentionItems.filter((r) => r.ci === "failure").length;
      const totalStalePRs = attentionItems.reduce((n, r) => n + r.stalePRs.length, 0);
      const totalUnreviewedPRs = attentionItems.reduce((n, r) => n + r.unreviewedPRs.length, 0);
      const totalOpenPRs = allRepos.reduce((n, r) => n + r.pullRequests.totalCount, 0);
      const totalOpenIssues = allRepos.reduce((n, r) => n + r.issues.totalCount, 0);

      const summary = {
        failingCI,
        stalePRs: totalStalePRs,
        unreviewedPRs: totalUnreviewedPRs,
        totalOpenPRs,
        totalOpenIssues,
      };

      if (args.format === "json") {
        return jsonRespond({
          org: args.org,
          scannedRepos: allRepos.length,
          summary,
          attention: attentionItems,
        });
      }

      // -----------------------------------------------------------------------
      // Markdown output
      // -----------------------------------------------------------------------

      const lines: string[] = [];
      lines.push(`# Org Pulse: ${args.org}`);
      lines.push("");

      const summaryParts = [
        `**${allRepos.length} repos scanned**`,
        `${failingCI} failing CI`,
        `${totalStalePRs} stale PRs`,
        `${totalUnreviewedPRs} unreviewed PRs`,
      ];
      lines.push(summaryParts.join(" · "));

      if (attentionItems.length > 0) {
        lines.push("");
        lines.push("## Needs Attention");

        for (const item of attentionItems) {
          lines.push("");
          const ciLabel =
            item.ci === "failure"
              ? "CI: failing"
              : item.ci === "success"
                ? "CI: passing"
                : item.ci === "pending"
                  ? "CI: pending"
                  : "CI: none";
          lines.push(`### ${item.repo} — ${ciLabel}`);

          const prDetail: string[] = [];
          if (item.stalePRs.length > 0) prDetail.push(`${item.stalePRs.length} stale`);
          if (item.unreviewedPRs.length > 0)
            prDetail.push(`${item.unreviewedPRs.length} unreviewed`);
          const prExtra = prDetail.length > 0 ? ` (${prDetail.join(", ")})` : "";
          lines.push(`- PRs: ${item.openPRs} open${prExtra}`);
          lines.push(`- Issues: ${item.openIssues} open`);

          if (item.stalePRs.length > 0) {
            const staleStr = item.stalePRs
              .map((pr) => `#${pr.number} "${pr.title}" by ${pr.author} (${pr.daysSinceUpdate}d)`)
              .join(", ");
            lines.push(`- Stale: ${staleStr}`);
          }

          if (item.unreviewedPRs.length > 0) {
            const reviewStr = item.unreviewedPRs
              .map((pr) => `#${pr.number} "${pr.title}" by ${pr.author}`)
              .join(", ");
            lines.push(`- Needs review: ${reviewStr}`);
          }
        }
      }

      if (healthyRepoNames.length > 0) {
        lines.push("");
        lines.push(`## Healthy Repos (${healthyRepoNames.length})`);
        lines.push(healthyRepoNames.join(", "));
      }

      return lines.join("\n");
    },
  });
}
