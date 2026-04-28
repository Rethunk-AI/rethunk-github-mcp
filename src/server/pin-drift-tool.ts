import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { countBehind, resolveRef } from "./compare-refs.js";
import { gateAuth } from "./github-auth.js";
import { classifyError, graphqlQuery, parallelApi, parseGitHubRemoteUrl } from "./github-client.js";
import { errorRespond, jsonRespond, type McpErrorEnvelope } from "./json.js";
import { FormatSchema } from "./schemas.js";
import { sha7, sha12 } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PinSource = "go.mod" | ".gitmodules" | "scripts/versions.env" | "package.json";

export interface PinEntry {
  source: PinSource;
  owner: string;
  repo: string;
  pinnedRef: string;
  pinnedDate?: string;
  defaultBranch: string;
  headSha: string;
  behindBy: number;
  grepMatches?: number;
  commits: { sha7: string; message: string; author: string; date: string }[];
  stale: boolean;
  /** Populated when the pin could not be resolved; `behindBy` is -1 in that case. */
  error?: McpErrorEnvelope;
}

export interface SkippedEntry {
  source: PinSource;
  key: string;
  value: string;
  reason: string;
}

export interface PinDriftResult {
  localPath: string;
  pins: PinEntry[];
  skipped: SkippedEntry[];
  summary: { totalPins: number; stale: number; upToDate: number };
}

interface HeadResult {
  repository: {
    defaultBranchRef: {
      name: string;
      target: { oid: string; committedDate: string };
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Extract 12-char SHA prefix from a Go pseudo-version: v0.0.0-YYYYMMDDHHMMSS-<sha12> */
export function pseudoVersionSha(version: string): string | undefined {
  const m = /v\d+\.\d+\.\d+-\d{14}-([0-9a-f]{12})$/.exec(version);
  return m?.[1];
}

export interface RawPin {
  source: PinSource;
  owner: string;
  repo: string;
  pinnedRef: string; // SHA or branch/tag
}

/** Parse go.mod for replace directives and pseudo-version requires pointing at GitHub. */
export function parseGoMod(localPath: string): { pins: RawPin[]; skipped: SkippedEntry[] } {
  const goModPath = join(localPath, "go.mod");
  if (!existsSync(goModPath)) return { pins: [], skipped: [] };

  const pins: RawPin[] = [];
  const skipped: SkippedEntry[] = [];
  const text = readFileSync(goModPath, "utf8");

  // Replace directives: `replace X => github.com/owner/repo vVersion`
  for (const m of text.matchAll(/^[ \t]*replace\s+\S+\s+=>\s+(github\.com\/\S+)\s+(\S+)/gm)) {
    const path = m[1];
    const version = m[2];
    if (!path || !version) continue;

    const pathParts = /github\.com\/([^/]+)\/([^/]+)/.exec(path);
    if (!pathParts?.[1] || !pathParts[2]) continue;
    const owner = pathParts[1];
    const repo = pathParts[2].replace(/\.git$/, "");

    const sha12 = pseudoVersionSha(version);
    if (sha12) {
      pins.push({ source: "go.mod", owner, repo, pinnedRef: sha12 });
    } else if (/^v\d+\.\d+\.\d+$/.test(version)) {
      pins.push({ source: "go.mod", owner, repo, pinnedRef: version });
    } else {
      skipped.push({
        source: "go.mod",
        key: `replace ${path}`,
        value: version,
        reason: "ambiguous_ref",
      });
    }
  }

  // Require lines with pseudo-versions for github.com modules
  for (const m of text.matchAll(/^[ \t]*(?:github\.com\/([^/\s]+)\/([^/\s]+))\s+(v\S+)/gm)) {
    const owner = m[1];
    const repo = m[2]?.replace(/\.git$/, "");
    const version = m[3];
    if (!owner || !repo || !version) continue;

    // Only pseudo-versions (not a tagged release or branch)
    const sha12 = pseudoVersionSha(version);
    if (!sha12) continue;

    // Avoid duplicates from replace block
    const alreadyPinned = pins.some((p) => p.owner === owner && p.repo === repo);
    if (alreadyPinned) continue;

    pins.push({ source: "go.mod", owner, repo, pinnedRef: sha12 });
  }

  return { pins, skipped };
}

/** Parse .gitmodules for submodule URLs, then read pinned SHAs via git ls-tree. */
function parseGitModules(localPath: string): { pins: RawPin[]; skipped: SkippedEntry[] } {
  const gmPath = join(localPath, ".gitmodules");
  if (!existsSync(gmPath)) return { pins: [], skipped: [] };

  const pins: RawPin[] = [];
  const skipped: SkippedEntry[] = [];
  const text = readFileSync(gmPath, "utf8");

  // Collect submodule entries: each block has a path and url
  const blocks = text.split(/^\[submodule /m).slice(1);
  for (const block of blocks) {
    const pathMatch = /^\s*path\s*=\s*(.+)$/m.exec(block);
    const urlMatch = /^\s*url\s*=\s*(.+)$/m.exec(block);
    if (!pathMatch?.[1] || !urlMatch?.[1]) continue;

    const subPath = pathMatch[1].trim();
    const url = urlMatch[1].trim();
    const ownerRepo = parseGitHubRemoteUrl(url);
    if (!ownerRepo) {
      skipped.push({
        source: ".gitmodules",
        key: subPath,
        value: url,
        reason: "not_github",
      });
      continue;
    }

    // Read pinned SHA from git ls-tree
    try {
      const lsOut = execFileSync("git", ["ls-tree", "HEAD", subPath], {
        cwd: localPath,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // Format: <mode> commit <sha>\t<path>
      const shaMatch = /^\d+\s+commit\s+([0-9a-f]{40})\t/.exec(lsOut);
      if (!shaMatch?.[1]) {
        skipped.push({
          source: ".gitmodules",
          key: subPath,
          value: url,
          reason: "ls_tree_no_sha",
        });
        continue;
      }
      pins.push({
        source: ".gitmodules",
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        pinnedRef: shaMatch[1],
      });
    } catch (err) {
      console.error(
        `[parseGitModules] Failed to read git SHA for submodule '${subPath}':`,
        err instanceof Error ? err.message : String(err),
      );
      skipped.push({
        source: ".gitmodules",
        key: subPath,
        value: url,
        reason: "ls_tree_failed",
      });
    }
  }

  return { pins, skipped };
}

/** Parse scripts/versions.env for KEY=VALUE lines where value is a 40-char hex SHA. */
export function parseVersionsEnv(localPath: string): { skipped: SkippedEntry[] } {
  const envPath = join(localPath, "scripts", "versions.env");
  if (!existsSync(envPath)) return { skipped: [] };

  const skipped: SkippedEntry[] = [];
  const text = readFileSync(envPath, "utf8");

  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+(?:_REF|_SHA|_VERSION))\s*=\s*([^\s#]+)/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const key = m[1];
    const value = m[2];
    if (/^[0-9a-f]{40}$/.test(value)) {
      // Can't infer which repo this belongs to — mark as skipped
      skipped.push({
        source: "scripts/versions.env",
        key,
        value,
        reason: "ambiguous_repo",
      });
    }
  }

  return { skipped };
}

/** Parse package.json for dependencies pinned to GitHub URLs. */
export function parsePackageJson(localPath: string): { pins: RawPin[]; skipped: SkippedEntry[] } {
  const pkgPath = join(localPath, "package.json");
  if (!existsSync(pkgPath)) return { pins: [], skipped: [] };

  const pins: RawPin[] = [];
  const skipped: SkippedEntry[] = [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[parsePackageJson] Failed to parse ${pkgPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { pins, skipped };
  }

  const allDeps: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  for (const [, version] of Object.entries(allDeps)) {
    // GitHub shorthand: "owner/repo" or "owner/repo#sha/branch"
    const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(.+))?$/.exec(version);
    if (shorthand?.[1] && shorthand[2]) {
      const owner = shorthand[1];
      const repo = shorthand[2];
      const ref = shorthand[3] ?? "HEAD";
      pins.push({ source: "package.json", owner, repo, pinnedRef: ref });
      continue;
    }

    // Full GitHub URL: https://github.com/owner/repo.git#sha or tarball URL
    const ghUrl =
      /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?(?:$|\/)/.exec(
        version,
      );
    if (ghUrl?.[1] && ghUrl[2]) {
      const owner = ghUrl[1];
      const repo = ghUrl[2];
      const ref = ghUrl[3] ?? "HEAD";
      pins.push({ source: "package.json", owner, repo, pinnedRef: ref });
    }
    // Not a GitHub dependency — skip silently
  }

  return { pins, skipped };
}

export function formatPinDriftMarkdown(result: PinDriftResult): string {
  const { localPath, pins, skipped, summary } = result;
  const lines: string[] = [];
  lines.push(`# Pin Drift: ${localPath}`);
  lines.push("");
  lines.push(
    `**${pins.length} pins** — ${summary.stale} stale, ${summary.upToDate} up to date` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
  );

  if (summary.stale > 0) {
    lines.push("");
    lines.push("## Stale Pins");
    lines.push("| Source | Repo | Behind | Pinned SHA |");
    lines.push("|--------|------|--------|------------|");
    for (const p of pins.filter((x) => x.stale)) {
      const sha = sha12(p.pinnedRef);
      lines.push(`| ${p.source} | ${p.owner}/${p.repo} | ${p.behindBy} | \`${sha}\` |`);
    }
  }

  const fresh = pins.filter((p) => !p.stale && p.behindBy >= 0);
  if (fresh.length > 0) {
    lines.push("");
    lines.push("## Up to Date");
    lines.push(fresh.map((p) => `${p.owner}/${p.repo}`).join(", "));
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push("## Skipped");
    lines.push("| Source | Key | Reason |");
    lines.push("|--------|-----|--------|");
    for (const s of skipped) {
      lines.push(`| ${s.source} | \`${s.key}\` | ${s.reason} |`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const HEAD_QUERY = `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){
    defaultBranchRef{ name target{ ...on Commit{ oid committedDate } } }
  }
}`;

/**
 * Expand a list of pin file patterns against files that actually exist in `localPath`.
 * Patterns without a '*' are treated as literal relative paths.
 * Patterns with '*' are matched as simple glob-style patterns against known file names.
 */
function expandPinFiles(patterns: string[], localPath: string): string[] {
  const knownFiles = ["go.mod", ".gitmodules", "scripts/versions.env", "package.json"];

  const expanded = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      // Literal path — accept as-is if it exists
      if (existsSync(join(localPath, pattern))) expanded.add(pattern);
      else expanded.add(pattern); // include anyway; parsers will early-return if absent
      continue;
    }
    // Convert glob to regex: only support * and ** wildcards
    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".+")
          .replace(/\*/g, "[^/]+") +
        "$",
    );
    for (const known of knownFiles) {
      if (re.test(known)) expanded.add(known);
    }
    // Also try matching against actual directory contents for unknown files
    try {
      const entries = readdirSync(localPath, { recursive: true }) as string[];
      for (const entry of entries) {
        if (re.test(String(entry))) expanded.add(String(entry));
      }
    } catch (err) {
      // directory not readable
      console.error(
        `[expandPinFiles] Failed to read directory ${localPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return [...expanded];
}

export function registerPinDriftTool(server: FastMCP): void {
  server.addTool({
    name: "pin_drift",
    description:
      "Audit upstream pin drift in a local repo: checks go.mod (replace + pseudo-versions), " +
      ".gitmodules, scripts/versions.env, and package.json against upstream default branches.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      localPath: z.string().describe("Absolute path to the local repo to audit."),
      pinFiles: z
        .array(z.string())
        .optional()
        .describe(
          "Pin files to parse; supports glob patterns (e.g. '**/versions.env'). Defaults to auto-detect.",
        ),
      ownerAllowlist: z
        .array(z.string())
        .optional()
        .describe("Restrict to these GitHub owners (case-insensitive)."),
      grep: z
        .string()
        .optional()
        .describe("Regex; matching commits are tallied in grepMatches (behindBy is unaffected)."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { localPath, ownerAllowlist, grep } = args;
      const grepRe = grep ? new RegExp(grep, "i") : undefined;

      // Collect pins from each source
      const allPins: RawPin[] = [];
      const allSkipped: SkippedEntry[] = [];

      const autoFiles = ["go.mod", ".gitmodules", "scripts/versions.env", "package.json"];
      const filesToCheck = args.pinFiles ? expandPinFiles(args.pinFiles, localPath) : autoFiles;

      if (filesToCheck.includes("go.mod")) {
        const { pins, skipped } = parseGoMod(localPath);
        allPins.push(...pins);
        allSkipped.push(...skipped);
      }
      if (filesToCheck.includes(".gitmodules")) {
        const { pins, skipped } = parseGitModules(localPath);
        allPins.push(...pins);
        allSkipped.push(...skipped);
      }
      if (filesToCheck.includes("scripts/versions.env")) {
        const { skipped } = parseVersionsEnv(localPath);
        allSkipped.push(...skipped);
      }
      if (filesToCheck.includes("package.json")) {
        const { pins, skipped } = parsePackageJson(localPath);
        allPins.push(...pins);
        allSkipped.push(...skipped);
      }

      // Deduplicate by owner+repo (keep first occurrence)
      const seen = new Set<string>();
      const uniquePins: RawPin[] = [];
      for (const pin of allPins) {
        const key = `${pin.owner.toLowerCase()}/${pin.repo.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniquePins.push(pin);
        }
      }

      // Apply owner allowlist filter
      const filteredPins = ownerAllowlist
        ? uniquePins.filter((p) =>
            ownerAllowlist.some((a) => a.toLowerCase() === p.owner.toLowerCase()),
          )
        : uniquePins;

      // Fan out: resolve each pin against GitHub
      const pinResults = await parallelApi(filteredPins, async (pin): Promise<PinEntry> => {
        try {
          // Resolve pinned SHA date
          const pinResolved = await resolveRef(pin.owner, pin.repo, pin.pinnedRef);
          const pinnedDate = pinResolved?.committedDate;

          // Get default branch + head SHA
          const headData = await graphqlQuery<HeadResult>(HEAD_QUERY, {
            owner: pin.owner,
            repo: pin.repo,
          });
          const dbRef = headData.repository.defaultBranchRef;
          if (!dbRef) {
            return {
              source: pin.source,
              owner: pin.owner,
              repo: pin.repo,
              pinnedRef: pin.pinnedRef,
              defaultBranch: "unknown",
              headSha: "",
              behindBy: -1,
              commits: [],
              stale: false,
              error: {
                code: "NOT_FOUND",
                message: `Upstream ${pin.owner}/${pin.repo} has no default branch or is inaccessible.`,
                retryable: false,
              },
            };
          }

          const defaultBranch = dbRef.name;
          const headSha = dbRef.target.oid;

          // Already at head?
          if (headSha.startsWith(pin.pinnedRef) || pin.pinnedRef.startsWith(sha7(headSha))) {
            return {
              source: pin.source,
              owner: pin.owner,
              repo: pin.repo,
              pinnedRef: pin.pinnedRef,
              ...(pinnedDate ? { pinnedDate } : {}),
              defaultBranch,
              headSha,
              behindBy: 0,
              commits: [],
              stale: false,
            };
          }

          // Full SHA to resolve for count-behind
          const fullPinnedSha = pinResolved?.oid ?? pin.pinnedRef;
          const { behindBy, commits } = await countBehind(
            pin.owner,
            pin.repo,
            defaultBranch,
            fullPinnedSha,
            100,
          );

          const grepMatches = grepRe
            ? commits.filter((c) => grepRe.test(c.message)).length
            : undefined;

          return {
            source: pin.source,
            owner: pin.owner,
            repo: pin.repo,
            pinnedRef: pin.pinnedRef,
            ...(pinnedDate ? { pinnedDate } : {}),
            defaultBranch,
            headSha,
            behindBy,
            ...(grepMatches !== undefined ? { grepMatches } : {}),
            commits: commits.map((c) => ({
              sha7: c.sha7,
              message: c.message,
              author: c.author,
              date: c.date,
            })),
            stale: behindBy > 0,
          };
        } catch (err) {
          console.error(
            `[pin_drift] Failed to resolve pin ${pin.owner}/${pin.repo}:${pin.pinnedRef}:`,
            err instanceof Error ? err.message : String(err),
          );
          return {
            source: pin.source,
            owner: pin.owner,
            repo: pin.repo,
            pinnedRef: pin.pinnedRef,
            defaultBranch: "unknown",
            headSha: "",
            behindBy: -1,
            commits: [],
            stale: false,
            error: classifyError(err),
          };
        }
      });

      const staleCount = pinResults.filter((p) => p.stale).length;
      const upToDate = pinResults.filter((p) => !p.stale && p.behindBy >= 0).length;

      const result: PinDriftResult = {
        localPath,
        pins: pinResults,
        skipped: allSkipped,
        summary: { totalPins: pinResults.length, stale: staleCount, upToDate },
      };

      if (args.format === "json") return jsonRespond(result);

      return formatPinDriftMarkdown(result);
    },
  });
}
