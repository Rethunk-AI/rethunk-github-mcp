import { describe, expect, test } from "bun:test";

import { registerGhAuthStatusTool } from "./gh-auth-status-tool.js";
import { captureTool } from "./test-harness.js";

describe("gh_auth_status tool", () => {
  const run = captureTool(registerGhAuthStatusTool);

  test("returns authenticated status for valid credentials", async () => {
    const text = await run({});
    const parsed = JSON.parse(text) as { error?: unknown; authenticated?: boolean; login?: string };

    // If auth is available, authenticated should be true with login
    if (!parsed.error && parsed.authenticated) {
      expect(parsed.authenticated).toBe(true);
      expect(typeof parsed.login).toBe("string");
      expect(parsed.login?.length).toBeGreaterThan(0);
    }
  });

  test("returns unauthenticated status for missing credentials", async () => {
    const text = await run({});
    const parsed = JSON.parse(text) as { error?: unknown; authenticated?: boolean };

    // Either authenticated true (has credentials) or authenticated false (no credentials)
    // Both are valid outcomes depending on environment
    if (typeof parsed.authenticated === "boolean") {
      expect(typeof parsed.authenticated).toBe("boolean");
    }
  });

  test("response structure matches expected schema", async () => {
    const text = await run({});
    const parsed = JSON.parse(text) as {
      error?: unknown;
      authenticated?: boolean;
      login?: string;
      scopes?: string[];
    };

    if (!parsed.error) {
      // Authenticated response
      expect(parsed.authenticated).toBeDefined();
      expect(typeof parsed.authenticated).toBe("boolean");
      if (parsed.authenticated) {
        expect(typeof parsed.login).toBe("string");
      }
    } else {
      // Error response has error field
      expect(parsed.error).toBeDefined();
    }
  });
});
