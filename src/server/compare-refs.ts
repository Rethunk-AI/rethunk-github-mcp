/**
 * Shared helper: fetch commits between two refs in a GitHub repo.
 *
 * Used by `release_readiness` (via the Octokit REST compare endpoint) and
 * `pin_drift` / `ecosystem_activity` (via GraphQL history).  The two callers
 * have different needs, so this module exports the lowest-common-denominator
 * primitives rather than a single opinionated function.
 */

import { graphqlQuery } from "./github-client.js";

export interface CommitEntry {
  sha7: string;
  message: string;
  author: string;
  date: string;
}

interface CommitHistoryNode {
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
  } catch {
    return null;
  }
}

/**
 * Fetch up to `limit` commits reachable from `headRef` since `since` (ISO8601),
 * optionally filtering to a single file path.
 *
 * Returns commits sorted newest-first (GraphQL default).
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
  const sinceClause = opts.since ? `, since: "${opts.since}"` : "";
  const pathClause = opts.path ? `, path: "${opts.path}"` : "";

  const query = `query($owner:String!,$repo:String!,$expr:String!){
    repository(owner:$owner,name:$repo){
      defaultBranchRef { name }
      object(expression:$expr){
        ...on Commit{
          history(first:${limit}${sinceClause}${pathClause}){
            nodes{
              oid messageHeadline committedDate
              author{ name user{ login } }
            }
          }
        }
      }
    }
  }`;

  const data = await graphqlQuery<HistoryQueryResult>(query, { owner, repo, expr: headRef });
  const defaultBranch = data.repository.defaultBranchRef?.name ?? "main";
  const nodes = data.repository.object?.history.nodes ?? [];

  const commits: CommitEntry[] = nodes.map((n) => ({
    sha7: n.oid.substring(0, 7),
    message: n.messageHeadline,
    author: n.author.user?.login ?? n.author.name ?? "unknown",
    date: n.committedDate,
  }));

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

  // Exclude the pinned commit itself (same oid or older)
  const newer = commits.filter((c) => {
    // sha7 prefix match for the pinned commit
    return !pinnedSha.startsWith(c.sha7) && pinnedSha.substring(0, 7) !== c.sha7;
  });

  return { behindBy: newer.length, commits: newer };
}
