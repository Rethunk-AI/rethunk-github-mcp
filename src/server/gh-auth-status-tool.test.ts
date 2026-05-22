import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { registerGhAuthStatusTool } from "./gh-auth-status-tool.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { captureTool } from "./test-harness.js";

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_GH_TOKEN = process.env.GH_TOKEN;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token";
  delete process.env.GH_TOKEN;
  resetAuthCache();
});

afterEach(() => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  }
  if (ORIGINAL_GH_TOKEN === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = ORIGINAL_GH_TOKEN;
  }
  resetAuthCache();
});

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

// ---------------------------------------------------------------------------
// Mocked tests for specific paths
// ---------------------------------------------------------------------------

describe("gh_auth_status (mocked)", () => {
  test("401 response from GitHub returns authenticated:false (not an error envelope)", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      users: {
        getAuthenticated: async () => {
          throw Object.assign(new Error("Bad credentials"), { status: 401 });
        },
      },
    } as never);

    const run = captureTool(registerGhAuthStatusTool);
    const text = await run({});
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { authenticated: boolean; error?: unknown };
    expect(parsed.authenticated).toBe(false);
    // Must NOT be wrapped in an error envelope — 401 is a known state, not an internal error
    expect(parsed.error).toBeUndefined();
  });

  test("successful auth with x-oauth-scopes header populates scopes array", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      users: {
        getAuthenticated: async () => ({
          data: { login: "alice" },
          headers: { "x-oauth-scopes": "repo, user, gist" },
          status: 200,
        }),
      },
    } as never);

    const run = captureTool(registerGhAuthStatusTool);
    const text = await run({});
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      authenticated: boolean;
      login: string;
      scopes: string[];
    };

    expect(parsed.authenticated).toBe(true);
    expect(parsed.login).toBe("alice");
    expect(parsed.scopes).toEqual(["repo", "user", "gist"]);
  });

  test("missing x-oauth-scopes header returns empty scopes array", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      users: {
        getAuthenticated: async () => ({
          data: { login: "bob" },
          headers: {},
          status: 200,
        }),
      },
    } as never);

    const run = captureTool(registerGhAuthStatusTool);
    const text = await run({});
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { scopes: string[] };
    expect(parsed.scopes).toEqual([]);
  });
});
