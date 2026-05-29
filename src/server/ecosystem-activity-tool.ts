import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import * as gh from "./github-client.js";
import {
  errorRespond,
  jsonRespond,
  type McpErrorEnvelope,
  mkError,
  mkLocalRepoNoRemote,
  truncateText,
} from "./json.js";
import { resolveOptionalLocalPath } from "./roots.js";
import { FormatSchema, LocalOrRemoteRepoSchema, MAX_REPOS_PER_REQUEST } from "./schemas.js";
import { extractFirstPR, parseSince, sha7 } from "./utils.js";

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
  } | null;
}

interface EcosystemCommit {
  owner: string;
  repo: string;
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr: { number: number } | null;
}

interface RepoCommitResult {
  owner: string;
  repo: string;
  commitCount: number;
  truncatedCount?: number;
  error?: McpErrorEnvelope;
  commits: EcosystemCommit[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      const query = `query($owner:String!,$repo:String!,$since:DateTime!,$path:String){
        repository(owner:$owner,name:$repo){
          defaultBranchRef{
            name
            target{
              ...on Commit{
                history(first:${maxCommits},since:$since,path:$path){
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

      const data = await gh.graphqlQuery<HistoryQueryResult>(query, {
        owner,
        repo,
        since: sinceIso,
        path: path ?? null,
      });
      if (!data.repository) {
        // Repository not found or inaccessible — surface as NOT_FOUND rather than TypeError
        return {
          owner,
          repo,
          commitCount: 0,
          error: gh.classifyError(
            Object.assign(new Error(`Repository ${owner}/${repo} not found or inaccessible.`), {
              status: 404,
            }),
          ),
          commits: [],
        };
      }
      const nodes = data.repository.defaultBranchRef?.target?.history.nodes ?? [];
      for (const n of nodes) {
        allNodes.set(n.oid, n);
      }
    }
  } catch (err) {
    console.error(
      `[fetchRepoCommits] Failed to fetch commits for ${owner}/${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { owner, repo, commitCount: 0, error: gh.classifyError(err), commits: [] };
  }

  const sorted = [...allNodes.values()].sort(
    (a, b) => new Date(b.committedDate).getTime() - new Date(a.committedDate).getTime(),
  );

  const filtered = sorted.filter((n) => !grepRe || grepRe.test(n.messageHeadline));
  const rawTruncatedCount = filtered.length - maxCommits;

  const commits: EcosystemCommit[] = filtered.slice(0, maxCommits).map((n) => {
    const prNum = extractFirstPR(n.messageHeadline);
    return {
      owner,
      repo,
      sha7: sha7(n.oid),
      message: n.messageHeadline,
      author: n.author.user?.login ?? n.author.name ?? "unknown",
      date: n.committedDate,
      pr: prNum !== undefined ? { number: prNum } : null,
    };
  });

  return {
    owner,
    repo,
    commitCount: commits.length,
    ...(rawTruncatedCount > 0 ? { truncatedCount: rawTruncatedCount } : {}),
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
      "Chronological commit feed across multiple repos, filterable by path or commit-message regex.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z
        .array(LocalOrRemoteRepoSchema)
        .min(1)
        .max(MAX_REPOS_PER_REQUEST)
        .optional()
        .describe(
          `1–${MAX_REPOS_PER_REQUEST} repos. Each is { owner, repo } or { localPath }; omit to use the active MCP workspace root.`,
        ),
      since: z.string().describe("ISO8601 or relative duration (e.g. '48h', '7d')."),
      paths: z.array(z.string()).optional().describe("Limit to commits touching these paths."),
      grep: z.string().optional().describe("Client-side regex filter on commit subjects."),
      maxCommitsPerRepo: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max commits per repo."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const sinceIso = parseSince(args.since);
      const grepRe = args.grep ? new RegExp(args.grep, "i") : undefined;

      const defaultLocalPath = resolveOptionalLocalPath(server);
      const repoRefs = args.repos ?? (defaultLocalPath ? [{ localPath: defaultLocalPath }] : []);
      if (repoRefs.length === 0) {
        return errorRespond(
          mkError("VALIDATION", "No repository target provided and no MCP workspace root found.", {
            suggestedFix:
              "Open a workspace folder or pass repos: [{ owner, repo }] / [{ localPath }].",
          }),
        );
      }

      const repoResults = await gh.parallelApi(repoRefs, async (repoRef) => {
        let owner: string;
        let repo: string;

        if ("localPath" in repoRef) {
          const localPath =
            resolveOptionalLocalPath(server, repoRef.localPath) ?? repoRef.localPath;
          const resolved = gh.resolveLocalRepoRemote(localPath);
          if (!resolved) {
            return {
              owner: "unknown",
              repo: localPath,
              commitCount: 0,
              error: mkLocalRepoNoRemote(localPath),
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
        ...(r.truncatedCount !== undefined ? { truncatedCount: r.truncatedCount } : {}),
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
          lines.push(`- ${r.owner}/${r.repo}: (${r.error?.code}) ${r.error?.message}`);
        }
      }

      return lines.join("\n");
    },
  });
}
