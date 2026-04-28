import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  fetchLatestSemverTag,
  fetchPRMetadata,
  getOctokit,
} from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema, MaxCommitsSchema, RepoRefSchema } from "./schemas.js";
import { extractPRNumbers, firstLine, sha7 } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
      const versionLabel = args.version ?? "Unreleased";

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
                { suggestedFix: "Create a tag (e.g. v0.1.0) or pass base explicitly." },
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
