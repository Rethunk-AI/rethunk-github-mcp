import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema, RepoRefSchema } from "./schemas.js";
import { extractPRNumbers } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PRNode {
  number: number;
  title: string;
  labels: { nodes: { name: string }[] };
}

interface ChangelogEntry {
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr?: { number: number; title: string; labels: string[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPRMetadata(
  owner: string,
  repo: string,
  prNumbers: number[],
): Promise<Map<number, PRNode>> {
  const map = new Map<number, PRNode>();
  if (prNumbers.length === 0) return map;
  const batch = prNumbers.slice(0, 20);
  const fragments = batch.map(
    (n) => `pr${n}: pullRequest(number: ${n}) { number title labels(first:5) { nodes { name } } }`,
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
    // best-effort
  }
  return map;
}

async function fetchLatestSemverTag(owner: string, repo: string): Promise<string | undefined> {
  const octokit = getOctokit();
  try {
    const res = await octokit.repos.listTags({ owner, repo, per_page: 20 });
    const semverRe = /^v?\d+\.\d+\.\d+$/;
    return res.data.filter((t) => semverRe.test(t.name))[0]?.name;
  } catch {
    return undefined;
  }
}

/** Group entries by their first label, or "Other" if unlabeled. */
function groupByLabel(entries: ChangelogEntry[]): Map<string, ChangelogEntry[]> {
  const LABEL_ORDER = ["breaking", "feat", "fix", "docs", "chore", "deps"];
  const groups = new Map<string, ChangelogEntry[]>();
  for (const e of entries) {
    const label = e.pr?.labels.find((l) => LABEL_ORDER.includes(l.toLowerCase())) ?? "other";
    const key = label.charAt(0).toUpperCase() + label.slice(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(e);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerChangelogDraftTool(server: FastMCP): void {
  server.addTool({
    name: "changelog_draft",
    description:
      "Draft a CHANGELOG.md section for unreleased commits: compares base..head, groups entries by PR label, and outputs a formatted markdown section ready to paste. Omit `base` to auto-pick the latest semver tag.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      base: z
        .string()
        .optional()
        .describe("Base ref (tag/branch). Omit to auto-pick the latest semver tag."),
      head: z.string().optional().describe("Head ref; defaults to default branch."),
      version: z
        .string()
        .optional()
        .describe(
          "Version string for the section header (e.g. 'v1.3.0'). Defaults to 'Unreleased'.",
        ),
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
      const versionLabel = args.version ?? "Unreleased";

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
                { suggestedFix: "Create a tag (e.g. v0.1.0) or pass base explicitly." },
              ),
            );
          }
        }

        const cmp = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${base}...${head}`,
        });

        const rawCommits = cmp.data.commits.slice(0, maxCommits);
        const allPRNumbers = new Set<number>();
        for (const c of rawCommits) {
          for (const n of extractPRNumbers(c.commit.message)) allPRNumbers.add(n);
        }

        const prMap = await fetchPRMetadata(owner, repo, [...allPRNumbers]);

        const today = new Date().toISOString().substring(0, 10);

        const entries: ChangelogEntry[] = rawCommits.map((c) => {
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

        if (args.format === "json") {
          return jsonRespond({ version: versionLabel, date: today, base, head, entries });
        }

        // Markdown output — CHANGELOG.md Keep-a-Changelog style
        const lines: string[] = [`## [${versionLabel}] — ${today}`, ""];

        if (entries.length === 0) {
          lines.push("*(no commits)*");
          return lines.join("\n");
        }

        const groups = groupByLabel(entries);

        for (const [label, group] of groups) {
          lines.push(`### ${label}`, "");
          for (const e of group) {
            const prRef = e.pr
              ? ` ([#${e.pr.number}](https://github.com/${owner}/${repo}/pull/${e.pr.number}))`
              : "";
            const title = e.pr?.title ?? e.message;
            lines.push(`- ${title}${prRef}`);
          }
          lines.push("");
        }

        return lines.join("\n");
      } catch (err) {
        return errorRespond(classifyError(err));
      }
    },
  });
}
