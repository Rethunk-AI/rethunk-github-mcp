import { spawn } from "node:child_process";

const DEFAULT_MIN_LINE_COVERAGE = 80;

/**
 * Canonical list of tool files registered via registerRethunkGitHubTools in
 * src/server/tools.ts. Each entry is the base filename (without extension)
 * relative to src/server/.  Keep in sync with tools.ts imports.
 */
export const REGISTERED_TOOL_FILES = [
  "actions-runs-filter-tool",
  "branch-protection-tool",
  "changelog-draft-tool",
  "check-run-create-tool",
  "ci-diagnosis-tool",
  "deployment-status-tool",
  "ecosystem-activity-tool",
  "gh-auth-status-tool",
  "issue-dedup-tool",
  "issue-from-template-tool",
  "labels-sync-tool",
  "module-pin-hint-tool",
  "my-work-tool",
  "org-pulse-tool",
  "pin-drift-tool",
  "pr-comment-batch-tool",
  "pr-create-tool",
  "pr-preflight-tool",
  "pr-review-thread-tool",
  "release-create-tool",
  "release-readiness-tool",
  "repo-status-tool",
  "security-alerts-tool",
  "workflow-dispatch-tool",
] as const;

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function parseAllFilesLineCoverage(output: string): number | undefined {
  const plain = output.replace(ANSI_PATTERN, "");
  const match = plain.match(/all files[^\n|]*\|\s*[\d.]+\s*\|\s*([\d.]+)/i);
  if (!match?.[1]) return undefined;

  return Number.parseFloat(match[1]);
}

/**
 * Check that every registered tool file under src/server/ appears in the
 * coverage report. A tool file absent from the report means it was never
 * imported by any test, so its coverage is effectively zero and invisible
 * to the all-files aggregate gate.
 */
export function assertToolFilesPresent(output: string): void {
  const missing: string[] = [];
  for (const toolFile of REGISTERED_TOOL_FILES) {
    // The coverage table rows contain the file path; match the base name
    // (e.g. "repo-status-tool") so we're not sensitive to path formatting.
    if (!output.includes(toolFile)) {
      missing.push(toolFile);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Coverage blind spot: the following registered tool files are absent from the` +
        ` coverage report (zero imports by tests):\n  ${missing.join("\n  ")}`,
    );
  }
}

export function assertCoverageThreshold(
  output: string,
  minLineCoverage = DEFAULT_MIN_LINE_COVERAGE,
): void {
  const coverage = parseAllFilesLineCoverage(output);
  if (coverage === undefined) {
    throw new Error("No coverage summary found.");
  }

  if (coverage < minLineCoverage) {
    throw new Error(`Coverage ${coverage.toFixed(2)}% is below minimum ${minLineCoverage}%`);
  }

  // Also verify that every registered tool file is visible in the report
  assertToolFilesPresent(output);

  console.log(`Coverage OK: ${coverage.toFixed(2)}%`);
}

async function runCoverageCli(): Promise<void> {
  const outputChunks: Buffer[] = [];
  const proc = spawn("bun", ["test", "src/", "--coverage"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
    process.stdout.write(chunk);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
    process.stderr.write(chunk);
  });

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });

  const output = Buffer.concat(outputChunks).toString("utf8");
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  try {
    assertCoverageThreshold(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await runCoverageCli();
}
