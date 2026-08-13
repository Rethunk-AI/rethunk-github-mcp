import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  fetchLatestSemverTag,
  fetchPRMetadata,
  getOctokit,
  parallelApi,
  resolveLocalRepoRemote,
} from "./github-client.js";
import {
  errorRespond,
  jsonRespond,
  type McpErrorEnvelope,
  mkError,
  mkLocalRepoNoRemote,
} from "./json.js";
import { resolveOptionalLocalPath } from "./roots.js";
import {
  FormatSchema,
  LocalOrRemoteRepoSchema,
  MAX_REPOS_PER_REQUEST,
  MaxCommitsSchema,
} from "./schemas.js";
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

export interface ChangelogResult {
  owner: string;
  repo: string;
  version?: string;
  date?: string;
  base?: string;
  head?: string;
  entries?: ChangelogEntry[];
  truncatedCount?: number;
  error?: McpErrorEnvelope;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LABEL_ORDER = ["breaking", "feat", "fix", "docs", "chore", "deps"];

/** Group entries by their first label, or "Other" if unlabeled. */
function groupByLabel(entries: ChangelogEntry[]): Map<string, ChangelogEntry[]> {
  const groups = new Map<string, ChangelogEntry[]>();
  for (const e of entries) {
    const label = e.pr?.labels.find((l) => LABEL_ORDER.includes(l.toLowerCase())) ?? "other";
    const key = label.charAt(0).toUpperCase() + label.slice(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(e);
  }
  return groups;
}

/**
 * Iterate a group map in LABEL_ORDER order, with any unrecognised labels after,
 * and "Other" last.  Returns [label, entries] pairs.
 */
function orderedGroups(groups: Map<string, ChangelogEntry[]>): [string, ChangelogEntry[]][] {
  const result: [string, ChangelogEntry[]][] = [];
  // Emit recognised labels first, in canonical order
  for (const raw of LABEL_ORDER) {
    const key = raw.charAt(0).toUpperCase() + raw.slice(1);
    const group = groups.get(key);
    if (group) result.push([key, group]);
  }
  // Emit any keys that aren't in LABEL_ORDER and aren't "Other"
  for (const [key, group] of groups) {
    const lower = key.toLowerCase();
    if (!LABEL_ORDER.includes(lower) && lower !== "other") {
      result.push([key, group]);
    }
  }
  // Emit "Other" last
  const other = groups.get("Other");
  if (other) result.push(["Other", other]);
  return result;
}

/** Render one repo's changelog section as markdown; concatenated across repos by the caller. */
export function formatChangelogMarkdown(results: ChangelogResult[]): string {
  return results
    .map((r) => {
      if (r.error) return `## ${r.owner}/${r.repo}\nError (${r.error.code}): ${r.error.message}`;

      const lines: string[] = [`## ${r.owner}/${r.repo}`, "", `### [${r.version}] — ${r.date}`, ""];

      const entries = r.entries ?? [];
      if (entries.length === 0) {
        lines.push("*(no commits)*");
        return lines.join("\n");
      }

      const groups = groupByLabel(entries);
      for (const [label, group] of orderedGroups(groups)) {
        lines.push(`#### ${label}`, "");
        for (const e of group) {
          const prRef = e.pr
            ? ` ([#${e.pr.number}](https://github.com/${r.owner}/${r.repo}/pull/${e.pr.number}))`
            : "";
          const title = e.pr?.title ?? e.message;
          lines.push(`- ${title}${prRef}`);
        }
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerChangelogDraftTool(server: FastMCP): void {
  server.addTool({
    name: "changelog_draft",
    description: `Draft a CHANGELOG.md section for unreleased commits: compares base..head per repo, groups entries by PR label, and outputs a formatted markdown section ready to paste. Omit \`base\` to auto-pick the latest semver tag. Accepts up to ${MAX_REPOS_PER_REQUEST} repos; omit repos to use the active MCP workspace root.`,
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z
        .array(LocalOrRemoteRepoSchema)
        .min(1)
        .max(MAX_REPOS_PER_REQUEST)
        .optional()
        .describe("Repos to query."),
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

      const octokit = getOctokit();
      const versionLabel = args.version ?? "Unreleased";

      const results = await parallelApi(repoRefs, async (repoRef): Promise<ChangelogResult> => {
        let owner: string;
        let repo: string;

        if ("localPath" in repoRef) {
          const localPath =
            resolveOptionalLocalPath(server, repoRef.localPath) ?? repoRef.localPath;
          const resolved = resolveLocalRepoRemote(localPath);
          if (!resolved) {
            return {
              owner: "unknown",
              repo: localPath,
              error: mkLocalRepoNoRemote(localPath),
            };
          }
          owner = resolved.owner;
          repo = resolved.repo;
        } else {
          owner = repoRef.owner;
          repo = repoRef.repo;
        }

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
              return {
                owner,
                repo,
                error: mkError(
                  "NOT_FOUND",
                  `No semver tag found in ${owner}/${repo}; pass base explicitly.`,
                  { suggestedFix: "Create a tag (e.g. v0.1.0) or pass base explicitly." },
                ),
              };
            }
            base = fetchedTag;
          }

          const cmp = await octokit.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${base}...${head}`,
          });

          const rawCommits = cmp.data.commits.slice(0, args.maxCommits);
          // total_commits reflects the true count ahead; the compare endpoint caps
          // returned commits at 250, and maxCommits may further truncate.
          const totalCommits: number =
            (cmp.data as { total_commits?: number }).total_commits ?? cmp.data.commits.length;
          const rawTruncatedCount = totalCommits - rawCommits.length;
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

          return {
            owner,
            repo,
            version: versionLabel,
            date: today,
            base,
            head,
            entries,
            ...(rawTruncatedCount > 0 ? { truncatedCount: rawTruncatedCount } : {}),
          };
        } catch (err) {
          console.error(
            `[changelog_draft] Failed to generate changelog for ${owner}/${repo}:`,
            err instanceof Error ? err.message : String(err),
          );
          return { owner, repo, error: classifyError(err) };
        }
      });

      if (args.format === "json") return jsonRespond({ repos: results });

      return formatChangelogMarkdown(results);
    },
  });
}
