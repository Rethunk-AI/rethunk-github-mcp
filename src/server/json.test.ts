import { describe, expect, test } from "bun:test";

import {
  errorRespond,
  jsonRespond,
  MCP_JSON_FORMAT_VERSION,
  mkError,
  mkLocalRepoNoRemote,
  readMcpServerVersion,
  readPackageVersion,
  spreadDefined,
  truncateLines,
  truncateText,
} from "./json.js";
import { captureTool } from "./test-harness.js";

describe("MCP_JSON_FORMAT_VERSION", () => {
  test("is '2'", () => {
    expect(MCP_JSON_FORMAT_VERSION).toBe("2");
  });
});

describe("readPackageVersion", () => {
  test("returns a semver string from package.json", () => {
    const v = readPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("readMcpServerVersion", () => {
  test("returns major.minor.patch format", () => {
    const v = readMcpServerVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("jsonRespond", () => {
  test("returns minified JSON", () => {
    const result = jsonRespond({ a: 1, b: "two" });
    expect(result).toBe('{"a":1,"b":"two"}');
  });

  test("handles nested objects", () => {
    const result = jsonRespond({ x: { y: [1, 2] } });
    expect(result).toBe('{"x":{"y":[1,2]}}');
  });

  test("handles empty object", () => {
    expect(jsonRespond({})).toBe("{}");
  });
});

describe("spreadDefined", () => {
  test("spreads key when value is defined", () => {
    const result = { a: 1, ...spreadDefined("b", 42) };
    expect(result).toEqual({ a: 1, b: 42 });
  });

  test("spreads nothing when value is undefined", () => {
    const result = { a: 1, ...spreadDefined("b", undefined) };
    expect(result).toEqual({ a: 1 });
  });

  test("spreads falsy values that are not undefined", () => {
    expect({ ...spreadDefined("x", 0) }).toEqual({ x: 0 });
    expect({ ...spreadDefined("x", "") }).toEqual({ x: "" });
    expect({ ...spreadDefined("x", false) }).toEqual({ x: false });
    expect({ ...spreadDefined("x", null) }).toEqual({ x: null });
  });
});

describe("truncateLines", () => {
  test("returns text unchanged when within limit", () => {
    const text = "line1\nline2\nline3";
    expect(truncateLines(text, 5)).toBe(text);
  });

  test("returns text unchanged at exact limit", () => {
    const text = "a\nb\nc";
    expect(truncateLines(text, 3)).toBe(text);
  });

  test("truncates and appends notice when over limit", () => {
    const text = "1\n2\n3\n4\n5";
    const result = truncateLines(text, 2);
    expect(result).toBe("1\n2\n... [3 lines truncated]");
  });

  test("single line over limit keeps first line", () => {
    // 1 line, limit 1 — no truncation
    expect(truncateLines("only", 1)).toBe("only");
  });
});

describe("truncateText", () => {
  test("returns text unchanged when within limit", () => {
    expect(truncateText("short", 100)).toBe("short");
  });

  test("returns text unchanged at exact limit", () => {
    expect(truncateText("12345", 5)).toBe("12345");
  });

  test("truncates and appends notice when over limit", () => {
    const result = truncateText("abcdef", 3);
    expect(result).toBe("abc… [truncated]");
  });
});

describe("mkError", () => {
  test("builds envelope with default retryable=false", () => {
    const e = mkError("NOT_FOUND", "repo gone");
    expect(e).toEqual({ code: "NOT_FOUND", message: "repo gone", retryable: false });
  });

  test("honors retryable=true", () => {
    const e = mkError("RATE_LIMITED", "slow down", { retryable: true });
    expect(e.retryable).toBe(true);
  });

  test("includes suggestedFix when provided", () => {
    const e = mkError("AUTH_MISSING", "no token", {
      suggestedFix: "Set GITHUB_TOKEN or run `gh auth login`.",
    });
    expect(e.suggestedFix).toBe("Set GITHUB_TOKEN or run `gh auth login`.");
  });

  test("omits suggestedFix when undefined", () => {
    const e = mkError("NOT_FOUND", "gone");
    expect("suggestedFix" in e).toBe(false);
  });
});

describe("errorRespond", () => {
  test("wraps envelope under top-level `error` key", () => {
    const out = errorRespond(mkError("NOT_FOUND", "repo gone"));
    expect(out).toBe('{"error":{"code":"NOT_FOUND","message":"repo gone","retryable":false}}');
  });
});

describe("mkLocalRepoNoRemote", () => {
  test("returns envelope with LOCAL_REPO_NO_REMOTE code", () => {
    const e = mkLocalRepoNoRemote("/some/path");
    expect(e.code).toBe("LOCAL_REPO_NO_REMOTE");
  });

  test("includes the supplied path in the message", () => {
    const e = mkLocalRepoNoRemote("/projects/my-repo");
    expect(e.message).toContain("/projects/my-repo");
  });

  test("includes a suggestedFix mentioning `origin`", () => {
    const e = mkLocalRepoNoRemote("/foo");
    expect(e.suggestedFix).toContain("origin");
  });

  test("is not retryable", () => {
    expect(mkLocalRepoNoRemote("/foo").retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureTool — test-harness throw path (lines 83-85)
// ---------------------------------------------------------------------------

describe("captureTool", () => {
  test("throws when the requested tool name is not registered", () => {
    // The register function registers nothing, so "wanted-tool" is never found
    expect(() => captureTool(() => undefined, "wanted-tool")).toThrow(
      'captureTool: no tool captured named "wanted-tool"',
    );
  });

  test("throws with generic message when no toolName given and nothing registered", () => {
    expect(() => captureTool(() => undefined)).toThrow("captureTool: no tool captured");
  });
});
