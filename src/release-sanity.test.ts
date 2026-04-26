import { describe, expect, test } from "bun:test";

import { checkReleaseSanity } from "../scripts/release-sanity.js";

const BASE_PACKAGE = {
  name: "@rethunk/github-mcp",
  version: "1.2.3",
  files: ["dist", "README.md"],
};

describe("checkReleaseSanity", () => {
  test("accepts a package version with matching changelog entry and tag ref", () => {
    expect(
      checkReleaseSanity({
        packageJson: BASE_PACKAGE,
        changelog: "## [1.2.3] — 2026-04-26\n\n### Changed\n",
        githubRef: "refs/tags/v1.2.3",
      }),
    ).toEqual([]);
  });

  test("reports mismatched tags and missing changelog entries", () => {
    expect(
      checkReleaseSanity({
        packageJson: BASE_PACKAGE,
        changelog: "## [1.2.2] — 2026-04-26\n",
        githubRef: "refs/tags/v1.2.4",
      }),
    ).toEqual([
      "CHANGELOG.md must contain a ## [1.2.3] release entry.",
      "Git tag v1.2.4 must match package.json version 1.2.3.",
    ]);
  });

  test("requires dist to be included in package files", () => {
    expect(
      checkReleaseSanity({
        packageJson: { ...BASE_PACKAGE, files: ["README.md"] },
        changelog: "## [1.2.3] — 2026-04-26\n",
      }),
    ).toEqual(['package.json "files" must include "dist".']);
  });

  test("rejects test-only files in built dist artifacts", () => {
    expect(
      checkReleaseSanity({
        packageJson: BASE_PACKAGE,
        changelog: "## [1.2.3] — 2026-04-26\n",
        distFiles: ["server.js", "server/test-harness.js"],
      }),
    ).toEqual(["dist must not include test-only artifact server/test-harness.js."]);
  });
});
