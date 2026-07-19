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
export const GITHUB_API_PARALLELISM: number = Math.max(
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
    /** Marker set by withTimeout so the error is retryable. */
    _isTimeout?: boolean;
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
  if (status === 403 || status === 429) {
    const remaining = e.response?.headers?.["x-ratelimit-remaining"];
    if (remaining === "0") {
      const reset = e.response?.headers?.["x-ratelimit-reset"];
      const suggestedFix = reset
        ? `Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`
        : "Wait for rate limit to reset.";
      return mkError("RATE_LIMITED", message, { retryable: true, suggestedFix });
    }
    const retryAfter = e.response?.headers?.["retry-after"];
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      const suggestedFix = Number.isNaN(seconds)
        ? `Secondary rate limit hit; retry after: ${retryAfter}.`
        : `Secondary rate limit hit; retry after ${seconds} second(s).`;
      return mkError("RATE_LIMITED", message, { retryable: true, suggestedFix });
    }
    if (status === 429) {
      return mkError("RATE_LIMITED", message, { retryable: true });
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

  // Timeout errors from withTimeout are retryable upstream failures
  if (e?._isTimeout === true) {
    return mkError("UPSTREAM_FAILURE", message, { retryable: true });
  }

  // GraphQL-level error (no HTTP status but has errors array)
  if (Array.isArray(e?.errors) && e.errors.length > 0) {
    const firstMessage = scrubTokens(e.errors[0]?.message ?? rawMessage);
    return mkError("UPSTREAM_FAILURE", firstMessage, { retryable: true });
  }

  return mkError("INTERNAL", message);
}

// ---------------------------------------------------------------------------
// withRetry — exponential backoff with retryable-error detection
// ---------------------------------------------------------------------------

/**
 * Default maximum number of retry attempts.
 * Overridden by `GITHUB_API_MAX_RETRIES` env var (integer ≥0).
 */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Default base delay in milliseconds for exponential backoff.
 * Overridden by `GITHUB_API_RETRY_BASE_MS` env var.
 */
const DEFAULT_RETRY_BASE_MS = 500;

/** Maximum delay (ms) honored from `retry-after` / `x-ratelimit-reset` headers. */
const MAX_HEADER_DELAY_MS = 60_000;

function resolveMaxRetries(): number {
  const parsed = Number.parseInt(process.env.GITHUB_API_MAX_RETRIES ?? "", 10);
  return Number.isNaN(parsed) ? DEFAULT_MAX_RETRIES : Math.max(0, parsed);
}

function resolveBaseDelayMs(): number {
  const parsed = Number.parseInt(process.env.GITHUB_API_RETRY_BASE_MS ?? "", 10);
  return Number.isNaN(parsed) ? DEFAULT_RETRY_BASE_MS : Math.max(0, parsed);
}

/**
 * Extract the header-advised delay (ms) from an error's response headers.
 * Honors `retry-after` (seconds) or `x-ratelimit-reset` (Unix epoch), capped
 * at {@link MAX_HEADER_DELAY_MS}.
 */
function headerDelay(err: unknown): number | undefined {
  const e = err as { response?: { headers?: Record<string, string | undefined> } };
  const headers = e?.response?.headers;
  if (!headers) return undefined;

  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs) && secs > 0) {
      return Math.min(secs * 1000, MAX_HEADER_DELAY_MS);
    }
  }

  const resetEpoch = headers["x-ratelimit-reset"];
  if (resetEpoch !== undefined) {
    const delayMs = Number(resetEpoch) * 1000 - Date.now();
    if (!Number.isNaN(delayMs) && delayMs > 0) {
      return Math.min(delayMs, MAX_HEADER_DELAY_MS);
    }
  }

  return undefined;
}

/**
 * Retry `fn` with exponential backoff on retryable errors.
 *
 * - Non-retryable errors (per {@link classifyError}) rethrow immediately.
 * - After `maxRetries` exhausted, rethrows the last error.
 * - If the error carries a `retry-after` or `x-ratelimit-reset` header, that
 *   delay is used instead of the exponential formula (capped at 60 s).
 * - `sleep` is injectable for tests (defaults to a real timer).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxRetries =
    opts?.maxRetries !== undefined ? Math.max(0, opts.maxRetries) : resolveMaxRetries();
  const baseDelayMs =
    opts?.baseDelayMs !== undefined ? Math.max(0, opts.baseDelayMs) : resolveBaseDelayMs();
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyError(err);
      if (!classified.retryable) throw err;
      if (attempt < maxRetries) {
        const delay = headerDelay(err) ?? baseDelayMs * 2 ** attempt;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// withTimeout — race a promise against a deadline
// ---------------------------------------------------------------------------

/**
 * Default request timeout in milliseconds.
 * Overridden by `GITHUB_API_TIMEOUT_MS` env var.
 */
export const GITHUB_API_TIMEOUT_MS: number = (() => {
  const parsed = Number.parseInt(process.env.GITHUB_API_TIMEOUT_MS ?? "", 10);
  return Number.isNaN(parsed) ? 30_000 : Math.max(0, parsed);
})();

/**
 * Race `promise` against a wall-clock deadline.
 *
 * If the promise does not settle within `ms`, rejects with an Error whose
 * message includes `label` (if provided) and the timeout duration.  The
 * rejection is tagged with `_isTimeout: true` so {@link classifyError} treats
 * it as a retryable `UPSTREAM_FAILURE`.
 *
 * The internal timer is cleared and unref'd so it never keeps the process alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const msg = label ? `${label} timed out after ${ms}ms` : `Request timed out after ${ms}ms`;
      const err = Object.assign(new Error(msg), { _isTimeout: true });
      reject(err);
    }, ms);

    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// asyncPoolSettled / parallelApiSettled — partial-results pool (never aborts)
// ---------------------------------------------------------------------------

/**
 * Like {@link asyncPool} but uses `Promise.allSettled` instead of `Promise.all`.
 * A single failing item never aborts the remaining work; all results are
 * returned as {@link PromiseSettledResult} values.
 *
 * Identical concurrency-limiting logic to {@link asyncPool} — do NOT modify that function.
 */
export async function asyncPoolSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const userP = fn(item);
    results.push(userP);

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

  return Promise.allSettled(results);
}

/** Convenience: run API calls with partial-results semantics at default concurrency. */
export async function parallelApiSettled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return asyncPoolSettled(items, GITHUB_API_PARALLELISM, fn);
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
