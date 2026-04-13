import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Pure helper under test (reproduced inline to avoid GitHub API calls)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatPseudoVersionDate", () => {
  test("formats well-known date correctly", () => {
    expect(formatPseudoVersionDate("2026-04-13T00:17:01Z")).toBe("20260413001701");
  });

  test("pads month, day, hour, minute, second to 2 chars", () => {
    expect(formatPseudoVersionDate("2026-01-02T03:04:05Z")).toBe("20260102030405");
  });

  test("uses UTC regardless of local TZ", () => {
    // Midnight UTC
    expect(formatPseudoVersionDate("2026-06-15T00:00:00Z")).toBe("20260615000000");
  });
});

describe("buildGoPseudoVersion", () => {
  test("builds canonical pseudo-version for known SHA", () => {
    // From the task spec example
    expect(
      buildGoPseudoVersion("2026-04-13T00:17:01Z", "6589cad7c93e5fd59ece17284b4636c525bf8cf0"),
    ).toBe("v0.0.0-20260413001701-6589cad7c93e");
  });

  test("uses only first 12 chars of SHA", () => {
    const pv = buildGoPseudoVersion(
      "2026-04-11T12:22:16Z",
      "877f8d94448e8cc843e83409dd0a59bb73562e45",
    );
    expect(pv).toBe("v0.0.0-20260411122216-877f8d94448e");
  });

  test("prefix is always v0.0.0", () => {
    const pv = buildGoPseudoVersion(
      "2026-01-01T00:00:00Z",
      "aabbccddeeff00112233445566778899aabbccdd",
    );
    expect(pv.startsWith("v0.0.0-")).toBe(true);
  });

  test("timestamp segment is exactly 14 chars", () => {
    const pv = buildGoPseudoVersion(
      "2026-07-04T23:59:59Z",
      "1234567890abcdef1234567890abcdef12345678",
    );
    const parts = pv.split("-");
    // parts: ["v0.0.0", "20260704235959", "1234567890ab"]
    expect(parts[1]?.length).toBe(14);
    expect(parts[2]?.length).toBe(12);
  });
});
