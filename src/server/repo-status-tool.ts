import { execFileSync } from "node:child_process";

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  graphqlQuery,
  parallelApi,
  resolveLocalRepoRemote,
} from "./github-client.js";
import {
  errorRespond,
  jsonRespond,
  type McpErrorEnvelope,
  mkLocalRepoNoRemote,
  truncateText,
} from "./json.js";
import { FormatSchema, LocalOrRemoteRepoSchema, MAX_REPOS_PER_REQUEST } from "./schemas.js";
import { type CheckNode, normalizeFailedChecks, timeAgo } from "./utils.js";

interface RepoQueryResult {
  repository: {
    defaultBranchRef: {
      name: string;
      target: {
        oid: string;
        messageHeadline: string;
        author: { user: { login: string } | null; date: string };
        statusCheckRollup: {
          state: string;
          contexts: { nodes: CheckNode[] };
        } | null;
      };
    } | null;
    openPRs: { totalCount: number };
    openIssues: { totalCount: number };
  };
}

export interface RepoResult {
  owner: string;
  repo: string;
  defaultBranch?: string;
  latestCommit?: { sha7: string; message: string; author: string; date: string };
  ci?: { status: string; failedChecks?: { name: string; conclusion: string }[] };
  openPRs?: number;
  draftPRs?: number;
  openIssues?: number;
  local?: { branch: string; dirty: number; ahead: number; behind: number };
  error?: McpErrorEnvelope;
}

function getLocalGitState(localPath: string): RepoResult["local"] | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: localPath,
      encoding: "utf8",
    }).trim();

    const dirtyOut = execFileSync("git", ["status", "--short"], {
      cwd: localPath,
      encoding: "utf8",
    });
    const dirty = dirtyOut.split("\n").filter((l) => l.trim()).length;

    let ahead = 0;
    let behind = 0;
    try {
      const aheadStr = execFileSync("git", ["rev-list", "--count", "@{upstream}..HEAD"], {
        cwd: localPath,
        encoding: "utf8",
      }).trim();
      const behindStr = execFileSync("git", ["rev-list", "--count", "HEAD..@{upstream}"], {
        cwd: localPath,
        encoding: "utf8",
      }).trim();
      ahead = Number.parseInt(aheadStr, 10) || 0;
      behind = Number.parseInt(behindStr, 10) || 0;
    } catch {
      // no upstream configured
    }

    return { branch, dirty, ahead, behind };
  } catch {
    return undefined;
  }
}

export function formatRepoStatusMarkdown(results: RepoResult[]): string {
  return results
    .map((r) => {
      if (r.error) return `## ${r.owner}/${r.repo}\nError (${r.error.code}): ${r.error.message}`;
      const lines: string[] = [];
      lines.push(`## ${r.owner}/${r.repo} (${r.defaultBranch ?? "?"})`);
      if (r.latestCommit) {
        lines.push(
          `Latest: \`${r.latestCommit.sha7}\` ${r.latestCommit.message}` +
            ` — ${r.latestCommit.author}, ${r.latestCommit.date}`,
        );
      }
      if (r.ci) {
        const state = r.ci.status === "success" ? "passing" : "failing";
        const extra = r.ci.failedChecks?.map((c) => c.name).join(", ");
        lines.push(`CI: ${state}${extra ? `: ${extra}` : ""}`);
      } else {
        lines.push("CI: not configured");
      }
      const draft = r.draftPRs ? ` (${r.draftPRs} draft)` : "";
      lines.push(`PRs: ${r.openPRs ?? 0} open${draft} · Issues: ${r.openIssues ?? 0} open`);
      if (r.local) {
        lines.push(
          `[Local: ${r.local.branch}, ${r.local.dirty} dirty, ` +
            `${r.local.ahead} ahead / ${r.local.behind} behind]`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

const REPO_STATUS_QUERY = `
query RepoStatus($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          messageHeadline
          author { user { login } date }
          statusCheckRollup {
            state
            contexts(first: 20) {
              nodes {
                ... on CheckRun { name conclusion }
                ... on StatusContext { context state }
              }
            }
          }
        }
      }
    }
    openPRs: pullRequests(states: OPEN) { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
  }
}`;

// The GraphQL API doesn't expose a draft:true filter on pullRequests.totalCount directly.
// Use a separate search-based query for draft count to avoid fetching 100 nodes.
const DRAFT_COUNT_QUERY = `
query DraftCount($q: String!) {
  search(query: $q, type: ISSUE, first: 0) { issueCount }
}`;

export function registerRepoStatusTool(server: FastMCP): void {
  server.addTool({
    name: "repo_status",
    description: `Multi-repo dashboard: HEAD commit, CI status, open PR/issue counts. Accepts up to ${MAX_REPOS_PER_REQUEST} repos; include \`localPath\` for local git state.`,
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z
        .array(LocalOrRemoteRepoSchema)
        .min(1)
        .max(MAX_REPOS_PER_REQUEST)
        .describe("Repos to query."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const results = await parallelApi(args.repos, async (repoRef) => {
        let owner: string;
        let repo: string;
        let localState: RepoResult["local"] | undefined;

        if ("localPath" in repoRef) {
          const resolved = resolveLocalRepoRemote(repoRef.localPath);
          if (!resolved) {
            return {
              owner: "unknown",
              repo: repoRef.localPath,
              error: mkLocalRepoNoRemote(repoRef.localPath),
            };
          }
          owner = resolved.owner;
          repo = resolved.repo;
          localState = getLocalGitState(repoRef.localPath);
        } else {
          owner = repoRef.owner;
          repo = repoRef.repo;
        }

        try {
          const [data, draftData] = await Promise.all([
            graphqlQuery<RepoQueryResult>(REPO_STATUS_QUERY, { owner, name: repo }),
            graphqlQuery<{ search: { issueCount: number } }>(DRAFT_COUNT_QUERY, {
              q: `repo:${owner}/${repo} is:pr is:open draft:true`,
            }),
          ]);
          const r = data.repository;
          const result: RepoResult = { owner, repo };

          if (r.defaultBranchRef) {
            result.defaultBranch = r.defaultBranchRef.name;
            const c = r.defaultBranchRef.target;
            result.latestCommit = {
              sha7: c.oid.substring(0, 7),
              message: truncateText(c.messageHeadline, 60),
              author: c.author.user?.login ?? "unknown",
              date: timeAgo(c.author.date),
            };

            const rollup = c.statusCheckRollup;
            if (rollup) {
              const failed = normalizeFailedChecks(rollup.contexts.nodes);
              result.ci = {
                status: rollup.state.toLowerCase(),
                ...(failed.length > 0 ? { failedChecks: failed } : {}),
              };
            }
          }

          result.openPRs = r.openPRs.totalCount;
          result.draftPRs = draftData.search.issueCount;
          result.openIssues = r.openIssues.totalCount;
          if (localState) result.local = localState;

          return result;
        } catch (err) {
          return { owner, repo, error: classifyError(err) };
        }
      });

      if (args.format === "json") return jsonRespond({ repos: results });

      return formatRepoStatusMarkdown(results);
    },
  });
}
