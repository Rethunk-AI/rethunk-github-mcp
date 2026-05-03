import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_JSON_FORMAT_VERSION = "2" as const;

let _cachedVersion: string | undefined;

/** Clears the package version cache (used by tests). */
export function resetReadPackageVersionCache(): void {
  _cachedVersion = undefined;
}

export function readPackageVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "..", "package.json");
  try {
    const j = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    _cachedVersion = j.version ?? "0.0.0";
  } catch (err) {
    console.error(
      `[readPackageVersion] Failed to read ${pkgPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    _cachedVersion = "0.0.0";
  }
  return _cachedVersion;
}

/** FastMCP types require major.minor.patch; strip prerelease suffixes from package.json. */
export function readMcpServerVersion(): `${number}.${number}.${number}` {
  const raw = readPackageVersion().trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
    return `${m[1]}.${m[2]}.${m[3]}` as `${number}.${number}.${number}`;
  }
  return "0.0.0";
}

export function jsonRespond(body: object): string {
  return JSON.stringify(body);
}

/**
 * Structured error code set used across all MCP tools.
 *
 * - `AUTH_MISSING`/`AUTH_FAILED`: credential resolution problems.
 * - `NOT_FOUND`/`PERMISSION_DENIED`/`RATE_LIMITED`/`VALIDATION`: direct HTTP-status maps.
 * - `UPSTREAM_FAILURE`: 5xx, GraphQL errors, or generic GitHub-side failures.
 * - Domain codes (`NO_CI_RUNS`, `COMPARE_FAILED`, `LOCAL_REPO_NO_REMOTE`,
 *   `UNSUPPORTED_LANGUAGE`, `AMBIGUOUS_REPO`): per-tool signals that are not HTTP errors.
 * - `INTERNAL`: catch-all for unexpected failures.
 */
export type McpErrorCode =
  | "AUTH_MISSING"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "UPSTREAM_FAILURE"
  | "NO_CI_RUNS"
  | "COMPARE_FAILED"
  | "LOCAL_REPO_NO_REMOTE"
  | "UNSUPPORTED_LANGUAGE"
  | "AMBIGUOUS_REPO"
  | "INTERNAL";

/** Structured error envelope. Returned in the `error` field of JSON responses. */
export interface McpErrorEnvelope {
  code: McpErrorCode;
  message: string;
  retryable: boolean;
  suggestedFix?: string;
}

/** Construct an error envelope. `retryable` defaults to `false`. */
export function mkError(
  code: McpErrorCode,
  message: string,
  opts?: { retryable?: boolean; suggestedFix?: string },
): McpErrorEnvelope {
  return {
    code,
    message,
    retryable: opts?.retryable ?? false,
    ...spreadDefined("suggestedFix", opts?.suggestedFix),
  };
}

/** Respond with a tool-level error envelope: `{"error": {...}}`. */
export function errorRespond(envelope: McpErrorEnvelope): string {
  return jsonRespond({ error: envelope });
}

/** Standard error for a local path whose git `origin` doesn't resolve to GitHub. */
export function mkLocalRepoNoRemote(path: string): McpErrorEnvelope {
  return mkError("LOCAL_REPO_NO_REMOTE", `No GitHub origin found for local path ${path}`, {
    suggestedFix: "Ensure the path is a git clone with a GitHub `origin` remote.",
  });
}

/** Spread into an object literal only when `cond` is true; otherwise `{}`. */
function spreadWhen<T extends Record<string, unknown>>(
  cond: boolean,
  fields: T,
): T | Record<string, never> {
  return cond ? fields : {};
}

/** Spread `{ [key]: value }` only when `value` is not `undefined`. */
export function spreadDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return spreadWhen(value !== undefined, { [key]: value } as Record<K, V>);
}

/** Truncate text to a maximum number of lines, appending a truncation notice. */
export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... [${lines.length - maxLines} lines truncated]`;
}

/** Truncate text to a maximum number of characters, appending a truncation notice. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated]`;
}
