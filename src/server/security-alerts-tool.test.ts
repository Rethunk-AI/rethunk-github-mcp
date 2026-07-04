import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as githubAuth from "./github-auth.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { mkError } from "./json.js";
import { registerSecurityAlertsTool } from "./security-alerts-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeDependabotAlert(
  n: number,
  severity: "critical" | "high" | "medium" | "low",
  pkg = "lodash",
) {
  return {
    number: n,
    state: "open",
    dependency: { package: { name: pkg, ecosystem: "npm" } },
    security_advisory: {
      ghsa_id: `GHSA-xxxx-${n}`,
      severity,
      summary: `Vuln in ${pkg}`,
    },
    html_url: `https://github.com/o/r/security/dependabot/${n}`,
  };
}

function makeCodeScanningAlert(
  n: number,
  securitySeverity: "critical" | "high" | "medium" | "low" | null,
  ruleId = `js/sql-injection`,
) {
  return {
    number: n,
    state: "open",
    html_url: `https://github.com/o/r/security/code-scanning/${n}`,
    rule: {
      id: ruleId,
      severity: "error",
      security_severity_level: securitySeverity,
    },
  };
}

function makeOctokitMock(opts: {
  dependabotAlerts?: ReturnType<typeof makeDependabotAlert>[];
  dependabotReject?: { status: number; message: string };
  codeScanningAlerts?: ReturnType<typeof makeCodeScanningAlert>[];
  codeScanningReject?: { status: number; message: string };
}) {
  return {
    rest: {
      dependabot: {
        listAlertsForRepo: async () => ({ data: opts.dependabotAlerts ?? [] }),
      },
      codeScanning: {
        listAlertsForRepo: opts.codeScanningReject
          ? async () => {
              throw opts.codeScanningReject;
            }
          : async () => ({ data: opts.codeScanningAlerts ?? [] }),
      },
    },
    paginate: opts.dependabotReject
      ? async (_method: unknown, _params: unknown) => {
          throw opts.dependabotReject;
        }
      : async (_method: unknown, _params: unknown) => opts.dependabotAlerts ?? [],
  } as unknown as ReturnType<typeof githubClient.getOctokit>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("security_alerts tool", () => {
  const run = captureTool(registerSecurityAlertsTool);
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    resetAuthCache();
  });

  afterEach(() => {
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
    resetAuthCache();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path: both sources return alerts → correct severity rollup
  // -------------------------------------------------------------------------
  test("happy path: both sources return alerts, rollup and compact shape are correct", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        dependabotAlerts: [
          makeDependabotAlert(1, "critical"),
          makeDependabotAlert(2, "high"),
          makeDependabotAlert(3, "medium"),
        ],
        codeScanningAlerts: [
          makeCodeScanningAlert(10, "high"),
          makeCodeScanningAlert(11, "low"),
          // A non-security rule (null security_severity_level) — should not appear in rollup
          makeCodeScanningAlert(12, null, "js/style"),
        ],
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        includeDependabot: true,
        includeCodeScanning: true,
        state: "open",
        limit: 30,
      }),
    ) as {
      rollup: { critical: number; high: number; medium: number; low: number };
      dependabot: {
        enabled: boolean;
        total: number;
        truncatedCount: number;
        alerts: {
          number: number;
          ghsaId: string;
          severity: string;
          package: string;
          summary: string;
        }[];
      };
      codeScanning: {
        enabled: boolean;
        total: number;
        truncatedCount: number;
        alerts: {
          number: number;
          ruleId: string;
          severity: string | null;
          state: string;
        }[];
      };
    };

    spy.mockRestore();

    // Rollup: 1 critical (dep), 2 high (dep+cs), 1 medium (dep), 1 low (cs)
    expect(parsed.rollup.critical).toBe(1);
    expect(parsed.rollup.high).toBe(2);
    expect(parsed.rollup.medium).toBe(1);
    expect(parsed.rollup.low).toBe(1);

    // Dependabot shape
    expect(parsed.dependabot.enabled).toBe(true);
    expect(parsed.dependabot.total).toBe(3);
    expect(parsed.dependabot.truncatedCount).toBe(0);
    expect(parsed.dependabot.alerts).toHaveLength(3);
    const dep1 = parsed.dependabot.alerts[0];
    expect(dep1?.number).toBe(1);
    expect(dep1?.ghsaId).toBe("GHSA-xxxx-1");
    expect(dep1?.severity).toBe("critical");
    expect(dep1?.package).toBe("lodash");
    expect(dep1?.summary).toBe("Vuln in lodash");
    expect((dep1 as { htmlUrl?: string }).htmlUrl).toBeUndefined();

    // Code Scanning shape
    expect(parsed.codeScanning.enabled).toBe(true);
    expect(parsed.codeScanning.total).toBe(3);
    expect(parsed.codeScanning.alerts).toHaveLength(3);
    const cs1 = parsed.codeScanning.alerts[0];
    expect(cs1?.number).toBe(10);
    expect(cs1?.ruleId).toBe("js/sql-injection");
    expect(cs1?.severity).toBe("high");
    expect((cs1 as { htmlUrl?: string }).htmlUrl).toBeUndefined();
    // null-security rule preserved as null in output
    const cs3 = parsed.codeScanning.alerts[2];
    expect(cs3?.severity).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (f) Markdown format reconstructs per-alert URLs from owner/repo (no
  //     stored htmlUrl field on the JSON-facing entries).
  // -------------------------------------------------------------------------
  test("markdown format reconstructs dependabot/code-scanning URLs from owner/repo", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        dependabotAlerts: [makeDependabotAlert(7, "high")],
        codeScanningAlerts: [makeCodeScanningAlert(9, "critical")],
      }),
    );

    const text = await run({
      owner: "o",
      repo: "r",
      includeDependabot: true,
      includeCodeScanning: true,
      state: "open",
      limit: 30,
      format: "markdown",
    });

    spy.mockRestore();

    expect(text).toContain("https://github.com/o/r/security/dependabot/7");
    expect(text).toContain("https://github.com/o/r/security/code-scanning/9");
  });

  // -------------------------------------------------------------------------
  // (b) Code scanning DISABLED (404) → codeScanning.enabled=false, dependabot still returned
  // -------------------------------------------------------------------------
  test("code scanning disabled (404) leaves dependabot unaffected", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        dependabotAlerts: [makeDependabotAlert(1, "high")],
        codeScanningReject: { status: 404, message: "Code scanning not enabled" },
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        includeDependabot: true,
        includeCodeScanning: true,
        state: "open",
        limit: 30,
      }),
    ) as {
      rollup: { critical: number; high: number; medium: number; low: number };
      dependabot: { enabled: boolean; total: number; alerts: unknown[] };
      codeScanning: { enabled: boolean; reason: string };
    };

    spy.mockRestore();

    // Dependabot still works
    expect(parsed.dependabot.enabled).toBe(true);
    expect(parsed.dependabot.total).toBe(1);
    expect(parsed.dependabot.alerts).toHaveLength(1);

    // Code scanning reported as disabled
    expect(parsed.codeScanning.enabled).toBe(false);
    expect(parsed.codeScanning.reason).toContain("not enabled");

    // Rollup only reflects dependabot alerts
    expect(parsed.rollup.high).toBe(1);
    expect(parsed.rollup.critical).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (c) Auth missing → error envelope
  // -------------------------------------------------------------------------
  test("missing auth returns error envelope", async () => {
    // Mock gateAuth directly so the test is hermetic regardless of environment gh-cli state.
    const authSpy = spyOn(githubAuth, "gateAuth").mockReturnValue({
      ok: false,
      envelope: mkError("AUTH_MISSING", "No GitHub credential available.", {
        suggestedFix: "Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
      }),
    });

    const text = await run({ owner: "o", repo: "r" });
    authSpy.mockRestore();

    const parsed = JSON.parse(text) as { error?: { code: string; message: string } };

    expect(parsed.error).toBeDefined();
    expect(parsed.error?.code).toBe("AUTH_MISSING");
  });

  // -------------------------------------------------------------------------
  // (e) state="auto_dismissed" — dependabot returns results, code scanning is
  //     reported as not-applicable (not a hard failure)
  // -------------------------------------------------------------------------
  test("state auto_dismissed: dependabot returns results, code scanning enabled:false without top-level error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        dependabotAlerts: [makeDependabotAlert(1, "high")],
        // code scanning is never called for auto_dismissed, but if it were it would 422
        codeScanningReject: { status: 422, message: "State not supported" },
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        includeDependabot: true,
        includeCodeScanning: true,
        state: "auto_dismissed",
        limit: 30,
      }),
    ) as {
      error?: unknown;
      rollup: { critical: number; high: number; medium: number; low: number };
      dependabot: { enabled: boolean; total: number; alerts: unknown[] };
      codeScanning: { enabled: boolean; reason: string };
    };

    spy.mockRestore();

    // No top-level error
    expect(parsed.error).toBeUndefined();

    // Dependabot still returns results
    expect(parsed.dependabot.enabled).toBe(true);
    expect(parsed.dependabot.total).toBe(1);
    expect(parsed.dependabot.alerts).toHaveLength(1);

    // Code scanning is reported as not-applicable, not a failure
    expect(parsed.codeScanning.enabled).toBe(false);
    expect(parsed.codeScanning.reason).toBe("state auto_dismissed not supported by code scanning");

    // Rollup only includes dependabot alerts
    expect(parsed.rollup.high).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (d) Severity filter narrows results
  // -------------------------------------------------------------------------
  test("severity filter narrows results to only matching alerts", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        dependabotAlerts: [
          makeDependabotAlert(1, "critical"),
          makeDependabotAlert(2, "high"),
          makeDependabotAlert(3, "low"),
        ],
        codeScanningAlerts: [
          makeCodeScanningAlert(10, "critical"),
          makeCodeScanningAlert(11, "high"),
        ],
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        severity: "critical",
        includeDependabot: true,
        includeCodeScanning: true,
        state: "open",
        limit: 30,
      }),
    ) as {
      rollup: { critical: number; high: number; medium: number; low: number };
      dependabot: { enabled: boolean; total: number; alerts: { severity: string }[] };
      codeScanning: { enabled: boolean; total: number; alerts: { severity: string | null }[] };
    };

    spy.mockRestore();

    // Only critical alerts in each source
    expect(parsed.dependabot.total).toBe(1);
    expect(parsed.dependabot.alerts).toHaveLength(1);
    expect(parsed.dependabot.alerts[0]?.severity).toBe("critical");

    expect(parsed.codeScanning.total).toBe(1);
    expect(parsed.codeScanning.alerts).toHaveLength(1);
    expect(parsed.codeScanning.alerts[0]?.severity).toBe("critical");

    // Rollup only shows critical
    expect(parsed.rollup.critical).toBe(2); // 1 dep + 1 cs
    expect(parsed.rollup.high).toBe(0);
    expect(parsed.rollup.low).toBe(0);
  });
});
