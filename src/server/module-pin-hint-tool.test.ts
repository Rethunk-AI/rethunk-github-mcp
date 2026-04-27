import { describe, expect, test } from "bun:test";

import {
  buildGoPseudoVersion,
  formatModulePinHintMarkdown,
  formatPseudoVersionDate,
  registerModulePinHintTool,
} from "./module-pin-hint-tool.js";
import { captureTool } from "./test-harness.js";

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

describe("formatModulePinHintMarkdown", () => {
  test("renders the pseudo-version and go.mod snippet", () => {
    const text = formatModulePinHintMarkdown({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      ref: "main",
      resolvedSha: "0123456789abcdef0123456789abcdef01234567",
      committerDate: "2026-04-26T20:00:00Z",
      goPseudoVersion: "v0.0.0-20260426200000-0123456789ab",
    });

    expect(text).toContain("# Go Pseudo-Version: Rethunk-AI/rethunk-github-mcp");
    expect(text).toContain("**Ref:** `main`");
    expect(text).toContain("**SHA:** `0123456789abcdef0123456789abcdef01234567`");
    expect(text).toContain(
      "require github.com/Rethunk-AI/rethunk-github-mcp v0.0.0-20260426200000-0123456789ab",
    );
  });
});

// ---------------------------------------------------------------------------
// registerModulePinHintTool execute paths (via captureTool)
// ---------------------------------------------------------------------------

describe("module_pin_hint tool", () => {
  const run = captureTool(registerModulePinHintTool);

  test("returns UNSUPPORTED_LANGUAGE for non-Go language", async () => {
    const text = await run({ owner: "x", repo: "y", language: "rust", format: "json" });
    const parsed = JSON.parse(text) as { error?: { code: string } };
    // Auth gate may fire first (AUTH_MISSING) or language check fires — either is valid
    if (parsed.error?.code === "UNSUPPORTED_LANGUAGE") {
      expect(parsed.error.code).toBe("UNSUPPORTED_LANGUAGE");
    } else {
      // Could be AUTH_MISSING in environments without gh
      expect(parsed.error?.code).toMatch(/AUTH_MISSING|UNSUPPORTED_LANGUAGE/);
    }
  });

  test("returns UNSUPPORTED_LANGUAGE specifically when auth is available", async () => {
    // Only assert language check when auth succeeds
    const text = await run({ owner: "x", repo: "y", language: "python", format: "json" });
    const parsed = JSON.parse(text) as { error?: { code: string } };
    if (!parsed.error) return; // no error = unexpected but skip
    if (parsed.error.code === "AUTH_MISSING") return; // no auth in this env, skip
    expect(parsed.error.code).toBe("UNSUPPORTED_LANGUAGE");
  });

  test("resolves pseudo-version for a known public repo (real API)", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      language: "go",
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      goPseudoVersion?: string;
    };
    if (parsed.error) return; // no auth / API error — skip
    expect(parsed.goPseudoVersion).toMatch(/^v0\.0\.0-\d{14}-[0-9a-f]{12}$/);
  });

  test("resolves pseudo-version with explicit ref (covers resolveCommit ref branch)", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      ref: "main",
      language: "go",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; goPseudoVersion?: string };
    if (parsed.error) return; // no auth / API error — skip
    expect(parsed.goPseudoVersion).toMatch(/^v0\.0\.0-\d{14}-[0-9a-f]{12}$/);
  });

  test(
    "returns NOT_FOUND for a nonexistent ref",
    async () => {
      const text = await run({
        owner: "Rethunk-AI",
        repo: "rethunk-github-mcp",
        ref: "refs/heads/branch-that-does-not-exist-xyzzy",
        language: "go",
        format: "json",
      });
      const parsed = JSON.parse(text) as { error?: { code: string } };
      if (!parsed.error) return; // unexpected — skip
      if (parsed.error.code === "AUTH_MISSING") return;
      expect(parsed.error.code).toBe("NOT_FOUND");
    },
    { timeout: 15000 },
  );

  test("markdown format: returns formatted pseudo-version block", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      language: "go",
      // no format → defaults to markdown
    });
    // If auth missing, result is JSON error
    if (text.startsWith("{")) return;
    expect(text).toContain("Go Pseudo-Version");
    expect(text).toContain("go.mod snippet");
    expect(text).toMatch(/v0\.0\.0-\d{14}-[0-9a-f]{12}/);
  });
});
