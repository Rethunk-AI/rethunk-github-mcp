import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { FormatSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Similarity algorithm — token-set Jaccard
// ---------------------------------------------------------------------------

/**
 * Normalize a title for comparison:
 * - lowercase
 * - strip punctuation (keep alphanumeric and whitespace)
 * - collapse whitespace
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute token-set Jaccard similarity between two strings.
 * Returns a value in [0, 1] where 1 is identical token sets.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = normalizeTitle(s)
      .split(" ")
      .filter((t) => t.length > 0);
    return new Set(tokens);
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface DedupMatch {
  number: number;
  title: string;
  state: string;
  url: string;
  score: number;
  exactMatch: boolean;
}

export interface DedupResult {
  candidateTitle: string;
  scanned: number;
  matches: DedupMatch[];
  truncatedCount?: number;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const MAX_MATCHES_RETURNED = 20;

export function registerIssueDedupTool(server: FastMCP): void {
  server.addTool({
    name: "issue_dedup",
    description:
      "Before opening an issue, check for likely duplicates in the repository. Returns existing issues ranked by title similarity to the candidate title.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      title: z.string().describe("The candidate issue title to check for duplicates."),
      labels: z
        .array(z.string())
        .optional()
        .describe("Filter candidate issues by these labels (comma-joined, OR semantics)."),
      state: z
        .enum(["open", "closed", "all"])
        .optional()
        .default("open")
        .describe("Which issue states to scan. Defaults to 'open'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Maximum number of existing issues to scan. Defaults to 50."),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe("Minimum similarity score (0–1) to include in results. Defaults to 0.5."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      try {
        const octokit = getOctokit();
        const { owner, repo, title, labels, state, limit, threshold } = args;

        // Fetch existing issues (paginate returns PRs too — filter them out below)
        const allIssues = await octokit.paginate(octokit.issues.listForRepo, {
          owner,
          repo,
          state,
          ...(labels && labels.length > 0 ? { labels: labels.join(",") } : {}),
          per_page: 100,
        });

        // Filter out pull requests (they have a pull_request field), then cap to limit
        const issues = allIssues
          .filter((issue) => !("pull_request" in issue && issue.pull_request !== undefined))
          .slice(0, limit);

        const candidateNormalized = normalizeTitle(title);

        // Score each issue
        const scored: DedupMatch[] = [];
        for (const issue of issues) {
          const issueTitle = issue.title ?? "";
          const issueNormalized = normalizeTitle(issueTitle);
          const isExact = issueNormalized === candidateNormalized && candidateNormalized.length > 0;
          const score = isExact ? 1 : jaccardSimilarity(title, issueTitle);

          if (score >= threshold) {
            scored.push({
              number: issue.number,
              title: issueTitle,
              state: issue.state ?? "open",
              url: issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${issue.number}`,
              score: Math.round(score * 100) / 100,
              exactMatch: isExact,
            });
          }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Cap to top 20, track truncation
        let truncatedCount: number | undefined;
        let matches = scored;
        if (scored.length > MAX_MATCHES_RETURNED) {
          truncatedCount = scored.length - MAX_MATCHES_RETURNED;
          matches = scored.slice(0, MAX_MATCHES_RETURNED);
        }

        const result: DedupResult = {
          candidateTitle: title,
          scanned: issues.length,
          matches,
          ...(truncatedCount !== undefined ? { truncatedCount } : {}),
        };

        if (args.format === "json") return jsonRespond(result);

        // Markdown format
        const lines: string[] = [`# Issue Dedup: "${title}"`, ""];
        lines.push(`Scanned **${issues.length}** issues.`);

        if (matches.length === 0) {
          lines.push("", "No similar issues found above the similarity threshold.");
        } else {
          lines.push(
            "",
            `## Potential Duplicates (${matches.length}${truncatedCount ? ` of ${scored.length}` : ""})`,
          );
          for (const m of matches) {
            const exact = m.exactMatch ? " *(exact match)*" : "";
            lines.push(
              `- [#${m.number}](${m.url}) **${m.title}** — score: ${m.score}${exact} \`[${m.state}]\``,
            );
          }
          if (truncatedCount) {
            lines.push("", `*${truncatedCount} additional match(es) truncated.*`);
          }
        }

        return lines.join("\n");
      } catch (err) {
        console.error(
          `[issue_dedup] Failed to scan issues for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
