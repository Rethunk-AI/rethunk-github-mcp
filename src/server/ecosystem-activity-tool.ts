import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { graphqlQuery, parallelApi, resolveLocalRepoRemote } from "./github-client.js";
import { jsonRespond, truncateText } from "./json.js";
import { FormatSchema, LocalOrRemoteRepoSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitHistoryNode {
  oid: string;
  messageHeadline: string;
  committedDate: string;
  author: { name: string | null; user: { login: string } | null };
}

interface HistoryQueryResult {
  repository: {
    defaultBranchRef: {
      name: string;
      target: {
        history: {
          nodes: CommitHistoryNode[];
        };
      } | null;
    } | null;
  };
}

interface EcosystemCommit {
  owner: string;
  repo: string;
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr: { number: number; title: string } | null;
}

interface RepoCommitResult {
  owner: string;
  repo: string;
  commitCount: number;
  error?: string;
  commits: EcosystemCommit[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a relative duration like "48h" or "7d" into an ISO8601 timestamp. */
function parseSince(since: string): string {
  // Already ISO8601
  if (/^\d{4}-\d{2}-\d{2}T/.test(since) || /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return since;
  }
  const hoursMatch = /^(\d+(?:\.\d+)?)h$/i.exec(since);
  if (hoursMatch?.[1]) {
    const ms = Number.parseFloat(hoursMatch[1]) * 3_600_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const daysMatch = /^(\d+(?:\.\d+)?)d$/i.exec(since);
  if (daysMatch?.[1]) {
    const ms = Number.parseFloat(daysMatch[1]) * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  // Fall through: return as-is and let GitHub reject it
  return since;
}

/** Extract PR number from commit message "(#123)" patterns. */
function extractFirstPR(message: string): number | undefined {
  const m = /\(#(\d+)\)/.exec(message);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

async function fetchRepoCommits(
  owner: string,
  repo: string,
  sinceIso: string,
  paths: string[] | undefined,
  maxCommits: number,
  grepRe: RegExp | undefined,
): Promise<RepoCommitResult> {
  const pathsToFetch = paths && paths.length > 0 ? paths : [undefined];

  // Fetch history per path (or once if no path filter), then deduplicate by SHA
  const allNodes = new Map<string, CommitHistoryNode>();

  try {
    for (const path of pathsToFetch) {
      const pathClause = path ? `, path: "${path}"` : "";
      const query = `query($owner:String!,$repo:String!){
        repository(owner:$owner,name:$repo){
          defaultBranchRef{
            name
            target{
              ...on Commit{
                history(first:${maxCommits},since:"${sinceIso}"${pathClause}){
                  nodes{
                    oid messageHeadline committedDate
                    author{ name user{ login } }
                  }
                }
              }
            }
          }
        }
      }`;

      const data = await graphqlQuery<HistoryQueryResult>(query, { owner, repo });
      const nodes = data.repository.defaultBranchRef?.target?.history.nodes ?? [];
      for (const n of nodes) {
        allNodes.set(n.oid, n);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { owner, repo, commitCount: 0, error: msg, commits: [] };
  }

  const sorted = [...allNodes.values()].sort(
    (a, b) => new Date(b.committedDate).getTime() - new Date(a.committedDate).getTime(),
  );

  const commits: EcosystemCommit[] = sorted
    .filter((n) => !grepRe || grepRe.test(n.messageHeadline))
    .slice(0, maxCommits)
    .map((n) => {
      const prNum = extractFirstPR(n.messageHeadline);
      return {
        owner,
        repo,
        sha7: n.oid.substring(0, 7),
        message: n.messageHeadline,
        author: n.author.user?.login ?? n.author.name ?? "unknown",
        date: n.committedDate,
        pr: prNum !== undefined ? { number: prNum, title: n.messageHeadline } : null,
      };
    });

  return {
    owner,
    repo,
    commitCount: commits.length,
    commits,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerEcosystemActivityTool(server: FastMCP): void {
  server.addTool({
    name: "ecosystem_activity",
    description:
      "Merged chronological commit feed across multiple repos, filterable by path or regex. " +
      "Answers 'what's happened across my ecosystem in the last N hours/days?' in one call.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z
        .array(LocalOrRemoteRepoSchema)
        .min(1)
        .max(20)
        .describe("1–20 repos. Each is { owner, repo } or { localPath }."),
      since: z
        .string()
        .describe(
          "ISO8601 timestamp or relative duration like '48h' or '7d'. Commits before this time are excluded.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe("Filter to commits touching these paths (applied per repo via GraphQL history)."),
      grep: z
        .string()
        .optional()
        .describe("Regex filter applied client-side to commit message subjects."),
      maxCommitsPerRepo: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max commits to fetch per repo (default 50, max 200)."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return jsonRespond(auth.body);

      const sinceIso = parseSince(args.since);
      const grepRe = args.grep ? new RegExp(args.grep, "i") : undefined;

      const repoResults = await parallelApi(args.repos, async (repoRef) => {
        let owner: string;
        let repo: string;

        if ("localPath" in repoRef) {
          const resolved = resolveLocalRepoRemote(repoRef.localPath);
          if (!resolved) {
            return {
              owner: "unknown",
              repo: repoRef.localPath,
              commitCount: 0,
              error: "local_repo_no_remote",
              commits: [],
            } as RepoCommitResult;
          }
          owner = resolved.owner;
          repo = resolved.repo;
        } else {
          owner = repoRef.owner;
          repo = repoRef.repo;
        }

        return fetchRepoCommits(owner, repo, sinceIso, args.paths, args.maxCommitsPerRepo, grepRe);
      });

      // Merge + sort all commits by date desc
      const allCommits = repoResults
        .flatMap((r) => r.commits)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Summary
      const repoBreakdown: Record<string, number> = {};
      for (const r of repoResults) {
        if (r.commitCount > 0) repoBreakdown[r.repo] = r.commitCount;
      }

      const repoSummaries = repoResults.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        commitCount: r.commitCount,
        ...(r.error ? { error: r.error } : {}),
      }));

      const result = {
        since: sinceIso,
        repos: repoSummaries,
        commits: allCommits,
        summary: {
          totalCommits: allCommits.length,
          repoBreakdown,
        },
      };

      if (args.format === "json") return jsonRespond(result);

      // -----------------------------------------------------------------------
      // Markdown output
      // -----------------------------------------------------------------------
      const lines: string[] = [];
      lines.push("# Ecosystem Activity");
      lines.push("");
      lines.push(
        `**Since:** ${sinceIso} · **${allCommits.length} commits** across ${repoResults.length} repos`,
      );

      if (allCommits.length === 0) {
        lines.push("");
        lines.push("*(no commits in range)*");
      } else {
        lines.push("");
        lines.push("| Date | Repo | SHA | Message | Author |");
        lines.push("|------|------|-----|---------|--------|");
        for (const c of allCommits) {
          const date = c.date.substring(0, 10);
          const msg = truncateText(c.message, 70);
          const prSuffix = c.pr ? ` (#${c.pr.number})` : "";
          lines.push(
            `| ${date} | ${c.owner}/${c.repo} | \`${c.sha7}\` | ${msg}${prSuffix} | ${c.author} |`,
          );
        }
      }

      const errored = repoResults.filter((r) => r.error);
      if (errored.length > 0) {
        lines.push("");
        lines.push("## Errors");
        for (const r of errored) {
          lines.push(`- ${r.owner}/${r.repo}: ${r.error}`);
        }
      }

      return lines.join("\n");
    },
  });
}
