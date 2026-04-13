import { describe, expect, test } from "bun:test";

import {
  asyncPool,
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
    // This repo has a GitHub origin — exercises the git + parse path
    const result = resolveLocalRepoRemote(
      "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp",
    );
    expect(result).toEqual({ owner: "Rethunk-AI", repo: "rethunk-github-mcp" });
  });

  test("returns undefined for non-git path", () => {
    expect(resolveLocalRepoRemote("/tmp")).toBeUndefined();
  });
});
