/**
 * Shared utilities used across multiple MCP tool files.
 */

/** Format a past ISO8601 date as a human-readable relative string. */
export function timeAgo(dateStr: string): string {
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return `${Math.floor(sec / 604800)}w ago`;
}

/**
 * Parse a relative duration string ("48h", "7d") or an ISO8601 date/datetime
 * into an ISO8601 timestamp suitable for GitHub API `since` parameters.
 * Passthrough for anything that doesn't match: GitHub will reject it.
 */
export function parseSince(since: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(since) || /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return since;
  }
  const hoursMatch = /^(\d+(?:\.\d+)?)h$/i.exec(since);
  if (hoursMatch?.[1]) {
    const ms = Number.parseFloat(hoursMatch[1]) * 3_600_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const daysMatch = /^(\d+(?:\.\d+)?)d$/i.exec(since);
  if (daysMatch?.[1]) {
    const ms = Number.parseFloat(daysMatch[1]) * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  return since;
}

/**
 * Extract PR numbers from commit message `(#NNN)` patterns.
 * Returns all matches in order of appearance.
 */
export function extractPRNumbers(message: string): number[] {
  const result: number[] = [];
  for (const m of message.matchAll(/\(#(\d+)\)/g)) {
    const raw = m[1];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n)) result.push(n);
  }
  return result;
}

/** Extract the first PR number from a commit message `(#NNN)` pattern. */
export function extractFirstPR(message: string): number | undefined {
  const m = /\(#(\d+)\)/.exec(message);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Tail-truncate: keep the LAST `maxLines` of `text`.
 * Used when fetching CI logs where failures appear at the bottom.
 */
export function tailTruncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `... [${lines.length - maxLines} lines above truncated]\n${lines.slice(-maxLines).join("\n")}`;
}

/**
 * Minimal shape for a GitHub status-check rollup context node.
 * Covers both `CheckRun` (name + conclusion) and `StatusContext` (context + state).
 */
export interface CheckNode {
  name?: string;
  conclusion?: string;
  context?: string;
  state?: string;
}

/**
 * Normalize a list of check-rollup context nodes into a flat array of
 * `{ name, conclusion }` pairs for any check that isn't passing/skipped.
 *
 * Used by `repo_status` and `release_readiness` to surface failed CI checks.
 */
export function normalizeFailedChecks(nodes: CheckNode[]): { name: string; conclusion: string }[] {
  return nodes
    .filter((n) => {
      if (n.conclusion) return !["SUCCESS", "SKIPPED"].includes(n.conclusion);
      if (n.state) return n.state !== "SUCCESS";
      return false;
    })
    .map((n) => ({
      name: n.name ?? n.context ?? "unknown",
      conclusion: n.conclusion ?? n.state ?? "unknown",
    }));
}
