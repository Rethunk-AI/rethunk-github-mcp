import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  version?: unknown;
  files?: unknown;
}

interface ReleaseSanityInput {
  packageJson: PackageJson;
  changelog: string;
  githubRef?: string;
  distFiles?: string[];
}

export function checkReleaseSanity(input: ReleaseSanityInput): string[] {
  const errors: string[] = [];
  const version = input.packageJson.version;

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push("package.json version must be a valid semver string.");
    return errors;
  }

  const releaseHeading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`, "m");
  if (!releaseHeading.test(input.changelog)) {
    errors.push(`CHANGELOG.md must contain a ## [${version}] release entry.`);
  }

  if (
    !Array.isArray(input.packageJson.files) ||
    !input.packageJson.files.some((entry) => entry === "dist")
  ) {
    errors.push('package.json "files" must include "dist".');
  }

  if (input.githubRef?.startsWith("refs/tags/")) {
    const tagVersion = input.githubRef.slice("refs/tags/v".length);
    if (tagVersion !== version) {
      errors.push(`Git tag v${tagVersion} must match package.json version ${version}.`);
    }
  }

  for (const file of input.distFiles ?? []) {
    if (isForbiddenDistArtifact(file)) {
      errors.push(`dist must not include test-only artifact ${file}.`);
    }
  }

  return errors;
}

function isForbiddenDistArtifact(file: string): boolean {
  return (
    file.endsWith(".test.js") ||
    file === "server/test-harness.js" ||
    file === "coverage-threshold.js" ||
    file === "release-sanity.js"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
}

function runReleaseSanityCli(): void {
  const errors = checkReleaseSanity({
    packageJson: readPackageJson(),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    githubRef: process.env.GITHUB_REF,
    distFiles: listDistFiles(),
  });

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`Release sanity check failed: ${error}\n`);
    }
    process.exit(1);
  }

  console.log("Release sanity OK");
}

function listDistFiles(): string[] {
  if (!existsSync("dist")) return [];

  const files: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };

  walk("dist");
  return files;
}

if (import.meta.main) {
  runReleaseSanityCli();
}
