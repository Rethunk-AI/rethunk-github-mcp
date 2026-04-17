import { describe, expect, test } from "bun:test";

import {
  errorRespond,
  jsonRespond,
  MCP_JSON_FORMAT_VERSION,
  mkError,
  readMcpServerVersion,
  readPackageVersion,
  spreadDefined,
  spreadWhen,
  truncateLines,
  truncateText,
} from "./json.js";

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

describe("spreadWhen", () => {
  test("returns fields when condition is true", () => {
    const result = { base: 1, ...spreadWhen(true, { extra: 2 }) };
    expect(result).toEqual({ base: 1, extra: 2 });
  });

  test("returns empty object when condition is false", () => {
    const result = { base: 1, ...spreadWhen(false, { extra: 2 }) };
    expect(result).toEqual({ base: 1 });
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
    expect(result).toBe("abc\n... [truncated]");
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
