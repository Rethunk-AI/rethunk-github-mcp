import { readFileSync } from "node:fs";

interface PackageJson {
  version?: unknown;
  files?: unknown;
}

interface ReleaseSanityInput {
  packageJson: PackageJson;
  changelog: string;
  githubRef?: string;
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

  return errors;
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
  });

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`Release sanity check failed: ${error}\n`);
    }
    process.exit(1);
  }

  console.log("Release sanity OK");
}

if (import.meta.main) {
  runReleaseSanityCli();
}
