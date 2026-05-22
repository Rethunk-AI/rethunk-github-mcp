/**
 * Shared helper: fetch commits between two refs in a GitHub repo.
 *
 * Used by `release_readiness` (via the Octokit REST compare endpoint) and
 * `pin_drift` / `ecosystem_activity` (via GraphQL history).  The two callers
 * have different needs, so this module exports the lowest-common-denominator
 * primitives rather than a single opinionated function.
 */

import { graphqlQuery } from "./github-client.js";
import { sha7 } from "./utils.js";

export interface CommitEntry {
  sha7: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitHistoryNode {
  oid: string;
  messageHeadline: string;
  committedDate: string;
  author: { name: string | null; user: { login: string } | null };
}

interface HistoryQueryResult {
  repository: {
    defaultBranchRef: { name: string } | null;
    object: {
      history: { nodes: CommitHistoryNode[] };
    } | null;
  };
}

interface CommitObjectResult {
  repository: {
    object: {
      oid: string;
      committedDate: string;
    } | null;
  };
}

export function mapCommitHistoryNodes(nodes: CommitHistoryNode[]): CommitEntry[] {
  return nodes.map((n) => ({
    sha7: sha7(n.oid),
    message: n.messageHeadline,
    author: n.author.user?.login ?? n.author.name ?? "unknown",
    date: n.committedDate,
  }));
}

export function filterCommitsAfterPin(commits: CommitEntry[], pinnedSha: string): CommitEntry[] {
  return commits.filter((c) => {
    // Normalize both sides to the shorter of the two lengths before comparing
    // so that a 12-char pin doesn't fail to match a 7-char sha7 field, and
    // a full 40-char pin is correctly compared against a 7-char sha7 field.
    const prefixLen = Math.min(pinnedSha.length, c.sha7.length);
    return pinnedSha.substring(0, prefixLen) !== c.sha7.substring(0, prefixLen);
  });
}

/**
 * Resolve a ref (branch, tag, or SHA prefix) to a full 40-char SHA + committer date.
 * Returns null when the ref does not exist in the given repo.
 */
export async function resolveRef(
  owner: string,
  repo: string,
  ref: string,
): Promise<{ oid: string; committedDate: string } | null> {
  const query = `query($owner:String!,$repo:String!,$expr:String!){
    repository(owner:$owner,name:$repo){
      object(expression:$expr){
        ...on Commit{ oid committedDate }
      }
    }
  }`;
  try {
    const data = await graphqlQuery<CommitObjectResult>(query, { owner, repo, expr: ref });
    const obj = data.repository.object;
    if (!obj) return null;
    return { oid: obj.oid, committedDate: obj.committedDate };
  } catch (err) {
    console.error(
      `[resolveRef] Failed to resolve ref '${ref}' in ${owner}/${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Fetch up to `limit` commits reachable from `headRef` since `since` (ISO8601),
 * optionally filtering to a single file path.
 *
 * Returns commits sorted newest-first (GraphQL default).
 *
 * All dynamic values (`since`, `path`, `limit`) are passed as typed GraphQL
 * variables to prevent injection; they are never interpolated into the query string.
 */
export async function fetchCommitHistory(
  owner: string,
  repo: string,
  headRef: string,
  opts: {
    since?: string;
    path?: string;
    limit?: number;
  } = {},
): Promise<{ commits: CommitEntry[]; defaultBranch: string }> {
  const limit = opts.limit ?? 50;

  // Use typed GraphQL variables for all user-supplied values.
  // $since is typed as GitTimestamp (ISO8601 string) and is optional (null = omit).
  // $path is typed as String and is optional (null = omit).
  // $limit is typed as Int.
  const query = `query(
    $owner:String!,$repo:String!,$expr:String!,
    $limit:Int!,$since:GitTimestamp,$path:String
  ){
    repository(owner:$owner,name:$repo){
      defaultBranchRef { name }
      object(expression:$expr){
        ...on Commit{
          history(first:$limit,since:$since,path:$path){
            nodes{
              oid messageHeadline committedDate
              author{ name user{ login } }
            }
          }
        }
      }
    }
  }`;

  const data = await graphqlQuery<HistoryQueryResult>(query, {
    owner,
    repo,
    expr: headRef,
    limit,
    since: opts.since ?? null,
    path: opts.path ?? null,
  });
  const defaultBranch = data.repository.defaultBranchRef?.name ?? "main";
  const nodes = data.repository.object?.history.nodes ?? [];

  const commits = mapCommitHistoryNodes(nodes);

  return { commits, defaultBranch };
}

/**
 * Count how many commits are in `headRef` that are NOT reachable from `pinnedSha`.
 *
 * Strategy: fetch up to `limit` history entries from headRef; count those whose
 * committedDate is strictly after the pinned commit's committedDate.  This is an
 * approximation (merge-commit topologies are ignored) but is reliable for linear
 * or near-linear histories which is the common case for upstream pins.
 *
 * `history(since:)` is inclusive, so commits that share the pinned commit's
 * timestamp may be returned alongside the pinned commit itself. We deduplicate
 * by full SHA before returning to prevent off-by-one counts.
 *
 * Returns `{ behindBy, commits }` where `commits` is capped at `limit`.
 */
export async function countBehind(
  owner: string,
  repo: string,
  headRef: string,
  pinnedSha: string,
  limit = 100,
): Promise<{ behindBy: number; commits: CommitEntry[] }> {
  // Resolve the pinned SHA date so we can filter
  const pinned = await resolveRef(owner, repo, pinnedSha);
  if (!pinned) {
    // Unknown pin — return behindBy = -1 to signal error
    return { behindBy: -1, commits: [] };
  }

  const { commits } = await fetchCommitHistory(owner, repo, headRef, {
    since: pinned.committedDate,
    limit,
  });

  // Exclude the pinned commit by full SHA match (history(since:) is inclusive,
  // so the pinned commit itself appears in results).
  // Also deduplicate by sha7 in case sibling commits share the same timestamp.
  const seen = new Set<string>();
  const newer = commits.filter((c) => {
    // Exclude if this commit IS the pinned commit (full-SHA prefix match)
    const prefixLen = Math.min(pinned.oid.length, c.sha7.length);
    if (pinned.oid.substring(0, prefixLen) === c.sha7.substring(0, prefixLen)) return false;
    // Deduplicate by sha7
    if (seen.has(c.sha7)) return false;
    seen.add(c.sha7);
    return true;
  });

  return { behindBy: newer.length, commits: newer };
}
