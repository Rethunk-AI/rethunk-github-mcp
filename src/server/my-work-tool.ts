import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, truncateText } from "./json.js";
import { FormatSchema } from "./schemas.js";

interface GraphQLPullRequest {
  __typename: "PullRequest";
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface GraphQLIssue {
  __typename: "Issue";
  number: number;
  title: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  labels: { nodes: { name: string }[] };
}

type SearchNode = GraphQLPullRequest | GraphQLIssue;

interface SearchResponse {
  authored: { nodes: SearchNode[] };
  reviewRequested: { nodes: SearchNode[] };
  assignedIssues: { nodes: SearchNode[] };
}

function relativeTime(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return `${Math.floor(sec / 604800)}w ago`;
}

export function registerMyWorkTool(server: FastMCP): void {
  server.addTool({
    name: "my_work",
    description:
      "Cross-repo personal work queue: your open PRs (with CI + review state), " +
      "PRs awaiting your review, and assigned issues. One call replaces browsing " +
      "GitHub notifications.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      username: z.string().optional().describe("GitHub username. Defaults to authenticated user."),
      maxResults: z.number().int().min(1).max(100).optional().default(30),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      let username = args.username;
      if (!username) {
        try {
          const viewer = await graphqlQuery<{ viewer: { login: string } }>(
            "query { viewer { login } }",
          );
          username = viewer.viewer.login;
        } catch (err) {
          return errorRespond(classifyError(err));
        }
      }

      const max = args.maxResults;
      const query = `query {
  authored: search(query: "is:pr is:open author:${username}", type: ISSUE, first: ${max}) {
    nodes {
      ... on PullRequest {
        __typename number title isDraft updatedAt
        repository { nameWithOwner }
        author { login }
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  reviewRequested: search(query: "is:pr is:open review-requested:${username}", type: ISSUE, first: ${max}) {
    nodes {
      ... on PullRequest {
        __typename number title updatedAt
        repository { nameWithOwner }
        author { login }
      }
    }
  }
  assignedIssues: search(query: "is:issue is:open assignee:${username}", type: ISSUE, first: ${max}) {
    nodes {
      ... on Issue {
        __typename number title updatedAt
        repository { nameWithOwner }
        labels(first: 5) { nodes { name } }
      }
    }
  }
}`;

      try {
        const data = await graphqlQuery<SearchResponse>(query);

        const authoredPrs = data.authored.nodes
          .filter((n): n is GraphQLPullRequest => n.__typename === "PullRequest")
          .map((n) => ({
            repo: n.repository.nameWithOwner,
            number: n.number,
            title: truncateText(n.title, 80),
            draft: n.isDraft,
            ci: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE",
            reviewDecision: n.reviewDecision,
            updatedAt: n.updatedAt,
          }));

        const reviewRequests = data.reviewRequested.nodes
          .filter((n): n is GraphQLPullRequest => n.__typename === "PullRequest")
          .map((n) => ({
            repo: n.repository.nameWithOwner,
            number: n.number,
            title: truncateText(n.title, 80),
            author: n.author.login,
            updatedAt: n.updatedAt,
          }));

        const assignedIssues = data.assignedIssues.nodes
          .filter((n): n is GraphQLIssue => n.__typename === "Issue")
          .map((n) => ({
            repo: n.repository.nameWithOwner,
            number: n.number,
            title: truncateText(n.title, 80),
            labels: n.labels.nodes.map((l) => l.name),
            updatedAt: n.updatedAt,
          }));

        const result = { username, authoredPrs, reviewRequests, assignedIssues };

        if (args.format === "json") return jsonRespond(result);

        // Markdown
        const lines: string[] = [`# My Work (@${username})`, ""];

        lines.push(`## Authored PRs (${authoredPrs.length})`);
        if (authoredPrs.length === 0) {
          lines.push("No open PRs.");
        } else {
          for (const pr of authoredPrs) {
            const ci = pr.ci === "SUCCESS" ? "✓" : pr.ci === "FAILURE" ? "✗" : "⏳";
            const draft = pr.draft ? "[DRAFT] " : "";
            const review = pr.reviewDecision?.toLowerCase().replace(/_/g, " ") ?? "pending";
            lines.push(
              `- ${pr.repo}#${pr.number} ${draft}${pr.title}` +
                ` — ${ci} CI, ${review}, ${relativeTime(pr.updatedAt)}`,
            );
          }
        }
        lines.push("");

        lines.push(`## Review Requests (${reviewRequests.length})`);
        if (reviewRequests.length === 0) {
          lines.push("No review requests.");
        } else {
          for (const r of reviewRequests) {
            lines.push(
              `- ${r.repo}#${r.number} ${r.title} — by ${r.author}, ${relativeTime(r.updatedAt)}`,
            );
          }
        }
        lines.push("");

        lines.push(`## Assigned Issues (${assignedIssues.length})`);
        if (assignedIssues.length === 0) {
          lines.push("No assigned issues.");
        } else {
          for (const iss of assignedIssues) {
            const labels = iss.labels.length > 0 ? ` (${iss.labels.join(", ")})` : "";
            lines.push(
              `- ${iss.repo}#${iss.number} ${iss.title}${labels}, ${relativeTime(iss.updatedAt)}`,
            );
          }
        }

        return lines.join("\n");
      } catch (err) {
        return errorRespond(classifyError(err));
      }
    },
  });
}
