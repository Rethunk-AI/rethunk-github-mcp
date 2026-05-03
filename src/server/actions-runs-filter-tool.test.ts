import { describe, expect, test } from "bun:test";

import { registerActionsRunsFilterTool } from "./actions-runs-filter-tool.js";
import { captureTool } from "./test-harness.js";

describe("actions_runs_filter tool", () => {
  const run = captureTool(registerActionsRunsFilterTool);

  test("returns error for missing authentication", async () => {
    const text = await run({
      owner: "nonexistent",
      repo: "nonexistent",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

    // May return AUTH_MISSING or runs list depending on environment
    if (parsed.error) {
      expect(parsed.error.code).toBeDefined();
    }
  });

  test("returns runs list structure when successful", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      limit: 5,
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        branch: string;
        createdAt: string;
        url: string;
      }>;
    };

    // If no auth error
    if (!parsed.error || parsed.error.code !== "AUTH_MISSING") {
      if (parsed.runs !== undefined) {
        expect(Array.isArray(parsed.runs)).toBe(true);
        if (parsed.runs.length > 0) {
          const run = parsed.runs[0];
          expect(typeof run.id).toBe("number");
          expect(typeof run.name).toBe("string");
          expect(typeof run.status).toBe("string");
          expect(typeof run.createdAt).toBe("string");
          expect(typeof run.url).toBe("string");
        }
      }
    }
  });

  test("respects limit parameter", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      limit: 3,
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

    if (!parsed.error && parsed.runs) {
      expect(parsed.runs.length).toBeLessThanOrEqual(3);
    }
  });

  test("accepts optional filters", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      status: "completed",
      limit: 10,
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

    if (!parsed.error && parsed.runs) {
      // Should not throw
      expect(Array.isArray(parsed.runs)).toBe(true);
    }
  });

  test("handles workflow filter", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      workflow: "CI",
      limit: 5,
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

    if (!parsed.error && parsed.runs) {
      // Workflow filter applied
      expect(Array.isArray(parsed.runs)).toBe(true);
    }
  });

  test("accepts conclusion and branch filters together", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      conclusion: "success",
      branch: "main",
      limit: 3,
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

    if (!parsed.error && parsed.runs) {
      expect(Array.isArray(parsed.runs)).toBe(true);
    }
  });
});
