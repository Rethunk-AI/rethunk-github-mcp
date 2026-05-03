import { describe, expect, test } from "bun:test";

import {
  type CheckNode,
  extractFirstPR,
  extractPRNumbers,
  firstLine,
  isFailed,
  normalizeFailedChecks,
  parseSince,
  sha7,
  sha12,
  tailTruncate,
  timeAgo,
} from "./utils.js";

// ---------------------------------------------------------------------------
// parseSince
// ---------------------------------------------------------------------------

describe("parseSince", () => {
  test("passes ISO8601 datetime through unchanged", () => {
    expect(parseSince("2026-04-10T17:19:40Z")).toBe("2026-04-10T17:19:40Z");
  });

  test("passes date-only string through unchanged", () => {
    expect(parseSince("2026-04-10")).toBe("2026-04-10");
  });

  test("converts integer hours to an ISO timestamp", () => {
    const before = Date.now();
    const result = parseSince("24h");
    const after = Date.now();
    const ms = new Date(result).getTime();
    expect(ms).toBeGreaterThanOrEqual(before - 24 * 3_600_000 - 200);
    expect(ms).toBeLessThanOrEqual(after - 24 * 3_600_000 + 200);
  });

  test("converts fractional hours to an ISO timestamp", () => {
    const before = Date.now();
    const result = parseSince("0.5h");
    const after = Date.now();
    const ms = new Date(result).getTime();
    expect(ms).toBeGreaterThanOrEqual(before - 0.5 * 3_600_000 - 200);
    expect(ms).toBeLessThanOrEqual(after - 0.5 * 3_600_000 + 200);
  });

  test("converts integer days to an ISO timestamp", () => {
    const before = Date.now();
    const result = parseSince("7d");
    const after = Date.now();
    const ms = new Date(result).getTime();
    expect(ms).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 200);
    expect(ms).toBeLessThanOrEqual(after - 7 * 86_400_000 + 200);
  });

  test("converts fractional days to an ISO timestamp", () => {
    const before = Date.now();
    const result = parseSince("1.5d");
    const after = Date.now();
    const ms = new Date(result).getTime();
    expect(ms).toBeGreaterThanOrEqual(before - 1.5 * 86_400_000 - 200);
    expect(ms).toBeLessThanOrEqual(after - 1.5 * 86_400_000 + 200);
  });

  test("is case-insensitive for h/d suffix", () => {
    const lower = parseSince("6h");
    const upper = parseSince("6H");
    // Both should parse — timestamps within a few ms of each other
    expect(Math.abs(new Date(lower).getTime() - new Date(upper).getTime())).toBeLessThan(100);
  });

  test("passes unrecognised string through unchanged", () => {
    expect(parseSince("yesterday")).toBe("yesterday");
    expect(parseSince("last week")).toBe("last week");
  });
});

// ---------------------------------------------------------------------------
// firstLine / sha7 / sha12 / timeAgo / isFailed
// ---------------------------------------------------------------------------

describe("firstLine", () => {
  test("returns text before first newline", () => {
    expect(firstLine("alpha\nbeta")).toBe("alpha");
  });

  test("returns whole string when no newline", () => {
    expect(firstLine("only")).toBe("only");
  });
});

describe("sha7 / sha12", () => {
  test("prefixes full shas", () => {
    expect(sha7("abcdef1234567890")).toBe("abcdef1");
    expect(sha12("abcdef0123456789abcd")).toBe("abcdef012345");
  });
});

describe("timeAgo", () => {
  test("returns now for very recent timestamps", () => {
    expect(timeAgo(new Date().toISOString())).toBe("now");
  });

  test("returns minutes for sub-hour age", () => {
    const t = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(timeAgo(t)).toBe("30m ago");
  });

  test("returns hours for sub-day age", () => {
    const t = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(timeAgo(t)).toBe("3h ago");
  });

  test("returns days for sub-week age", () => {
    const t = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(timeAgo(t)).toBe("3d ago");
  });

  test("returns weeks for older dates", () => {
    const t = new Date(Date.now() - 10 * 604_800_000).toISOString();
    expect(timeAgo(t)).toBe("10w ago");
  });
});

describe("isFailed", () => {
  test("detects failure conclusions case-sensitively", () => {
    expect(isFailed("failure")).toBe(true);
    expect(isFailed("FAILURE")).toBe(true);
    expect(isFailed("SUCCESS")).toBe(false);
    expect(isFailed(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractPRNumbers
// ---------------------------------------------------------------------------

describe("extractPRNumbers", () => {
  test("returns empty array for message with no PR reference", () => {
    expect(extractPRNumbers("chore: tidy things up")).toEqual([]);
  });

  test("extracts a single PR number", () => {
    expect(extractPRNumbers("feat: add logging (#42)")).toEqual([42]);
  });

  test("extracts multiple PR numbers in order", () => {
    expect(extractPRNumbers("Merge (#7) and (#99) and (#12)")).toEqual([7, 99, 12]);
  });

  test("ignores bare hash without parentheses", () => {
    expect(extractPRNumbers("refs #123")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFirstPR
// ---------------------------------------------------------------------------

describe("extractFirstPR", () => {
  test("returns undefined for message with no PR reference", () => {
    expect(extractFirstPR("chore: update deps")).toBeUndefined();
  });

  test("returns the first PR number", () => {
    expect(extractFirstPR("fix: correct (#55)")).toBe(55);
  });

  test("returns only the first when multiple references exist", () => {
    expect(extractFirstPR("Merge (#3) and (#8)")).toBe(3);
  });

  test("returns undefined when PR token is not numeric", () => {
    expect(extractFirstPR("(#abc)")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tailTruncate
// ---------------------------------------------------------------------------

describe("tailTruncate", () => {
  test("returns text unchanged when within limit", () => {
    const text = "line1\nline2\nline3";
    expect(tailTruncate(text, 5)).toBe(text);
  });

  test("returns text unchanged at exact limit", () => {
    const text = "a\nb\nc";
    expect(tailTruncate(text, 3)).toBe(text);
  });

  test("truncates and keeps the LAST maxLines lines", () => {
    const lines = ["line1", "line2", "line3", "line4", "line5"];
    const result = tailTruncate(lines.join("\n"), 3);
    expect(result).toContain("line3\nline4\nline5");
    expect(result).toContain("[2 lines above truncated]");
    expect(result).not.toContain("line1");
    expect(result).not.toContain("line2");
  });

  test("truncation header shows the correct count", () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
    const result = tailTruncate(text, 4);
    expect(result).toContain("[6 lines above truncated]");
  });
});

// ---------------------------------------------------------------------------
// normalizeFailedChecks
// ---------------------------------------------------------------------------

describe("normalizeFailedChecks", () => {
  test("returns empty array for empty input", () => {
    expect(normalizeFailedChecks([])).toEqual([]);
  });

  test("filters out CheckRun nodes with SUCCESS conclusion", () => {
    const nodes: CheckNode[] = [{ name: "build", conclusion: "SUCCESS" }];
    expect(normalizeFailedChecks(nodes)).toEqual([]);
  });

  test("filters out CheckRun nodes with SKIPPED conclusion", () => {
    const nodes: CheckNode[] = [{ name: "optional", conclusion: "SKIPPED" }];
    expect(normalizeFailedChecks(nodes)).toEqual([]);
  });

  test("keeps CheckRun nodes with FAILURE conclusion", () => {
    const nodes: CheckNode[] = [{ name: "tests", conclusion: "FAILURE" }];
    expect(normalizeFailedChecks(nodes)).toEqual([{ name: "tests", conclusion: "FAILURE" }]);
  });

  test("keeps CheckRun nodes with other non-success conclusions", () => {
    const nodes: CheckNode[] = [{ name: "lint", conclusion: "TIMED_OUT" }];
    expect(normalizeFailedChecks(nodes)).toEqual([{ name: "lint", conclusion: "TIMED_OUT" }]);
  });

  test("filters out StatusContext nodes with SUCCESS state", () => {
    const nodes: CheckNode[] = [{ context: "ci/status", state: "SUCCESS" }];
    expect(normalizeFailedChecks(nodes)).toEqual([]);
  });

  test("keeps StatusContext nodes with non-SUCCESS state", () => {
    const nodes: CheckNode[] = [{ context: "ci/status", state: "FAILURE" }];
    expect(normalizeFailedChecks(nodes)).toEqual([{ name: "ci/status", conclusion: "FAILURE" }]);
  });

  test("falls back to 'unknown' when name/context are absent", () => {
    const nodes: CheckNode[] = [{ conclusion: "FAILURE" }];
    expect(normalizeFailedChecks(nodes)).toEqual([{ name: "unknown", conclusion: "FAILURE" }]);
  });

  test("filters completely empty nodes (no conclusion, no state)", () => {
    const nodes: CheckNode[] = [{}];
    expect(normalizeFailedChecks(nodes)).toEqual([]);
  });

  test("handles a mixed list correctly", () => {
    const nodes: CheckNode[] = [
      { name: "build", conclusion: "SUCCESS" },
      { name: "lint", conclusion: "FAILURE" },
      { name: "skip", conclusion: "SKIPPED" },
      { context: "ci/jenkins", state: "PENDING" },
    ];
    expect(normalizeFailedChecks(nodes)).toEqual([
      { name: "lint", conclusion: "FAILURE" },
      { name: "ci/jenkins", conclusion: "PENDING" },
    ]);
  });
});
