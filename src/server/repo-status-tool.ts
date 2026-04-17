import { execFileSync } from "node:child_process";

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { graphqlQuery, parallelApi, resolveLocalRepoRemote } from "./github-client.js";
import { errorRespond, jsonRespond, truncateText } from "./json.js";
import { FormatSchema, LocalOrRemoteRepoSchema } from "./schemas.js";

interface StatusCheckNode {
  name?: string;
  conclusion?: string;
  context?: string;
  state?: string;
}

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
          contexts: { nodes: StatusCheckNode[] };
        } | null;
      };
    } | null;
    openPRs: { totalCount: number };
    draftPRs: { nodes: { isDraft: boolean }[] };
    openIssues: { totalCount: number };
  };
}

interface RepoResult {
  owner: string;
  repo: string;
  defaultBranch?: string;
  latestCommit?: { sha7: string; message: string; author: string; date: string };
  ci?: { status: string; failedChecks?: { name: string; conclusion: string }[] };
  openPRs?: number;
  draftPRs?: number;
  openIssues?: number;
  local?: { branch: string; dirty: number; ahead: number; behind: number };
  error?: string;
}

function timeAgo(dateStr: string): string {
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return `${Math.floor(sec / 604800)}w ago`;
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
    draftPRs: pullRequests(states: OPEN, first: 100) { nodes { isDraft } }
    openIssues: issues(states: OPEN) { totalCount }
  }
}`;

export function registerRepoStatusTool(server: FastMCP): void {
  server.addTool({
    name: "repo_status",
    description:
      "Multi-repo dashboard: default branch HEAD, CI status, open PR/issue counts, " +
      "latest commit. Accepts multiple repos in one call. Optionally includes local " +
      "git state when a localPath is provided.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z.array(LocalOrRemoteRepoSchema).min(1).max(20).describe("Repos to query."),
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
            return { owner: "unknown", repo: repoRef.localPath, error: "local_repo_no_remote" };
          }
          owner = resolved.owner;
          repo = resolved.repo;
          localState = getLocalGitState(repoRef.localPath);
        } else {
          owner = repoRef.owner;
          repo = repoRef.repo;
        }

        try {
          const data = await graphqlQuery<RepoQueryResult>(REPO_STATUS_QUERY, {
            owner,
            name: repo,
          });
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
              const failed = rollup.contexts.nodes
                .filter((n) => {
                  if (n.conclusion) return !["SUCCESS", "SKIPPED"].includes(n.conclusion);
                  if (n.state) return n.state !== "SUCCESS";
                  return false;
                })
                .map((n) => ({
                  name: n.name ?? n.context ?? "unknown",
                  conclusion: n.conclusion ?? n.state ?? "unknown",
                }));
              result.ci = {
                status: rollup.state.toLowerCase(),
                ...(failed.length > 0 ? { failedChecks: failed } : {}),
              };
            }
          }

          result.openPRs = r.openPRs.totalCount;
          result.draftPRs = r.draftPRs.nodes.filter((n) => n.isDraft).length;
          result.openIssues = r.openIssues.totalCount;
          if (localState) result.local = localState;

          return result;
        } catch {
          return { owner, repo, error: "not_found" };
        }
      });

      if (args.format === "json") return jsonRespond({ repos: results });

      const md = results
        .map((r) => {
          if (r.error) return `## ${r.owner}/${r.repo}\nError: ${r.error}`;
          const lines: string[] = [];
          lines.push(`## ${r.owner}/${r.repo} (${r.defaultBranch ?? "?"})`);
          if (r.latestCommit) {
            lines.push(
              `Latest: \`${r.latestCommit.sha7}\` ${r.latestCommit.message}` +
                ` — ${r.latestCommit.author}, ${r.latestCommit.date}`,
            );
          }
          if (r.ci) {
            const icon = r.ci.status === "success" ? "✓ passing" : "✗ failing";
            const extra = r.ci.failedChecks?.map((c) => c.name).join(", ");
            lines.push(`CI: ${icon}${extra ? `: ${extra}` : ""}`);
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

      return md;
    },
  });
}
