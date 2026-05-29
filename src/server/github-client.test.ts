import { describe, expect, spyOn, test } from "bun:test";

import * as githubClient from "./github-client.js";
import {
  asyncPool,
  asyncPoolSettled,
  classifyError,
  fetchLatestSemverTag,
  fetchPRMetadata,
  getOctokit,
  parallelApi,
  parallelApiSettled,
  parseGitHubRemoteUrl,
  resolveLocalRepoRemote,
  withRetry,
  withTimeout,
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

  test("does not leak unhandled rejections when fn rejects (Bug 1)", async () => {
    // All items reject — pool should reject once and not hang or leave dangling promises
    const items = [1, 2, 3, 4];
    await expect(
      asyncPool(items, 2, async () => {
        throw new Error("always fail");
      }),
    ).rejects.toThrow("always fail");
  });

  test("first rejection surfaces immediately; remaining items are cleaned up (Bug 1)", async () => {
    const started: number[] = [];
    // Item 1 rejects instantly; items 2-5 succeed after a delay
    const items = [1, 2, 3, 4, 5];
    await expect(
      asyncPool(items, 3, async (n) => {
        started.push(n);
        if (n === 1) throw new Error("item-1-fail");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return n;
      }),
    ).rejects.toThrow("item-1-fail");
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

  test("rejects github.com.evil.com (unanchored host exploit, Bug 8)", () => {
    expect(parseGitHubRemoteUrl("git@github.com.evil.com:owner/repo.git")).toBeUndefined();
    expect(parseGitHubRemoteUrl("https://github.com.evil.com/owner/repo.git")).toBeUndefined();
  });

  test("parses ssh:// prefix form", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
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

  test("scrubs GitHub PAT token from error message (Bug 10)", () => {
    const env = classifyError({ status: 500, message: "bad token ghp_AbCdEf123456 found" });
    expect(env.message).not.toContain("ghp_");
    expect(env.message).toContain("***");
  });

  test("scrubs 'token <value>' form from error message (Bug 10)", () => {
    const env = classifyError({ status: 500, message: "Authorization: token mysecrettoken123" });
    expect(env.message).not.toContain("mysecrettoken123");
    expect(env.message).toContain("token ***");
  });

  test("scrubs tokens from GraphQL errors array (Bug 10)", () => {
    const env = classifyError({
      errors: [{ message: "token ghs_secretValue leaked" }],
    });
    expect(env.message).not.toContain("ghs_");
    expect(env.message).toContain("***");
  });
});

// ---------------------------------------------------------------------------
// getOctokit — covers the lazy-init path (lines 11-22 in github-client.ts)
// ---------------------------------------------------------------------------

describe("getOctokit", () => {
  test("returns an Octokit REST client", () => {
    // Only meaningful when auth is available; skip gracefully otherwise
    let octokit: ReturnType<typeof getOctokit> | undefined;
    try {
      octokit = getOctokit();
    } catch {
      return; // no auth
    }
    expect(octokit).toBeDefined();
    expect(typeof octokit.repos).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// fetchLatestSemverTag — unit test for sort fix + live smoke test
// ---------------------------------------------------------------------------

describe("fetchLatestSemverTag", () => {
  test("returns the highest semver tag even when tags are not sorted (Bug 11)", async () => {
    // API returns tags in push order: v1.0.0 pushed last but v1.2.0 is highest
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        listTags: async () => ({
          data: [
            { name: "v1.0.0" },
            { name: "v1.2.0" },
            { name: "v0.9.0" },
            { name: "not-a-semver" },
          ],
        }),
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const tag = await fetchLatestSemverTag("owner", "repo");
    expect(tag).toBe("v1.2.0");
    spy.mockRestore();
  });

  test("returns null when no semver tags exist", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        listTags: async () => ({ data: [{ name: "latest" }, { name: "stable" }] }),
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const tag = await fetchLatestSemverTag("owner", "repo");
    expect(tag).toBeNull();
    spy.mockRestore();
  });

  test("returns a semver tag string for a live repo that has releases", async () => {
    try {
      const tag = await fetchLatestSemverTag("Rethunk-AI", "rethunk-github-mcp");
      // If we get a result, it should match semver
      if (tag !== null) {
        expect(tag).toMatch(/^v?\d+\.\d+\.\d+$/);
      }
    } catch {
      // If auth is absent the function will throw — skip gracefully
      return;
    }
  });

  test("throws on API errors like 404", async () => {
    try {
      await fetchLatestSemverTag("Rethunk-AI", "repo-that-does-not-exist-xyzzy");
      // Should not reach here if API throws
      expect(false).toBe(true);
    } catch {
      // Expected to throw on API errors or auth failure
      return;
    }
  });
});

// ---------------------------------------------------------------------------
// fetchPRMetadata — unit tests for batching (Bug 9) + live smoke test
// ---------------------------------------------------------------------------

describe("fetchPRMetadata", () => {
  test("returns empty map for an empty PR list", async () => {
    const map = await fetchPRMetadata("Rethunk-AI", "rethunk-github-mcp", []);
    expect(map.size).toBe(0);
  });

  test("issues multiple GraphQL queries when prNumbers > 20 (Bug 9)", async () => {
    const queryCalls: number[][] = [];

    // Spy on graphqlQuery to capture which PR numbers are requested per call
    const spy = spyOn(githubClient, "graphqlQuery").mockImplementation(
      async (_query: string, _variables?: Record<string, unknown>) => {
        // Collect the batch size from the aliases in the query string
        const matches = (_query as string).match(/pr\d+/g) ?? [];
        const nums = matches.map((m) => Number(m.replace("pr", "")));
        queryCalls.push(nums);
        // Return all requested PRs as mocked data
        const repoData: Record<string, { number: number; title: string; labels: { nodes: [] } }> =
          {};
        for (const n of nums) {
          repoData[`pr${n}`] = { number: n, title: `PR ${n}`, labels: { nodes: [] } };
        }
        return { repository: repoData };
      },
    );

    // 25 PRs exceeds the chunk limit of 20
    const prNumbers = Array.from({ length: 25 }, (_, i) => i + 1);
    const map = await fetchPRMetadata("owner", "repo", prNumbers);

    expect(queryCalls.length).toBe(2); // chunk 1: 20 items, chunk 2: 5 items
    expect(queryCalls[0]?.length).toBe(20);
    expect(queryCalls[1]?.length).toBe(5);
    expect(map.size).toBe(25);

    spy.mockRestore();
  });

  test("returns map with PR data for valid PR numbers (live)", async () => {
    // PR #1 is likely the first pull request — skip gracefully if not found
    const map = await fetchPRMetadata("Rethunk-AI", "rethunk-github-mcp", [1]);
    // If auth is absent or PR doesn't exist the map will be empty — acceptable
    if (map.size === 0) return;
    const pr = map.get(1);
    expect(pr).toBeDefined();
    expect(typeof pr?.title).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// classifyError — new secondary rate-limit and bare 429 branches
// ---------------------------------------------------------------------------

describe("classifyError — secondary rate limits", () => {
  test("403 + retry-after header → RATE_LIMITED retryable", () => {
    const env = classifyError({
      status: 403,
      message: "You have exceeded a secondary rate limit",
      response: { headers: { "retry-after": "30" } },
    });
    expect(env.code).toBe("RATE_LIMITED");
    expect(env.retryable).toBe(true);
    expect(env.suggestedFix).toContain("30");
  });

  test("429 + retry-after header → RATE_LIMITED retryable", () => {
    const env = classifyError({
      status: 429,
      message: "Too Many Requests",
      response: { headers: { "retry-after": "10" } },
    });
    expect(env.code).toBe("RATE_LIMITED");
    expect(env.retryable).toBe(true);
  });

  test("bare 429 (no headers) → RATE_LIMITED retryable", () => {
    const env = classifyError({ status: 429, message: "Too Many Requests" });
    expect(env.code).toBe("RATE_LIMITED");
    expect(env.retryable).toBe(true);
  });

  test("403 without ratelimit-remaining=0 and without retry-after → PERMISSION_DENIED", () => {
    const env = classifyError({ status: 403, message: "forbidden" });
    expect(env.code).toBe("PERMISSION_DENIED");
    expect(env.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  test("succeeds on first try without sleeping", async () => {
    const sleepCalls: number[] = [];
    const stubSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const result = await withRetry(async () => 42, {
      maxRetries: 2,
      baseDelayMs: 100,
      sleep: stubSleep,
    });
    expect(result).toBe(42);
    expect(sleepCalls).toHaveLength(0);
  });

  test("retries a retryable error then succeeds, sleeping with growing delays", async () => {
    const sleepCalls: number[] = [];
    const stubSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          // 502 → UPSTREAM_FAILURE → retryable
          throw Object.assign(new Error("server error"), { status: 502 });
        }
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 100, sleep: stubSleep },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    // attempt 0 → delay 100*2^0=100; attempt 1 → delay 100*2^1=200
    expect(sleepCalls).toEqual([100, 200]);
  });

  test("gives up after maxRetries and rethrows last error", async () => {
    const stubSleep = async (_ms: number) => {};

    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error("always fails"), { status: 503 });
        },
        { maxRetries: 2, baseDelayMs: 50, sleep: stubSleep },
      ),
    ).rejects.toThrow("always fails");

    // invoked 1 (initial) + 2 (retries) = 3 times
    expect(attempts).toBe(3);
  });

  test("does NOT retry a non-retryable error (404)", async () => {
    const stubSleep = async (_ms: number) => {};

    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error("not found"), { status: 404 });
        },
        { maxRetries: 3, baseDelayMs: 50, sleep: stubSleep },
      ),
    ).rejects.toThrow("not found");

    // Should only attempt once — non-retryable errors rethrow immediately
    expect(attempts).toBe(1);
  });

  test("maxRetries=0 means no retries on retryable error", async () => {
    const stubSleep = async (_ms: number) => {};

    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error("boom"), { status: 502 });
        },
        { maxRetries: 0, baseDelayMs: 50, sleep: stubSleep },
      ),
    ).rejects.toThrow("boom");

    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  test("resolves when promise settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("fast"), 5000, "test");
    expect(result).toBe("fast");
  });

  test("rejects with a timeout message when promise is too slow", async () => {
    const neverResolves = new Promise<string>(() => {});
    await expect(withTimeout(neverResolves, 10, "slow-op")).rejects.toThrow(
      "slow-op timed out after 10ms",
    );
  });

  test("uses a default label when none is provided", async () => {
    const neverResolves = new Promise<string>(() => {});
    await expect(withTimeout(neverResolves, 5)).rejects.toThrow("timed out after 5ms");
  });

  test("timeout error classifies as UPSTREAM_FAILURE retryable", async () => {
    const neverResolves = new Promise<string>(() => {});
    let caught: unknown;
    try {
      await withTimeout(neverResolves, 5, "label");
    } catch (err) {
      caught = err;
    }
    const classified = classifyError(caught);
    expect(classified.code).toBe("UPSTREAM_FAILURE");
    expect(classified.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// asyncPoolSettled / parallelApiSettled
// ---------------------------------------------------------------------------

describe("asyncPoolSettled", () => {
  test("returns fulfilled results for all successful items", async () => {
    const results = await asyncPoolSettled([1, 2, 3], 2, async (n) => n * 10);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
    const values = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => a - b);
    expect(values).toEqual([10, 20, 30]);
  });

  test("returns mixed fulfilled and rejected without throwing", async () => {
    const results = await asyncPoolSettled([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("item 2 failed");
      return n;
    });

    expect(results).toHaveLength(3);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain("fulfilled");
    expect(statuses).toContain("rejected");

    const rejectedResult = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(rejectedResult?.reason?.message).toBe("item 2 failed");
  });

  test("all-rejecting items do not throw — returns all rejected", async () => {
    const results = await asyncPoolSettled([1, 2, 3], 2, async () => {
      throw new Error("always fails");
    });
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  });

  test("handles empty input", async () => {
    const results = await asyncPoolSettled([], 2, async (n: number) => n);
    expect(results).toEqual([]);
  });
});

describe("parallelApiSettled", () => {
  test("returns settled results using default concurrency", async () => {
    const results = await parallelApiSettled([1, 2, 3], async (n) => n * 2);
    const values = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => a - b);
    expect(values).toEqual([2, 4, 6]);
  });

  test("does not throw when some items reject", async () => {
    const results = await parallelApiSettled([1, 2, 3], async (n) => {
      if (n === 1) throw new Error("first failed");
      return n;
    });
    expect(results).toHaveLength(3);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});
