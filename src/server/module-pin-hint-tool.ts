import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, graphqlQuery } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema } from "./schemas.js";
import { sha12 } from "./utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a UTC ISO8601 date string as `YYYYMMDDHHMMSS`.
 * Input: "2026-04-13T00:17:01Z" → "20260413001701"
 */
export function formatPseudoVersionDate(isoDate: string): string {
  // Strip non-digit chars, keep only the 14-char datetime portion
  const d = new Date(isoDate);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/** Build a Go pseudo-version: v0.0.0-YYYYMMDDHHMMSS-<sha12> */
export function buildGoPseudoVersion(committedDate: string, fullSha: string): string {
  const ts = formatPseudoVersionDate(committedDate);
  return `v0.0.0-${ts}-${sha12(fullSha)}`;
}

export interface ModulePinHintResult {
  owner: string;
  repo: string;
  ref: string;
  resolvedSha: string;
  committerDate: string;
  goPseudoVersion: string;
}

export function formatModulePinHintMarkdown(result: ModulePinHintResult): string {
  return [
    `# Go Pseudo-Version: ${result.owner}/${result.repo}`,
    "",
    `**Ref:** \`${result.ref}\``,
    `**SHA:** \`${result.resolvedSha}\``,
    `**Committed:** ${result.committerDate}`,
    "",
    "## Pseudo-version",
    "```",
    result.goPseudoVersion,
    "```",
    "",
    "## go.mod snippet",
    "```go",
    `require github.com/${result.owner}/${result.repo} ${result.goPseudoVersion}`,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

interface CommitObjectResult {
  repository: {
    defaultBranchRef?: { name: string; target?: { oid: string; committedDate: string } } | null;
    object?: { oid: string; committedDate: string } | null;
  };
}

async function resolveCommit(
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<{ oid: string; committedDate: string; resolvedRef: string } | null> {
  if (ref) {
    // Explicit ref: fetch object by expression
    const query = `query($owner:String!,$repo:String!,$expr:String!){
      repository(owner:$owner,name:$repo){
        object(expression:$expr){
          ...on Commit{ oid committedDate }
        }
      }
    }`;
    const data = await graphqlQuery<CommitObjectResult>(query, { owner, repo, expr: ref });
    const obj = data.repository.object;
    if (!obj?.oid) return null;
    return { oid: obj.oid, committedDate: obj.committedDate, resolvedRef: ref };
  }

  // Default branch HEAD
  const query = `query($owner:String!,$repo:String!){
    repository(owner:$owner,name:$repo){
      defaultBranchRef{
        name
        target{ ...on Commit{ oid committedDate } }
      }
    }
  }`;
  const data = await graphqlQuery<CommitObjectResult>(query, { owner, repo });
  const dbRef = data.repository.defaultBranchRef;
  if (!dbRef?.target?.oid) return null;
  return {
    oid: dbRef.target.oid,
    committedDate: dbRef.target.committedDate ?? "",
    resolvedRef: dbRef.name,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerModulePinHintTool(server: FastMCP): void {
  server.addTool({
    name: "module_pin_hint",
    description:
      "Returns the correctly-formatted Go module pseudo-version (v0.0.0-YYYYMMDDHHMMSS-sha12) for a given repo+ref. Useful for `go.mod` SHA pins.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      ref: z.string().optional().describe("Branch, tag, or SHA; defaults to default branch HEAD."),
      language: z
        .string()
        .optional()
        .default("go")
        .describe("Module system (only 'go' supported)."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, language } = args;
      const ref = args.ref;

      if (language !== "go") {
        return errorRespond(
          mkError("UNSUPPORTED_LANGUAGE", `Language '${language}' is not supported.`, {
            suggestedFix: "Only 'go' is supported in the current version.",
          }),
        );
      }

      try {
        const commit = await resolveCommit(owner, repo, ref);
        if (!commit) {
          return errorRespond(
            mkError(
              "NOT_FOUND",
              `Ref '${ref ?? "(default branch)"}' not found in ${owner}/${repo}.`,
            ),
          );
        }

        const goPseudoVersion = buildGoPseudoVersion(commit.committedDate, commit.oid);

        const result: ModulePinHintResult = {
          owner,
          repo,
          ref: commit.resolvedRef,
          resolvedSha: commit.oid,
          committerDate: commit.committedDate,
          goPseudoVersion,
        };

        if (args.format === "json") return jsonRespond(result);

        return formatModulePinHintMarkdown(result);
      } catch (err) {
        console.error(
          `[module_pin_hint] Failed to resolve pseudo-version for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
