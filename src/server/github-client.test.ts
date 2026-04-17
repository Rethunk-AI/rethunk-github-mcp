import { describe, expect, test } from "bun:test";

import {
  asyncPool,
  classifyError,
  parallelApi,
  parseGitHubRemoteUrl,
  resolveLocalRepoRemote,
} from "./github-client.js";

describe("asyncPool", () => {
  test("processes all items and returns results", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await asyncPool(items, 2, async (n) => n * 10);
    // Results may arrive in any order due to concurrency
    expect(results.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  test("respects concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await asyncPool(items, 2, async (n) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return n;
    });

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  test("handles empty input", async () => {
    const results = await asyncPool([], 4, async (n: number) => n);
    expect(results).toEqual([]);
  });

  test("propagates errors", async () => {
    const items = [1, 2, 3];
    await expect(
      asyncPool(items, 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("concurrency 1 processes sequentially", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await asyncPool(items, 1, async (n) => {
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return n;
    });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("parallelApi", () => {
  test("returns results for all items", async () => {
    const results = await parallelApi([1, 2, 3], async (n) => n * 2);
    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  test("handles empty input", async () => {
    const results = await parallelApi([], async (n: number) => n);
    expect(results).toEqual([]);
  });
});

describe("parseGitHubRemoteUrl", () => {
  test("parses SSH with .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH without .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses HTTPS with .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses HTTPS without .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("returns undefined for non-GitHub URL", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseGitHubRemoteUrl("")).toBeUndefined();
  });
});

describe("resolveLocalRepoRemote", () => {
  test("resolves current repo origin", () => {
    // bun test runs from the repo root, which is a git clone with a GitHub
    // origin — exercises the full git + parse path.
    const result = resolveLocalRepoRemote(process.cwd());
    expect(result).toEqual({ owner: "Rethunk-AI", repo: "rethunk-github-mcp" });
  });

  test("returns undefined for non-git path", () => {
    expect(resolveLocalRepoRemote("/tmp")).toBeUndefined();
  });
});

describe("classifyError", () => {
  test("maps 401 to AUTH_FAILED", () => {
    const env = classifyError({ status: 401, message: "Bad credentials" });
    expect(env.code).toBe("AUTH_FAILED");
    expect(env.retryable).toBe(false);
    expect(env.suggestedFix).toBeDefined();
  });

  test("maps 403 with ratelimit-remaining=0 to RATE_LIMITED (retryable)", () => {
    const env = classifyError({
      status: 403,
      message: "API rate limit exceeded",
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1700000000",
        },
      },
    });
    expect(env.code).toBe("RATE_LIMITED");
    expect(env.retryable).toBe(true);
    expect(env.suggestedFix).toContain("Rate limit resets");
  });

  test("maps other 403 to PERMISSION_DENIED", () => {
    const env = classifyError({ status: 403, message: "forbidden" });
    expect(env.code).toBe("PERMISSION_DENIED");
    expect(env.retryable).toBe(false);
  });

  test("maps 404 to NOT_FOUND", () => {
    const env = classifyError({ status: 404, message: "Not Found" });
    expect(env.code).toBe("NOT_FOUND");
  });

  test("maps 422 to VALIDATION", () => {
    const env = classifyError({ status: 422, message: "Unprocessable" });
    expect(env.code).toBe("VALIDATION");
  });

  test("maps 5xx to UPSTREAM_FAILURE (retryable)", () => {
    const env = classifyError({ status: 502, message: "Bad Gateway" });
    expect(env.code).toBe("UPSTREAM_FAILURE");
    expect(env.retryable).toBe(true);
  });

  test("maps GraphQL error array to UPSTREAM_FAILURE", () => {
    const env = classifyError({
      message: "graphql failed",
      errors: [{ message: "Field 'foo' doesn't exist" }],
    });
    expect(env.code).toBe("UPSTREAM_FAILURE");
    expect(env.message).toBe("Field 'foo' doesn't exist");
    expect(env.retryable).toBe(true);
  });

  test("falls through to INTERNAL for unrecognized shape", () => {
    const env = classifyError(new Error("weird"));
    expect(env.code).toBe("INTERNAL");
    expect(env.message).toBe("weird");
  });

  test("handles non-Error values", () => {
    const env = classifyError("stringified");
    expect(env.code).toBe("INTERNAL");
    expect(env.message).toBe("unknown");
  });
});
