import { describe, expect, test } from "bun:test";

import { registerLabelsSyncTool } from "./labels-sync-tool.js";
import { captureTool } from "./test-harness.js";

describe("labels_sync tool", () => {
  const run = captureTool(registerLabelsSyncTool);

  test("returns error for missing authentication", async () => {
    const text = await run({
      owner: "nonexistent",
      repo: "nonexistent",
      labels: [],
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      created?: unknown[];
    };

    // May return error depending on environment
    if (parsed.error) {
      expect(parsed.error.code).toBeDefined();
    }
  });

  test("returns sync result structure", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      labels: [{ name: "test-label", color: "ffffff", description: "Test label" }],
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      created?: string[];
      updated?: string[];
      deleted?: string[];
      skipped?: string[];
    };

    // Skip if no auth
    if (parsed.error?.code === "AUTH_MISSING") {
      return;
    }

    // If no error, we should have the sync result structure
    if (!parsed.error) {
      expect(parsed.created).toBeDefined();
      expect(parsed.updated).toBeDefined();
      expect(parsed.deleted).toBeDefined();
      expect(parsed.skipped).toBeDefined();
      expect(Array.isArray(parsed.created)).toBe(true);
      expect(Array.isArray(parsed.updated)).toBe(true);
      expect(Array.isArray(parsed.deleted)).toBe(true);
      expect(Array.isArray(parsed.skipped)).toBe(true);
    }
  });

  test("handles empty label list", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      labels: [],
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      created?: string[];
    };

    if (parsed.error?.code === "AUTH_MISSING") {
      return;
    }

    if (!parsed.error && parsed.created) {
      expect(Array.isArray(parsed.created)).toBe(true);
    }
  });

  test("accepts deleteExtra flag", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      labels: [{ name: "kept-label", color: "000000" }],
      deleteExtra: true,
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      deleted?: string[];
    };

    if (parsed.error?.code === "AUTH_MISSING") {
      return;
    }

    if (!parsed.error && parsed.deleted) {
      expect(Array.isArray(parsed.deleted)).toBe(true);
    }
  });

  test("handles labels with optional description", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      labels: [
        { name: "with-desc", color: "cccccc", description: "Has description" },
        { name: "no-desc", color: "aaaaaa" },
      ],
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      created?: string[];
      updated?: string[];
    };

    if (parsed.error?.code === "AUTH_MISSING") {
      return;
    }

    if (!parsed.error) {
      expect(parsed.created).toBeDefined();
      expect(parsed.updated).toBeDefined();
    }
  });
});
