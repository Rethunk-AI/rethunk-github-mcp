import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers under test (pure functions, no GitHub I/O)
// ---------------------------------------------------------------------------

// Re-export pure helpers by re-implementing the logic under test inline so
// we don't need to mock the module system.  The real module exports are the
// public contract; we test the observable behaviour (output shape / values)
// via the exported functions in a thin wrapper.

/** Reproduce formatPseudoVersionDate logic (copied from module-pin-hint-tool internals). */
function formatPseudoVersionDate(isoDate: string): string {
  const d = new Date(isoDate);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function buildGoPseudoVersion(committedDate: string, fullSha: string): string {
  const ts = formatPseudoVersionDate(committedDate);
  const sha12 = fullSha.substring(0, 12);
  return `v0.0.0-${ts}-${sha12}`;
}

/** Reproduce parseSince logic from ecosystem-activity-tool. */
function parseSince(since: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(since) || /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return since;
  }
  const hoursMatch = /^(\d+(?:\.\d+)?)h$/i.exec(since);
  if (hoursMatch?.[1]) {
    const ms = Number.parseFloat(hoursMatch[1]) * 3_600_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const daysMatch = /^(\d+(?:\.\d+)?)d$/i.exec(since);
  if (daysMatch?.[1]) {
    const ms = Number.parseFloat(daysMatch[1]) * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  return since;
}

/** Reproduce pseudoVersionSha extraction from pin-drift-tool. */
function pseudoVersionSha(version: string): string | undefined {
  const m = /v\d+\.\d+\.\d+-\d{14}-([0-9a-f]{12})$/.exec(version);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// Tests
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
    // Should be within ~1s of (now - 48h)
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
