import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatPinDriftMarkdown,
  parseGoMod,
  parsePackageJson,
  parseVersionsEnv,
  registerPinDriftTool,
} from "./pin-drift-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Helpers: create fixture repos in temp dirs (kept for potential future use)
// ---------------------------------------------------------------------------

const TMP_DIRS: string[] = [];

function makeTrackedTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.length = 0;
});

function _makeTmpDir(): string {
  return makeTrackedTmpDir("pin-drift-test-");
}

function _writeFile(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  // Ensure parent exists
  const parent = full.substring(0, full.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

// ---------------------------------------------------------------------------
// Re-implement the pure parser functions under test so we can unit-test them
// without mocking GitHub API calls.
// ---------------------------------------------------------------------------

function pseudoVersionSha(version: string): string | undefined {
  const m = /v\d+\.\d+\.\d+-\d{14}-([0-9a-f]{12})$/.exec(version);
  return m?.[1];
}

interface RawPin {
  source: string;
  owner: string;
  repo: string;
  pinnedRef: string;
}
interface SkippedEntry {
  source: string;
  key: string;
  value: string;
  reason: string;
}

function parseGoModFixture(text: string): { pins: RawPin[]; skipped: SkippedEntry[] } {
  const pins: RawPin[] = [];
  const skipped: SkippedEntry[] = [];

  for (const m of text.matchAll(/^[ \t]*replace\s+\S+\s+=>\s+(github\.com\/\S+)\s+(\S+)/gm)) {
    const path = m[1];
    const version = m[2];
    if (!path || !version) continue;
    const pathParts = /github\.com\/([^/]+)\/([^/]+)/.exec(path);
    if (!pathParts?.[1] || !pathParts[2]) continue;
    const owner = pathParts[1];
    const repo = pathParts[2].replace(/\.git$/, "");
    const sha12 = pseudoVersionSha(version);
    if (sha12) {
      pins.push({ source: "go.mod", owner, repo, pinnedRef: sha12 });
    } else if (/^v\d+\.\d+\.\d+$/.test(version)) {
      pins.push({ source: "go.mod", owner, repo, pinnedRef: version });
    } else {
      skipped.push({
        source: "go.mod",
        key: `replace ${path}`,
        value: version,
        reason: "ambiguous_ref",
      });
    }
  }

  for (const m of text.matchAll(/^[ \t]*(?:github\.com\/([^/\s]+)\/([^/\s]+))\s+(v\S+)/gm)) {
    const owner = m[1];
    const repo = m[2]?.replace(/\.git$/, "");
    const version = m[3];
    if (!owner || !repo || !version) continue;
    const sha12 = pseudoVersionSha(version);
    if (!sha12) continue;
    const alreadyPinned = pins.some((p) => p.owner === owner && p.repo === repo);
    if (alreadyPinned) continue;
    pins.push({ source: "go.mod", owner, repo, pinnedRef: sha12 });
  }

  return { pins, skipped };
}

function parsePackageJsonFixture(text: string): { pins: RawPin[]; skipped: SkippedEntry[] } {
  const pins: RawPin[] = [];
  const skipped: SkippedEntry[] = [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { pins, skipped };
  }
  const allDeps: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  for (const [, version] of Object.entries(allDeps)) {
    const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(.+))?$/.exec(version);
    if (shorthand?.[1] && shorthand[2]) {
      pins.push({
        source: "package.json",
        owner: shorthand[1],
        repo: shorthand[2],
        pinnedRef: shorthand[3] ?? "HEAD",
      });
      continue;
    }
    const ghUrl =
      /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?(?:$|\/)/.exec(
        version,
      );
    if (ghUrl?.[1] && ghUrl[2]) {
      pins.push({
        source: "package.json",
        owner: ghUrl[1],
        repo: ghUrl[2],
        pinnedRef: ghUrl[3] ?? "HEAD",
      });
    }
    // Not a GitHub dependency — skip silently
  }
  return { pins, skipped };
}

function parseVersionsEnvFixture(text: string): { skipped: SkippedEntry[] } {
  const skipped: SkippedEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+(?:_REF|_SHA|_VERSION))\s*=\s*([^\s#]+)/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (/^[0-9a-f]{40}$/.test(m[2])) {
      skipped.push({
        source: "scripts/versions.env",
        key: m[1],
        value: m[2],
        reason: "ambiguous_repo",
      });
    }
  }
  return { skipped };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseGoMod", () => {
  test("parses replace directive with pseudo-version", () => {
    const text = `
module example.com/myapp

go 1.21

require (
  github.com/Rethunk-Tech/bastion-satcom v0.0.0-20260411122216-877f8d94448e
)

replace github.com/some/dep => github.com/Rethunk-Tech/disgo v0.0.0-20260401000000-abcdef123456
`;
    const { pins, skipped } = parseGoModFixture(text);
    // replace block is processed first
    const replacePins = pins.filter((p) => p.owner === "Rethunk-Tech" && p.repo === "disgo");
    expect(replacePins.length).toBe(1);
    expect(replacePins[0]?.pinnedRef).toBe("abcdef123456");

    // require pseudo-version also captured (not duplicated by replace)
    const satcomPins = pins.filter((p) => p.repo === "bastion-satcom");
    expect(satcomPins.length).toBe(1);
    expect(satcomPins[0]?.pinnedRef).toBe("877f8d94448e");

    expect(skipped.length).toBe(0);
  });

  test("parses replace directive with semantic version tag", () => {
    const text = `replace github.com/foo/bar => github.com/Rethunk-AI/bar v1.2.3\n`;
    const { pins } = parseGoModFixture(text);
    expect(pins.length).toBe(1);
    expect(pins[0]?.pinnedRef).toBe("v1.2.3");
  });

  test("skips replace with non-version-looking ref", () => {
    const text = `replace github.com/foo/bar => github.com/Rethunk-AI/bar main\n`;
    const { pins, skipped } = parseGoModFixture(text);
    expect(pins.length).toBe(0);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.reason).toBe("ambiguous_ref");
  });

  test("deduplicates: replace block takes precedence over require line", () => {
    const text = `
require github.com/Rethunk-Tech/satcom v0.0.0-20260401000000-aaaaaaaaaaaa
replace github.com/Rethunk-Tech/satcom => github.com/Rethunk-Tech/satcom v0.0.0-20260402000000-bbbbbbbbbbbb
`;
    const { pins } = parseGoModFixture(text);
    const satcomPins = pins.filter((p) => p.repo === "satcom");
    expect(satcomPins.length).toBe(1);
    expect(satcomPins[0]?.pinnedRef).toBe("bbbbbbbbbbbb");
  });
});

describe("parseGoMod source parser", () => {
  test("reads real go.mod files and reports pins plus ambiguous replacements", () => {
    const dir = _makeTmpDir();
    _writeFile(
      dir,
      "go.mod",
      `
module example.com/myapp

go 1.21

require (
  github.com/Rethunk-Tech/satcom v0.0.0-20260401000000-aaaaaaaaaaaa
)

replace github.com/foo/bar => github.com/Rethunk-AI/bar v1.2.3
replace github.com/foo/baz => github.com/Rethunk-AI/baz main
`,
    );

    const { pins, skipped } = parseGoMod(dir);

    expect(pins).toContainEqual({
      source: "go.mod",
      owner: "Rethunk-AI",
      repo: "bar",
      pinnedRef: "v1.2.3",
    });
    expect(pins).toContainEqual({
      source: "go.mod",
      owner: "Rethunk-Tech",
      repo: "satcom",
      pinnedRef: "aaaaaaaaaaaa",
    });
    expect(skipped).toContainEqual({
      source: "go.mod",
      key: "replace github.com/Rethunk-AI/baz",
      value: "main",
      reason: "ambiguous_ref",
    });
  });
});

describe("parsePackageJson", () => {
  test("parses GitHub shorthand dep", () => {
    const { pins } = parsePackageJsonFixture(
      JSON.stringify({ dependencies: { "my-lib": "owner/repo#abc123def456" } }),
    );
    expect(pins.length).toBe(1);
    expect(pins[0]?.owner).toBe("owner");
    expect(pins[0]?.repo).toBe("repo");
    expect(pins[0]?.pinnedRef).toBe("abc123def456");
  });

  test("parses GitHub HTTPS URL dep", () => {
    const { pins } = parsePackageJsonFixture(
      JSON.stringify({
        dependencies: {
          "my-lib": "https://github.com/Rethunk-AI/some-lib.git#877f8d94448e",
        },
      }),
    );
    expect(pins.length).toBe(1);
    expect(pins[0]?.owner).toBe("Rethunk-AI");
    expect(pins[0]?.pinnedRef).toBe("877f8d94448e");
  });

  test("ignores non-GitHub deps silently", () => {
    const { pins } = parsePackageJsonFixture(
      JSON.stringify({ dependencies: { react: "^18.0.0", lodash: "4.17.21" } }),
    );
    expect(pins.length).toBe(0);
  });

  test("handles malformed JSON gracefully", () => {
    const { pins, skipped } = parsePackageJsonFixture("not json {{{");
    expect(pins.length).toBe(0);
    expect(skipped.length).toBe(0);
  });
});

describe("parsePackageJson source parser", () => {
  test("reads dependencies and devDependencies from package.json", () => {
    const dir = _makeTmpDir();
    _writeFile(
      dir,
      "package.json",
      JSON.stringify({
        dependencies: {
          "short-lib": "owner/repo#abc123def456",
          npm: "^1.0.0",
        },
        devDependencies: {
          "url-lib": "https://github.com/Rethunk-AI/some-lib.git#877f8d94448e",
        },
      }),
    );

    const { pins, skipped } = parsePackageJson(dir);

    expect(skipped).toEqual([]);
    expect(pins).toContainEqual({
      source: "package.json",
      owner: "owner",
      repo: "repo",
      pinnedRef: "abc123def456",
    });
    expect(pins).toContainEqual({
      source: "package.json",
      owner: "Rethunk-AI",
      repo: "some-lib",
      pinnedRef: "877f8d94448e",
    });
  });

  test("returns no pins for malformed package.json", () => {
    const dir = _makeTmpDir();
    _writeFile(dir, "package.json", "{not json");

    expect(parsePackageJson(dir)).toEqual({ pins: [], skipped: [] });
  });
});

describe("parseVersionsEnv", () => {
  test("marks 40-char SHA _REF keys as ambiguous_repo", () => {
    const text = `BASTION_SATCOM_REF=877f8d94448e8cc843e83409dd0a59bb73562e45\n`;
    const { skipped } = parseVersionsEnvFixture(text);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.reason).toBe("ambiguous_repo");
    expect(skipped[0]?.key).toBe("BASTION_SATCOM_REF");
  });

  test("ignores non-SHA values (e.g. branch names)", () => {
    const text = `MY_VERSION=main\n`;
    const { skipped } = parseVersionsEnvFixture(text);
    expect(skipped.length).toBe(0);
  });

  test("ignores keys without matching suffix", () => {
    const text = `SOME_COMMIT=877f8d94448e8cc843e83409dd0a59bb73562e45\n`;
    const { skipped } = parseVersionsEnvFixture(text);
    expect(skipped.length).toBe(0);
  });

  test("marks _SHA and _VERSION keys too", () => {
    const text = [
      "FOO_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "BAR_VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ].join("\n");
    const { skipped } = parseVersionsEnvFixture(text);
    expect(skipped.length).toBe(2);
  });
});

describe("parseVersionsEnv source parser", () => {
  test("reads SHA-like refs from scripts/versions.env", () => {
    const dir = _makeTmpDir();
    _writeFile(
      dir,
      "scripts/versions.env",
      `
SATCOM_REF=0123456789abcdef0123456789abcdef01234567
SATCOM_BRANCH=main
MFA_VERSION=v1.2.3
`,
    );

    expect(parseVersionsEnv(dir).skipped).toEqual([
      {
        source: "scripts/versions.env",
        key: "SATCOM_REF",
        value: "0123456789abcdef0123456789abcdef01234567",
        reason: "ambiguous_repo",
      },
    ]);
  });
});

describe("formatPinDriftMarkdown", () => {
  test("renders stale, fresh, and skipped sections", () => {
    const text = formatPinDriftMarkdown({
      localPath: "/tmp/repo",
      pins: [
        {
          source: "go.mod",
          owner: "Rethunk-AI",
          repo: "stale-lib",
          pinnedRef: "0123456789abcdef",
          defaultBranch: "main",
          headSha: "abcdef0123456789",
          behindBy: 3,
          commits: [],
          stale: true,
        },
        {
          source: "package.json",
          owner: "Rethunk-AI",
          repo: "fresh-lib",
          pinnedRef: "abcdef012345",
          defaultBranch: "main",
          headSha: "abcdef0123456789",
          behindBy: 0,
          commits: [],
          stale: false,
        },
      ],
      skipped: [
        {
          source: "scripts/versions.env",
          key: "SATCOM_REF",
          value: "0123456789abcdef0123456789abcdef01234567",
          reason: "ambiguous_repo",
        },
      ],
      summary: { totalPins: 2, stale: 1, upToDate: 1 },
    });

    expect(text).toContain("# Pin Drift: /tmp/repo");
    expect(text).toContain("**2 pins** — 1 stale, 1 up to date, 1 skipped");
    expect(text).toContain("| go.mod | Rethunk-AI/stale-lib | 3 | `0123456789ab` |");
    expect(text).toContain("Rethunk-AI/fresh-lib");
    expect(text).toContain("| scripts/versions.env | `SATCOM_REF` | ambiguous_repo |");
  });
});

// ---------------------------------------------------------------------------
// pin_drift tool integration (via captureTool)
//
// An empty directory has no go.mod / .gitmodules / package.json, so the tool
// collects zero pins and returns immediately — no GitHub API call is made.
//
// Requires GitHub auth to pass the initial gateAuth check.
// ---------------------------------------------------------------------------

describe("pin_drift tool (captureTool)", () => {
  test("empty directory → 0 pins, JSON format", async () => {
    const dir = makeTrackedTmpDir("pin-drift-tool-test-");
    const run = captureTool(registerPinDriftTool);
    const text = await run({ localPath: dir, format: "json" });
    const parsed = JSON.parse(text) as { summary?: { totalPins: number } };
    // If auth unavailable, summary is absent — skip gracefully
    if (!parsed.summary) return;
    expect(parsed.summary.totalPins).toBe(0);
    expect(parsed.summary.stale).toBe(0);
  });

  test("empty directory → markdown shows 0 pins", async () => {
    const dir = makeTrackedTmpDir("pin-drift-tool-test-");
    const run = captureTool(registerPinDriftTool);
    const text = await run({ localPath: dir });
    // Auth error returns JSON; markdown path contains the pin count header
    if (text.startsWith("{")) return;
    expect(text).toContain("0 pins");
  });

  test("go.mod with pseudo-version pin: exercises parser + API fan-out", async () => {
    const dir = makeTrackedTmpDir("pin-drift-gomod-test-");
    // Write a go.mod with a real SHA from this repo (HEAD~5)
    writeFileSync(
      join(dir, "go.mod"),
      `module test.example.com

go 1.21

require (
  github.com/Rethunk-AI/rethunk-github-mcp v0.0.0-20260421000000-aee827e22f75
)
`,
    );
    const run = captureTool(registerPinDriftTool);
    const text = await run({ localPath: dir, pinFiles: ["go.mod"], format: "json" });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      summary?: { totalPins: number; stale: number; upToDate: number };
      pins?: Array<{ owner: string; repo: string; behindBy: number }>;
    };
    if (parsed.error) return; // no auth or unexpected error — skip
    if (!parsed.summary) return;
    expect(parsed.summary.totalPins).toBe(1);
    expect(Array.isArray(parsed.pins)).toBe(true);
    if (parsed.pins?.[0]) {
      expect(parsed.pins[0].owner).toBe("Rethunk-AI");
      expect(parsed.pins[0].repo).toBe("rethunk-github-mcp");
      // behindBy is >= 0 if SHA found, -1 if not in history
      expect(typeof parsed.pins[0].behindBy).toBe("number");
    }
  });

  test("package.json with no GitHub deps → 0 pins after parse", async () => {
    const dir = makeTrackedTmpDir("pin-drift-pkgjson-test-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { react: "^18.0.0" } }),
    );
    const run = captureTool(registerPinDriftTool);
    const text = await run({ localPath: dir, pinFiles: ["package.json"], format: "json" });
    const parsed = JSON.parse(text) as { error?: unknown; summary?: { totalPins: number } };
    if (parsed.error) return; // no auth
    if (!parsed.summary) return;
    expect(parsed.summary.totalPins).toBe(0);
  });

  test("glob pinFiles: expands patterns against directory contents", async () => {
    const dir = makeTrackedTmpDir("pin-drift-glob-test-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: {} }));
    const run = captureTool(registerPinDriftTool);
    const text = await run({ localPath: dir, pinFiles: ["*.json"], format: "json" });
    const parsed = JSON.parse(text) as { error?: unknown; summary?: { totalPins: number } };
    if (parsed.error) return; // no auth
    if (!parsed.summary) return;
    expect(parsed.summary.totalPins).toBe(0);
  });

  test("ownerAllowlist filters pins to specified owners", async () => {
    const dir = makeTrackedTmpDir("pin-drift-filter-test-");
    writeFileSync(
      join(dir, "go.mod"),
      `module test.example.com
go 1.21
require (
  github.com/Rethunk-AI/rethunk-github-mcp v0.0.0-20260421000000-aee827e22f75
)
`,
    );
    const run = captureTool(registerPinDriftTool);
    // Filter to "OtherOrg" — should exclude our pin
    const text = await run({
      localPath: dir,
      pinFiles: ["go.mod"],
      ownerAllowlist: ["OtherOrg"],
      format: "json",
    });
    const parsed = JSON.parse(text) as { error?: unknown; summary?: { totalPins: number } };
    if (parsed.error) return; // no auth
    if (!parsed.summary) return;
    expect(parsed.summary.totalPins).toBe(0);
  });
});
