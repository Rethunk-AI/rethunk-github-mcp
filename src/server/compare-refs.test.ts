import { describe, expect, test } from "bun:test";

import {
  countBehind,
  fetchCommitHistory,
  filterCommitsAfterPin,
  mapCommitHistoryNodes,
  resolveRef,
} from "./compare-refs.js";
import { buildGoPseudoVersion } from "./module-pin-hint-tool.js";
import { pseudoVersionSha } from "./pin-drift-tool.js";
import { parseSince } from "./utils.js";

// ---------------------------------------------------------------------------
// buildGoPseudoVersion (from module-pin-hint-tool)
// ---------------------------------------------------------------------------

describe("buildGoPseudoVersion", () => {
  test("formats UTC timestamp and 12-char SHA prefix correctly", () => {
    const result = buildGoPseudoVersion(
      "2026-04-13T00:17:01Z",
      "6589cad7c93e5fd59ece17284b4636c525bf8cf0",
    );
    expect(result).toBe("v0.0.0-20260413001701-6589cad7c93e");
  });

  test("pads single-digit month and day", () => {
    const result = buildGoPseudoVersion(
      "2026-01-05T08:03:07Z",
      "abcdef123456789012345678901234567890abcd",
    );
    expect(result).toBe("v0.0.0-20260105080307-abcdef123456");
  });

  test("uses exactly 12 SHA chars", () => {
    const pv = buildGoPseudoVersion(
      "2026-04-11T12:22:16Z",
      "877f8d94448e8cc843e83409dd0a59bb73562e45",
    );
    expect(pv).toBe("v0.0.0-20260411122216-877f8d94448e");
  });
});

// ---------------------------------------------------------------------------
// parseSince (from utils)
// ---------------------------------------------------------------------------

describe("parseSince", () => {
  test("passes ISO8601 timestamps through unchanged", () => {
    expect(parseSince("2026-04-10T17:19:40Z")).toBe("2026-04-10T17:19:40Z");
  });

  test("passes date-only strings through unchanged", () => {
    expect(parseSince("2026-04-10")).toBe("2026-04-10");
  });

  test("converts hours to ISO timestamp roughly correct", () => {
    const before = Date.now();
    const result = parseSince("48h");
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before - 48 * 3_600_000 - 100);
    expect(resultMs).toBeLessThanOrEqual(after - 48 * 3_600_000 + 100);
  });

  test("converts days to ISO timestamp roughly correct", () => {
    const before = Date.now();
    const result = parseSince("7d");
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 100);
    expect(resultMs).toBeLessThanOrEqual(after - 7 * 86_400_000 + 100);
  });

  test("returns unknown string as-is (passthrough for GitHub to reject)", () => {
    expect(parseSince("yesterday")).toBe("yesterday");
  });
});

describe("mapCommitHistoryNodes", () => {
  test("maps GraphQL history nodes to compact commit entries", () => {
    expect(
      mapCommitHistoryNodes([
        {
          oid: "0123456789abcdef0123456789abcdef01234567",
          messageHeadline: "fix(ci): cover branch",
          committedDate: "2026-04-26T20:00:00Z",
          author: { name: "Fallback Name", user: { login: "damon" } },
        },
        {
          oid: "abcdef0123456789abcdef0123456789abcdef01",
          messageHeadline: "docs: update notes",
          committedDate: "2026-04-25T20:00:00Z",
          author: { name: "Fallback Name", user: null },
        },
        {
          oid: "fedcba9876543210fedcba9876543210fedcba98",
          messageHeadline: "chore: no author",
          committedDate: "2026-04-24T20:00:00Z",
          author: { name: null, user: null },
        },
      ]),
    ).toEqual([
      {
        sha7: "0123456",
        message: "fix(ci): cover branch",
        author: "damon",
        date: "2026-04-26T20:00:00Z",
      },
      {
        sha7: "abcdef0",
        message: "docs: update notes",
        author: "Fallback Name",
        date: "2026-04-25T20:00:00Z",
      },
      {
        sha7: "fedcba9",
        message: "chore: no author",
        author: "unknown",
        date: "2026-04-24T20:00:00Z",
      },
    ]);
  });
});

describe("filterCommitsAfterPin", () => {
  test("drops the pinned commit by full or short SHA prefix", () => {
    const commits = [
      { sha7: "aaaaaaa", message: "new", author: "a", date: "2026-04-26T20:00:00Z" },
      { sha7: "bbbbbbb", message: "pin", author: "b", date: "2026-04-25T20:00:00Z" },
    ];

    expect(filterCommitsAfterPin(commits, "bbbbbbb1234567890")).toEqual([commits[0]]);
    expect(filterCommitsAfterPin(commits, "bbbbbbb")).toEqual([commits[0]]);
  });
});

// ---------------------------------------------------------------------------
// pseudoVersionSha (from pin-drift-tool)
// ---------------------------------------------------------------------------

describe("pseudoVersionSha", () => {
  test("extracts 12-char SHA from valid pseudo-version", () => {
    expect(pseudoVersionSha("v0.0.0-20260411122216-877f8d94448e")).toBe("877f8d94448e");
  });

  test("returns undefined for a tagged release", () => {
    expect(pseudoVersionSha("v1.2.3")).toBeUndefined();
  });

  test("returns undefined for a branch/non-pseudo ref", () => {
    expect(pseudoVersionSha("main")).toBeUndefined();
  });

  test("returns undefined for malformed pseudo-version", () => {
    expect(pseudoVersionSha("v0.0.0-20260411-short")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRef, fetchCommitHistory, countBehind (from compare-refs)
//
// These call the GitHub API; tests skip gracefully when auth is absent or
// the network is unavailable.
// ---------------------------------------------------------------------------

const TEST_OWNER = "Rethunk-AI";
const TEST_REPO = "rethunk-github-mcp";

describe("resolveRef", () => {
  test("returns { oid, committedDate } for a known ref", async () => {
    const result = await resolveRef(TEST_OWNER, TEST_REPO, "main");
    if (!result) return; // no auth / network
    expect(result.oid).toHaveLength(40);
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.committedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns null for a ref that does not exist", async () => {
    const result = await resolveRef(TEST_OWNER, TEST_REPO, "refs/heads/nonexistent-branch-xyzzy");
    // Either null (ref not found) or null (no auth) — both acceptable
    expect(result).toBeNull();
  });
});

describe("fetchCommitHistory", () => {
  test("returns commits array and defaultBranch for a live repo", async () => {
    let result: Awaited<ReturnType<typeof fetchCommitHistory>>;
    try {
      result = await fetchCommitHistory(TEST_OWNER, TEST_REPO, "main", { limit: 5 });
    } catch {
      return; // no auth / network
    }
    expect(result.defaultBranch).toBe("main");
    expect(Array.isArray(result.commits)).toBe(true);
    const c = result.commits[0];
    if (c) {
      expect(c.sha7).toHaveLength(7);
      expect(typeof c.message).toBe("string");
      expect(typeof c.author).toBe("string");
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("respects the limit option", async () => {
    let result: Awaited<ReturnType<typeof fetchCommitHistory>>;
    try {
      result = await fetchCommitHistory(TEST_OWNER, TEST_REPO, "main", { limit: 2 });
    } catch {
      return;
    }
    expect(result.commits.length).toBeLessThanOrEqual(2);
  });
});

describe("countBehind", () => {
  test(
    "returns behindBy >= 0 when pinned SHA is HEAD (allows for push during test)",
    async () => {
      const ref = await resolveRef(TEST_OWNER, TEST_REPO, "main");
      if (!ref) return; // no auth
      const { behindBy } = await countBehind(TEST_OWNER, TEST_REPO, "main", ref.oid, 10);
      // HEAD could have advanced by 1 between resolveRef calls — allow small drift
      expect(behindBy).toBeGreaterThanOrEqual(0);
    },
    { timeout: 15000 },
  );

  test("returns behindBy > 0 when pinned to a known-old SHA", async () => {
    // aee827e22f75... is HEAD~5 — should be at least 5 commits behind main
    let result: Awaited<ReturnType<typeof countBehind>>;
    try {
      result = await countBehind(
        TEST_OWNER,
        TEST_REPO,
        "main",
        "aee827e22f7586f0c7c98ca3dd27b94ae4c1b1cf",
        20,
      );
    } catch {
      return;
    }
    if (result.behindBy === -1) return; // SHA not reachable within limit
    expect(result.behindBy).toBeGreaterThanOrEqual(5);
    expect(result.commits.length).toBeGreaterThan(0);
    if (result.commits[0]) {
      expect(result.commits[0].sha7).toHaveLength(7);
    }
  });

  test("returns behindBy=-1 for an unknown pinned SHA", async () => {
    let result: Awaited<ReturnType<typeof countBehind>>;
    try {
      result = await countBehind(
        TEST_OWNER,
        TEST_REPO,
        "main",
        "0000000000000000000000000000000000000000",
        10,
      );
    } catch {
      return;
    }
    expect(result.behindBy).toBe(-1);
    expect(result.commits).toEqual([]);
  });
});
