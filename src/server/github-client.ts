import { execFileSync } from "node:child_process";
import { graphql as octokitGraphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

import { gateAuth } from "./github-auth.js";

let cachedOctokit: Octokit | undefined;
let cachedGraphql: typeof octokitGraphql | undefined;

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
 */
export async function asyncPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).then((r) => {
      results.push(r);
    });
    const wrapped = p.then(() => {
      executing.delete(wrapped);
    });
    executing.add(wrapped);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

const GITHUB_API_PARALLELISM = 4;

/** Convenience: run API calls in parallel with default concurrency. */
export async function parallelApi<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  return asyncPool(items, GITHUB_API_PARALLELISM, fn);
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

    // SSH: git@github.com:owner/repo.git
    const ssh = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
    if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };

    // HTTPS: https://github.com/owner/repo.git
    const https = /github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
    if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };
  } catch {
    // Not a git repo or no origin
  }
  return undefined;
}
