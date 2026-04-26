import { spawn } from "node:child_process";

const DEFAULT_MIN_LINE_COVERAGE = 80;

export function parseAllFilesLineCoverage(output: string): number | undefined {
  const match = output.match(/all files[^\n|]*\|\s*[\d.]+\s*\|\s*([\d.]+)/i);
  if (!match?.[1]) return undefined;

  return Number.parseFloat(match[1]);
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
