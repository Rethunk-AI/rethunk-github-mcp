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
