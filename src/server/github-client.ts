import { execFileSync } from "node:child_process";
import { graphql as octokitGraphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

import {
  gateAuth,
  invalidateAllAuthCaches,
  registerAuthInvalidationCallback,
} from "./github-auth.js";
import { type McpErrorEnvelope, mkError } from "./json.js";

let cachedOctokit: Octokit | undefined;
let cachedGraphql: typeof octokitGraphql | undefined;

// Register with github-auth so that invalidateAllAuthCaches() also wipes these.
registerAuthInvalidationCallback(() => {
  cachedOctokit = undefined;
  cachedGraphql = undefined;
});

function baseUrl(): string {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

/** Get the shared Octokit REST client. Throws if auth is not available. */
export function getOctokit(): Octokit {
  if (cachedOctokit) return cachedOctokit;
  const auth = gateAuth();
  if (!auth.ok) throw new Error("GitHub auth not available");
  cachedOctokit = new Octokit({ auth: auth.token, baseUrl: baseUrl() });
  return cachedOctokit;
}

/** Run a typed GraphQL query against the GitHub API. */
export async function graphqlQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!cachedGraphql) {
    const auth = gateAuth();
    if (!auth.ok) throw new Error("GitHub auth not available");
    const graphqlUrl = process.env.GITHUB_GRAPHQL_URL;
    cachedGraphql = octokitGraphql.defaults({
      headers: { authorization: `token ${auth.token}` },
      ...(graphqlUrl ? { baseUrl: graphqlUrl } : {}),
    });
  }
  return (await cachedGraphql(query, variables ?? {})) as T;
}

/**
 * Run up to `concurrency` async tasks in parallel from an iterable.
 * Identical pattern to mcp-multi-root-git's asyncPool.
 *
 * Implementation note: we maintain two separate promise handles per item:
 * - `userP` is the raw fn(item) promise held in `results`; it can reject and
 *   that rejection surfaces through Promise.all (abort-on-first-rejection).
 * - `tracker` is a bookkeeping promise that always resolves (never rejects),
 *   used only in `executing`. This prevents unhandled-rejection leaks and
 *   ensures the item is removed from the set even when fn rejects.
 */
export async function asyncPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const userP = fn(item);
    results.push(userP);

    // tracker always resolves so executing.delete is always called
    let tracker: Promise<void>;
    tracker = userP.then(
      () => {
        executing.delete(tracker);
      },
      () => {
        executing.delete(tracker);
      },
    );
    executing.add(tracker);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all tasks; Promise.all rejects on the first rejection in results
  return Promise.all(results);
}

// Clamp to >= 1 so a non-numeric env value (NaN) falls back to 4, not Infinity.
export const GITHUB_API_PARALLELISM = Math.max(
  1,
  Number.parseInt(process.env.GITHUB_API_PARALLELISM ?? "", 10) || 4,
);

/** Convenience: run API calls in parallel with default concurrency. */
export async function parallelApi<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  return asyncPool(items, GITHUB_API_PARALLELISM, fn);
}

/**
 * Classify an arbitrary error (Octokit REST, GraphQL response error, or other)
 * into a structured {@link McpErrorEnvelope}.
 *
 * HTTP status mapping:
 * - 401 → AUTH_FAILED
 * - 403 with `x-ratelimit-remaining: 0` → RATE_LIMITED (retryable)
 * - other 403 → PERMISSION_DENIED
 * - 404 → NOT_FOUND
 * - 422 → VALIDATION
 * - 5xx → UPSTREAM_FAILURE (retryable)
 *
 * GraphQL errors without an HTTP status map to UPSTREAM_FAILURE.
 * Unrecognized errors fall through to INTERNAL.
 */
/**
 * Scrub GitHub tokens from an error message so they are never echoed to callers.
 * Covers bearer/PAT prefixes (ghp_, gho_, ghu_, ghs_, ghr_) and `token <value>` forms.
 */
function scrubTokens(msg: string): string {
  return msg.replace(/gh[pousr]_[A-Za-z0-9]+/g, "***").replace(/token\s+\S+/gi, "token ***");
}

export function classifyError(err: unknown): McpErrorEnvelope {
  const e = err as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, string | undefined> };
    errors?: { message?: string }[];
  };
  const rawMessage = typeof e?.message === "string" && e.message.length > 0 ? e.message : "unknown";
  const message = scrubTokens(rawMessage);
  const status = typeof e?.status === "number" ? e.status : undefined;

  if (status === 401) {
    // A genuine 401 means the cached token is stale — invalidate all auth caches
    // so the next request re-resolves a potentially rotated token.
    invalidateAllAuthCaches();
    return mkError("AUTH_FAILED", message, {
      suggestedFix: "Verify GITHUB_TOKEN/GH_TOKEN is valid and has required scopes.",
    });
  }
  if (status === 403) {
    const remaining = e.response?.headers?.["x-ratelimit-remaining"];
    if (remaining === "0") {
      const reset = e.response?.headers?.["x-ratelimit-reset"];
      const suggestedFix = reset
        ? `Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`
        : "Wait for rate limit to reset.";
      return mkError("RATE_LIMITED", message, { retryable: true, suggestedFix });
    }
    return mkError("PERMISSION_DENIED", message, {
      suggestedFix: "Check token scopes or repo access.",
    });
  }
  if (status === 404) return mkError("NOT_FOUND", message);
  if (status === 422) return mkError("VALIDATION", message);
  if (status !== undefined && status >= 500 && status < 600) {
    return mkError("UPSTREAM_FAILURE", message, { retryable: true });
  }

  // GraphQL-level error (no HTTP status but has errors array)
  if (Array.isArray(e?.errors) && e.errors.length > 0) {
    const firstMessage = scrubTokens(e.errors[0]?.message ?? rawMessage);
    return mkError("UPSTREAM_FAILURE", firstMessage, { retryable: true });
  }

  return mkError("INTERNAL", message);
}

/** Parse a GitHub remote URL into owner/repo. Handles SSH and HTTPS forms. */
export function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | undefined {
  // SSH: git@github.com:owner/repo.git  (anchored so github.com.evil.com won't match)
  const ssh = /^(?:git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };

  // HTTPS: https://github.com/owner/repo.git  (anchored to exact host)
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };

  return undefined;
}

/**
 * Resolve a local git clone's GitHub remote to owner/repo.
 * Parses the `origin` remote URL.
 */
export function resolveLocalRepoRemote(
  localPath: string,
): { owner: string; repo: string } | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: localPath,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseGitHubRemoteUrl(url);
  } catch (err) {
    // Not a git repo or no origin
    console.error(
      `[resolveLocalRepoRemote] Failed to resolve remote for ${localPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PR metadata helpers (shared by release_readiness and changelog_draft)
// ---------------------------------------------------------------------------

/** Minimal PR node returned by batch PR metadata queries. */
export interface PRNode {
  number: number;
  title: string;
  labels: { nodes: { name: string }[] };
  /** Only populated when the query explicitly requests it (release_readiness). */
  state?: string;
}

/**
 * Batch-fetch PR metadata for a list of PR numbers via GraphQL.
 * GitHub's per-query alias limit is 20 so we chunk into pages of 20 and merge.
 * Best-effort: errors are logged and the map simply omits unresolvable PRs.
 */
export async function fetchPRMetadata(
  owner: string,
  repo: string,
  prNumbers: number[],
  opts: { includeState?: boolean } = {},
): Promise<Map<number, PRNode>> {
  const map = new Map<number, PRNode>();
  if (prNumbers.length === 0) return map;

  const stateField = opts.includeState ? " state" : "";
  const CHUNK = 20;

  // Chunk prNumbers into pages of CHUNK and fetch each page
  for (let i = 0; i < prNumbers.length; i += CHUNK) {
    const batch = prNumbers.slice(i, i + CHUNK);
    const fragments = batch.map(
      (n) =>
        `pr${n}: pullRequest(number: ${n}) { number title${stateField} labels(first:5) { nodes { name } } }`,
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
    } catch (err) {
      // PR resolution is best-effort; classify and log errors for debugging
      const classified = classifyError(err);
      console.error(
        `[fetchPRMetadata] Error fetching PR metadata for ${owner}/${repo} (PRs: ${batch.join(", ")}): ${classified.code} — ${classified.message}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return map;
}

/**
 * Parse a vX.Y.Z / X.Y.Z tag name into a numeric tuple for comparison.
 * Returns null if the tag does not match simple semver (pre-releases excluded).
 */
function parseSemverTag(name: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Return the highest semver tag (vX.Y.Z or X.Y.Z) in a repo.
 * `listTags` returns tags in push-order, not semver order, so we parse and
 * sort all matching tags to find the true maximum.
 * Returns `null` when no matching tag exists. Throws on API errors.
 */
export async function fetchLatestSemverTag(owner: string, repo: string): Promise<string | null> {
  const octokit = getOctokit();
  const res = await octokit.repos.listTags({ owner, repo, per_page: 20 });

  let best: { name: string; ver: [number, number, number] } | null = null;
  for (const t of res.data) {
    const ver = parseSemverTag(t.name);
    if (!ver) continue;
    if (
      !best ||
      ver[0] > best.ver[0] ||
      (ver[0] === best.ver[0] && ver[1] > best.ver[1]) ||
      (ver[0] === best.ver[0] && ver[1] === best.ver[1] && ver[2] > best.ver[2])
    ) {
      best = { name: t.name, ver };
    }
  }
  return best?.name ?? null;
}
