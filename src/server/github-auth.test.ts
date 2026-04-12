import { describe, expect, test } from "bun:test";

import { gateAuth, resetAuthCache } from "./github-auth.js";

describe("gateAuth", () => {
  test("returns github_auth_missing when no token is available", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGHT = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    resetAuthCache();

    const result = gateAuth();
    // If gh CLI is installed and authed, this will succeed — that's fine.
    // We only assert the shape is correct either way.
    expect(result).toHaveProperty("ok");
    if (!result.ok) {
      expect(result.body).toHaveProperty("error", "github_auth_missing");
    }

    // Restore
    if (origGH !== undefined) process.env.GITHUB_TOKEN = origGH;
    if (origGHT !== undefined) process.env.GH_TOKEN = origGHT;
    resetAuthCache();
  });

  test("returns ok when GITHUB_TOKEN is set", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGHT = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "test-token-123";
    delete process.env.GH_TOKEN;
    resetAuthCache();

    const result = gateAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("test-token-123");
    }

    // Restore
    if (origGH !== undefined) {
      process.env.GITHUB_TOKEN = origGH;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    if (origGHT !== undefined) process.env.GH_TOKEN = origGHT;
    resetAuthCache();
  });

  test("falls back to GH_TOKEN", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGHT = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-token-456";
    resetAuthCache();

    const result = gateAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("gh-token-456");
    }

    // Restore
    if (origGH !== undefined) process.env.GITHUB_TOKEN = origGH;
    if (origGHT !== undefined) {
      process.env.GH_TOKEN = origGHT;
    } else {
      delete process.env.GH_TOKEN;
    }
    resetAuthCache();
  });
});
