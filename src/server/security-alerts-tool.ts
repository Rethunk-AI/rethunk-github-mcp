import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { FormatSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeverityRollup {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface DependabotAlertEntry {
  number: number;
  ghsaId: string;
  severity: string;
  state: string;
  package: string;
  summary: string;
}

interface CodeScanningAlertEntry {
  number: number;
  ruleId: string;
  severity: string | null;
  state: string;
}

interface DependabotSource {
  enabled: true;
  total: number;
  truncatedCount: number;
  alerts: DependabotAlertEntry[];
}

interface DependabotSourceDisabled {
  enabled: false;
  reason: string;
}

interface CodeScanningSource {
  enabled: true;
  total: number;
  truncatedCount: number;
  alerts: CodeScanningAlertEntry[];
}

interface CodeScanningSourceDisabled {
  enabled: false;
  reason: string;
}

interface SecurityAlertsOutput {
  rollup: SeverityRollup;
  dependabot: DependabotSource | DependabotSourceDisabled;
  codeScanning: CodeScanningSource | CodeScanningSourceDisabled;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDisabledError(err: unknown): boolean {
  const e = err as { status?: number };
  return e?.status === 403 || e?.status === 404;
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string; status?: number };
  if (typeof e?.message === "string" && e.message.length > 0) return e.message;
  if (typeof e?.status === "number") return `HTTP ${e.status}`;
  return String(err);
}

function addToRollup(rollup: SeverityRollup, severity: string | null | undefined): void {
  if (severity === "critical") rollup.critical++;
  else if (severity === "high") rollup.high++;
  else if (severity === "medium") rollup.medium++;
  else if (severity === "low") rollup.low++;
}

/**
 * Render the security alerts markdown summary. Per-alert links are
 * reconstructed from owner/repo/number here (not stored on the JSON-facing
 * alert entries) since GitHub's alert URLs are a deterministic pattern.
 */
function formatMarkdown(owner: string, repo: string, output: SecurityAlertsOutput): string {
  const { rollup, dependabot, codeScanning } = output;
  const lines: string[] = ["## Security Alerts Summary", ""];

  // Severity table
  lines.push("| Severity | Count |");
  lines.push("|----------|-------|");
  lines.push(`| Critical | ${rollup.critical} |`);
  lines.push(`| High     | ${rollup.high} |`);
  lines.push(`| Medium   | ${rollup.medium} |`);
  lines.push(`| Low      | ${rollup.low} |`);
  lines.push("");

  // Dependabot section
  if (!dependabot.enabled) {
    lines.push(`**Dependabot:** disabled (${dependabot.reason})`);
  } else {
    lines.push(`**Dependabot** (${dependabot.total} alert${dependabot.total !== 1 ? "s" : ""}):`);
    for (const a of dependabot.alerts) {
      const url = `https://github.com/${owner}/${repo}/security/dependabot/${a.number}`;
      lines.push(`- [#${a.number}](${url}) \`${a.package}\` — ${a.severity}: ${a.summary}`);
    }
    if (dependabot.truncatedCount > 0) {
      lines.push(`- … and ${dependabot.truncatedCount} more`);
    }
  }
  lines.push("");

  // Code scanning section
  if (!codeScanning.enabled) {
    lines.push(`**Code Scanning:** disabled (${codeScanning.reason})`);
  } else {
    lines.push(
      `**Code Scanning** (${codeScanning.total} alert${codeScanning.total !== 1 ? "s" : ""}):`,
    );
    for (const a of codeScanning.alerts) {
      const url = `https://github.com/${owner}/${repo}/security/code-scanning/${a.number}`;
      lines.push(`- [#${a.number}](${url}) \`${a.ruleId}\` — ${a.severity ?? "unknown severity"}`);
    }
    if (codeScanning.truncatedCount > 0) {
      lines.push(`- … and ${codeScanning.truncatedCount} more`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSecurityAlertsTool(server: FastMCP): void {
  server.addTool({
    name: "security_alerts",
    description:
      "Roll up a repository's open security posture for an LLM agent — Dependabot alerts and Code Scanning alerts grouped by severity, compact output.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
      state: z
        .enum(["open", "dismissed", "fixed", "auto_dismissed"])
        .optional()
        .default("open")
        .describe("Alert state to filter by."),
      severity: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Filter alerts to a specific severity. Omit to return all severities."),
      includeCodeScanning: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include Code Scanning alerts in the output."),
      includeDependabot: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include Dependabot alerts in the output."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(30)
        .describe("Maximum number of alerts to return per source."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      // gateAuth before try so auth errors are not swallowed by the catch
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      try {
        const octokit = getOctokit();
        const { owner, repo, state, severity, includeDependabot, includeCodeScanning, limit } =
          args;

        // Run both fetches concurrently; either being disabled (403/404) must NOT abort the other.
        const [dependabotResult, codeScanningResult] = await Promise.allSettled([
          includeDependabot
            ? (async () => {
                const all = await octokit.paginate(octokit.rest.dependabot.listAlertsForRepo, {
                  owner,
                  repo,
                  state: state as "open" | "dismissed" | "fixed" | "auto_dismissed",
                  per_page: 100,
                });
                return all;
              })()
            : Promise.resolve(null),
          includeCodeScanning && state !== "auto_dismissed"
            ? (async () => {
                const res = await octokit.rest.codeScanning.listAlertsForRepo({
                  owner,
                  repo,
                  state: state as "open" | "dismissed" | "fixed",
                  per_page: limit,
                });
                return res.data;
              })()
            : Promise.resolve(null),
        ]);

        const rollup: SeverityRollup = { critical: 0, high: 0, medium: 0, low: 0 };

        // ---------------------------------------------------------------
        // Dependabot
        // ---------------------------------------------------------------
        let dependabotOut: DependabotSource | DependabotSourceDisabled;

        if (!includeDependabot) {
          dependabotOut = { enabled: false, reason: "not requested" };
        } else if (dependabotResult.status === "rejected") {
          const err = dependabotResult.reason as unknown;
          if (isDisabledError(err)) {
            dependabotOut = { enabled: false, reason: errorMessage(err) };
          } else {
            // Genuine failure (auth, 5xx, network) — re-throw so the outer catch handles it
            throw dependabotResult.reason;
          }
        } else {
          const rawAlerts = dependabotResult.value ?? [];

          // Apply severity filter
          const filtered = severity
            ? rawAlerts.filter((a) => a.security_advisory.severity === severity)
            : rawAlerts;

          // Apply limit
          const capped = filtered.slice(0, limit);
          const truncatedCount = filtered.length - capped.length;

          const alerts: DependabotAlertEntry[] = capped.map((a) => ({
            number: a.number,
            ghsaId: a.security_advisory.ghsa_id,
            severity: a.security_advisory.severity,
            state: a.state,
            package: a.dependency.package?.name ?? "unknown",
            summary: a.security_advisory.summary,
          }));

          for (const a of alerts) {
            addToRollup(rollup, a.severity);
          }

          dependabotOut = {
            enabled: true,
            total: filtered.length,
            truncatedCount,
            alerts,
          };
        }

        // ---------------------------------------------------------------
        // Code Scanning
        // ---------------------------------------------------------------
        let codeScanningOut: CodeScanningSource | CodeScanningSourceDisabled;

        if (!includeCodeScanning) {
          codeScanningOut = { enabled: false, reason: "not requested" };
        } else if (state === "auto_dismissed") {
          codeScanningOut = {
            enabled: false,
            reason: "state auto_dismissed not supported by code scanning",
          };
        } else if (codeScanningResult.status === "rejected") {
          const err = codeScanningResult.reason as unknown;
          if (isDisabledError(err)) {
            codeScanningOut = { enabled: false, reason: errorMessage(err) };
          } else {
            throw codeScanningResult.reason;
          }
        } else {
          const rawAlerts = codeScanningResult.value ?? [];

          // Apply severity filter — use rule.security_severity_level for security buckets
          const filtered = severity
            ? rawAlerts.filter((a) => a.rule.security_severity_level === severity)
            : rawAlerts;

          // Code scanning was already capped by per_page:limit, but re-cap for consistency
          const capped = filtered.slice(0, limit);
          const truncatedCount = filtered.length - capped.length;

          const alerts: CodeScanningAlertEntry[] = capped.map((a) => ({
            number: a.number,
            ruleId: a.rule.id ?? "unknown",
            severity: a.rule.security_severity_level ?? null,
            state: a.state ?? "unknown",
          }));

          for (const a of alerts) {
            addToRollup(rollup, a.severity);
          }

          codeScanningOut = {
            enabled: true,
            total: filtered.length,
            truncatedCount,
            alerts,
          };
        }

        const output: SecurityAlertsOutput = {
          rollup,
          dependabot: dependabotOut,
          codeScanning: codeScanningOut,
        };

        if (args.format === "markdown") {
          return formatMarkdown(owner, repo, output);
        }
        return jsonRespond(output);
      } catch (err) {
        console.error(
          `[security_alerts] Failed to fetch security alerts for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
