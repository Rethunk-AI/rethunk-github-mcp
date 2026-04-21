import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, mkError, truncateText } from "./json.js";
import { FormatSchema, RepoRefSchema } from "./schemas.js";
import { extractPRNumbers } from "./utils.js";

interface PRNode {
  number: number;
  title: string;
  labels: { nodes: { name: string }[] };
  state: string;
}

interface CINode {
  name?: string;
  conclusion?: string;
  context?: string;
  state?: string;
}

interface CommitForRelease {
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr?: { number: number; title: string; labels: string[] };
}

async function fetchPRMetadata(
  owner: string,
  repo: string,
  prNumbers: number[],
): Promise<Map<number, PRNode>> {
  const map = new Map<number, PRNode>();
  if (prNumbers.length === 0) return map;

  const batch = prNumbers.slice(0, 20);
  const fragments = batch.map(
    (n) =>
      `pr${n}: pullRequest(number: ${n}) { number title state labels(first:5) { nodes { name } } }`,
  );
  const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fragments.join(" ")}}}`;

  try {
    const data = await graphqlQuery<{ repository: Record<string, PRNode | null> }>(query, {
      owner,
      repo,
    });
    for (const n of batch) {
      const pr = data.repository[`pr${n}`];
      if (pr) map.set(n, pr);
    }
  } catch {
    // PR resolution is best-effort
  }
  return map;
}

async function fetchHeadCI(
  owner: string,
  repo: string,
  headRef: string,
): Promise<{ status: string; failedChecks: { name: string; conclusion: string }[] }> {
  const query = `query($owner:String!,$repo:String!){
    repository(owner:$owner,name:$repo){
      object(expression:"${headRef}"){
        ...on Commit{statusCheckRollup{state contexts(first:20){nodes{...on CheckRun{name conclusion}...on StatusContext{context state}}}}}
      }
    }
  }`;

  try {
    const data = await graphqlQuery<{
      repository: {
        object: {
          statusCheckRollup: { state: string; contexts: { nodes: CINode[] } } | null;
        } | null;
      };
    }>(query, { owner, repo });

    const rollup = data.repository.object?.statusCheckRollup;
    if (!rollup) return { status: "not_configured", failedChecks: [] };

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

    return { status: rollup.state.toLowerCase(), failedChecks: failed };
  } catch {
    return { status: "error_fetching", failedChecks: [] };
  }
}

/** Fetch the latest semver tag (vX.Y.Z) for a repo. Returns undefined if none found. */
async function fetchLatestSemverTag(owner: string, repo: string): Promise<string | undefined> {
  const octokit = getOctokit();
  try {
    const res = await octokit.repos.listTags({ owner, repo, per_page: 20 });
    const semverRe = /^v?\d+\.\d+\.\d+$/;
    const tags = res.data.filter((t) => semverRe.test(t.name));
    return tags[0]?.name;
  } catch {
    return undefined;
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
      maxCommits: z.number().int().min(1).max(200).optional().default(50),
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
          base = await fetchLatestSemverTag(owner, repo);
          if (!base) {
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
            sha7: c.sha.substring(0, 7),
            message: c.commit.message.split("\n")[0] ?? "",
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
        return errorRespond(classifyError(err));
      }
    },
  });
}
