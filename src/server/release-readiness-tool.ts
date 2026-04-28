import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  fetchLatestSemverTag,
  fetchPRMetadata,
  getOctokit,
  graphqlQuery,
} from "./github-client.js";
import { errorRespond, jsonRespond, mkError, truncateText } from "./json.js";
import { FormatSchema, MaxCommitsSchema, RepoRefSchema } from "./schemas.js";
import {
  type CheckNode,
  extractPRNumbers,
  firstLine,
  normalizeFailedChecks,
  sha7,
} from "./utils.js";

interface CommitForRelease {
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr?: { number: number; title: string; labels: string[] };
}

async function fetchHeadCI(
  owner: string,
  repo: string,
  headRef: string,
): Promise<{ status: string; failedChecks: { name: string; conclusion: string }[] }> {
  const query = `query($owner:String!,$repo:String!,$expr:String!){
    repository(owner:$owner,name:$repo){
      object(expression:$expr){
        ...on Commit{statusCheckRollup{state contexts(first:20){nodes{...on CheckRun{name conclusion}...on StatusContext{context state}}}}}
      }
    }
  }`;

  try {
    const data = await graphqlQuery<{
      repository: {
        object: {
          statusCheckRollup: { state: string; contexts: { nodes: CheckNode[] } } | null;
        } | null;
      };
    }>(query, { owner, repo, expr: headRef });

    const rollup = data.repository.object?.statusCheckRollup;
    if (!rollup) return { status: "not_configured", failedChecks: [] };

    const failed = normalizeFailedChecks(rollup.contexts.nodes);

    return { status: rollup.state.toLowerCase(), failedChecks: failed };
  } catch (err) {
    console.error(
      `[fetchHeadCI] Failed to fetch CI status for ${owner}/${repo} @ ${headRef}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { status: "error_fetching", failedChecks: [] };
  }
}

export function registerReleaseReadinessTool(server: FastMCP): void {
  server.addTool({
    name: "release_readiness",
    description:
      "Unreleased-commit scope report: compares base..head, lists commits with PRs, CI status on head, and diff stats. " +
      "Omit `base` to auto-pick the latest semver tag.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      base: z
        .string()
        .optional()
        .describe("Base ref (tag/branch). Omit to auto-pick the latest semver tag."),
      head: z.string().optional().describe("Head ref; defaults to default branch."),
      maxCommits: MaxCommitsSchema,
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const octokit = getOctokit();
      const { owner, repo, maxCommits } = args;
      let head = args.head;
      let base = args.base;

      try {
        if (!head) {
          const repoData = await octokit.repos.get({ owner, repo });
          head = repoData.data.default_branch;
        }

        if (!base) {
          const fetchedTag = await fetchLatestSemverTag(owner, repo);
          if (fetchedTag === null) {
            return errorRespond(
              mkError(
                "NOT_FOUND",
                `No semver tag found in ${owner}/${repo}; pass base explicitly.`,
                {
                  suggestedFix: "Create a tag (e.g. v0.1.0) or pass base explicitly.",
                },
              ),
            );
          }
          base = fetchedTag;
        }

        const cmp = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${base}...${head}`,
        });

        const aheadBy = cmp.data.ahead_by;
        const rawCommits = cmp.data.commits.slice(0, maxCommits);

        const allPRNumbers = new Set<number>();
        for (const c of rawCommits) {
          for (const n of extractPRNumbers(c.commit.message)) allPRNumbers.add(n);
        }

        const prMap = await fetchPRMetadata(owner, repo, [...allPRNumbers]);
        const ciStatus = await fetchHeadCI(owner, repo, head);

        const commits: CommitForRelease[] = rawCommits.map((c) => {
          const prNums = extractPRNumbers(c.commit.message);
          const firstPR = prNums[0] !== undefined ? prMap.get(prNums[0]) : undefined;
          return {
            sha7: sha7(c.sha),
            message: firstLine(c.commit.message),
            author: c.commit.author?.name ?? c.author?.login ?? "unknown",
            date: c.commit.author?.date ?? "",
            ...(firstPR
              ? {
                  pr: {
                    number: firstPR.number,
                    title: firstPR.title,
                    labels: firstPR.labels.nodes.map((l) => l.name),
                  },
                }
              : {}),
          };
        });

        const stats = {
          additions: (cmp.data.files ?? []).reduce((s, f) => s + f.additions, 0),
          deletions: (cmp.data.files ?? []).reduce((s, f) => s + f.deletions, 0),
          changedFiles: cmp.data.files?.length ?? 0,
        };

        const result = { base, head, aheadBy, headCi: ciStatus, commits, stats };

        if (args.format === "json") return jsonRespond(result);

        // Markdown — compact single-line list instead of full table
        const lines: string[] = [
          `# Release Readiness: ${owner}/${repo}`,
          "",
          `${base} → ${head} (${aheadBy} commits ahead)`,
        ];

        const ciState =
          ciStatus.status === "success"
            ? "CI: passing"
            : ciStatus.status === "not_configured"
              ? "CI: not configured"
              : `CI: failing (${ciStatus.failedChecks.map((c) => c.name).join(", ")})`;
        lines.push(ciState, "");

        if (commits.length === 0) {
          lines.push("*(no commits)*");
        } else {
          lines.push("## Unreleased Commits");
          for (const c of commits) {
            const msg = truncateText(c.message, 72);
            const pr = c.pr ? ` [#${c.pr.number}]` : "";
            lines.push(`- \`${c.sha7}\` ${msg}${pr} — ${c.author}`);
          }
        }

        lines.push(
          "",
          `+${stats.additions} −${stats.deletions} across ${stats.changedFiles} files`,
        );

        return lines.join("\n");
      } catch (err) {
        console.error(
          `[release_readiness] Failed to generate release readiness report for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
