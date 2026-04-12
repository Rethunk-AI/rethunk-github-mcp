import { describe, expect, test } from "bun:test";

import { asyncPool } from "./github-client.js";

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
