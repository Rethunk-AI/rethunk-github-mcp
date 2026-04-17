import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, truncateText } from "./json.js";
import { FormatSchema, RepoRefSchema } from "./schemas.js";

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

function extractPRNumbers(message: string): number[] {
  const result: number[] = [];
  for (const m of message.matchAll(/\(#(\d+)\)/g)) {
    const raw = m[1];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n)) result.push(n);
  }
  return result;
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

export function registerReleaseReadinessTool(server: FastMCP): void {
  server.addTool({
    name: "release_readiness",
    description:
      "What would ship if we release now? Compares a base ref (tag/branch) to head, " +
      "showing unreleased commits with their associated PRs, CI status on head, and " +
      "summary stats.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      base: z.string().describe("Base ref to compare from (e.g. 'v1.2.0' or 'release/1.2')."),
      head: z.string().optional().describe("Head ref. Defaults to the repo's default branch."),
      maxCommits: z.number().int().min(1).max(200).optional().default(50),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const octokit = getOctokit();
      const { owner, repo, base, maxCommits } = args;
      let head = args.head;

      try {
        if (!head) {
          const repoData = await octokit.repos.get({ owner, repo });
          head = repoData.data.default_branch;
        }

        const cmp = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${base}...${head}`,
        });

        const aheadBy = cmp.data.ahead_by;
        const rawCommits = cmp.data.commits.slice(0, maxCommits);

        // Extract PR numbers from commit messages
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

        // Markdown
        const lines: string[] = [
          `# Release Readiness: ${owner}/${repo}`,
          "",
          `**Comparing:** ${base} → ${head} (${aheadBy} commits ahead)`,
        ];

        const ciIcon =
          ciStatus.status === "success"
            ? "✓ passing"
            : ciStatus.status === "not_configured"
              ? "⊘ not configured"
              : "✗ failing";
        const failedNames = ciStatus.failedChecks.map((c) => c.name).join(", ");
        lines.push(`**CI on head:** ${ciIcon}${failedNames ? `: ${failedNames}` : ""}`);
        lines.push("", "## Unreleased Commits");

        if (commits.length === 0) {
          lines.push("*(no commits)*");
        } else {
          lines.push("| SHA | Message | Author | PR |", "|-----|---------|--------|----|");
          for (const c of commits) {
            const msg = truncateText(c.message, 72);
            const pr = c.pr ? `#${c.pr.number} (${c.pr.labels.join(", ")})` : "—";
            lines.push(`| \`${c.sha7}\` | ${msg} | ${c.author} | ${pr} |`);
          }
        }

        lines.push(
          "",
          "## Stats",
          `+${stats.additions} −${stats.deletions} across ${stats.changedFiles} files`,
        );

        return lines.join("\n");
      } catch (err) {
        return errorRespond(classifyError(err));
      }
    },
  });
}
