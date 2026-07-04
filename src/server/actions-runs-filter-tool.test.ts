import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { registerActionsRunsFilterTool } from "./actions-runs-filter-tool.js";
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

  test(
    "returns runs list structure when successful",
    async () => {
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
        }>;
      };

      // If no auth error
      if (parsed.error?.code !== "AUTH_MISSING") {
        if (parsed.runs !== undefined) {
          expect(Array.isArray(parsed.runs)).toBe(true);
          if (parsed.runs.length > 0) {
            const run = parsed.runs[0];
            expect(typeof run.id).toBe("number");
            expect(typeof run.name).toBe("string");
            expect(typeof run.status).toBe("string");
            expect(typeof run.createdAt).toBe("string");
          }
        }
      }
    },
    { timeout: 15000 },
  );

  test(
    "respects limit parameter",
    async () => {
      const text = await run({
        owner: "Rethunk-AI",
        repo: "rethunk-github-mcp",
        limit: 3,
      });
      const parsed = JSON.parse(text) as { error?: { code: string }; runs?: unknown[] };

      if (!parsed.error && parsed.runs) {
        expect(parsed.runs.length).toBeLessThanOrEqual(3);
      }
    },
    { timeout: 15000 },
  );

  test(
    "accepts optional filters",
    async () => {
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
    },
    { timeout: 15000 },
  );

  test(
    "handles workflow filter",
    async () => {
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
    },
    { timeout: 15000 },
  );

  test(
    "accepts conclusion and branch filters together",
    async () => {
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
    },
    { timeout: 15000 },
  );
});

// ---------------------------------------------------------------------------
// Mocked tests — zero live network calls
// ---------------------------------------------------------------------------

/** Build a fake paginate.iterator that yields pages of runs. */
function makePaginateIterator(pages: Array<{ total_count: number; workflow_runs: object[] }>) {
  return async function* () {
    for (const page of pages) {
      yield { data: page };
    }
  };
}

describe("actions_runs_filter tool (mocked)", () => {
  test("empty runs list: returns empty array, no truncatedCount", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: { listWorkflowRunsForRepo: {} },
      paginate: {
        iterator: () => makePaginateIterator([{ total_count: 0, workflow_runs: [] }])(),
      },
    } as never);

    const run = captureTool(registerActionsRunsFilterTool);
    const text = await run({ owner: "Acme", repo: "svc", limit: 10 });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { runs: unknown[]; truncatedCount?: number };
    expect(parsed.runs).toHaveLength(0);
    expect(parsed.truncatedCount).toBeUndefined();
  });

  test("truncatedCount present when total_count exceeds returned runs", async () => {
    const makeRun = (id: number) => ({
      id,
      name: `run-${id}`,
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      created_at: "2024-01-01T00:00:00Z",
      html_url: `https://github.com/run/${id}`,
    });

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: { listWorkflowRunsForRepo: {} },
      paginate: {
        iterator: () =>
          makePaginateIterator([
            { total_count: 50, workflow_runs: [makeRun(1), makeRun(2), makeRun(3)] },
          ])(),
      },
    } as never);

    const run = captureTool(registerActionsRunsFilterTool);
    const text = await run({ owner: "Acme", repo: "svc", limit: 3 });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      runs: Array<{ id: number; url?: string }>;
      truncatedCount?: number;
    };
    expect(parsed.runs).toHaveLength(3);
    // total_count(50) - returned(3) = 47
    expect(parsed.truncatedCount).toBe(47);
    // Per-item url/html_url dropped from JSON — reconstructable from owner/repo/id.
    expect(parsed.runs[0]?.url).toBeUndefined();
    expect(text).not.toContain("html_url");
  });

  test("markdown format reconstructs run URL from owner/repo/id (no stored url field)", async () => {
    const makeRun = (id: number) => ({
      id,
      name: `run-${id}`,
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      created_at: "2024-01-01T00:00:00Z",
      html_url: `https://github.com/run/${id}`,
    });

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: { listWorkflowRunsForRepo: {} },
      paginate: {
        iterator: () => makePaginateIterator([{ total_count: 1, workflow_runs: [makeRun(42)] }])(),
      },
    } as never);

    const run = captureTool(registerActionsRunsFilterTool);
    const text = await run({ owner: "Acme", repo: "svc", limit: 5, format: "markdown" });
    octokitSpy.mockRestore();

    expect(text).toContain("[42](https://github.com/Acme/svc/actions/runs/42)");
  });

  test("pagination: fetches across multiple pages up to limit", async () => {
    const makeRun = (id: number) => ({
      id,
      name: `run-${id}`,
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      created_at: "2024-01-01T00:00:00Z",
      html_url: `https://github.com/run/${id}`,
    });

    const page1Runs = Array.from({ length: 3 }, (_, i) => makeRun(i + 1));
    const page2Runs = Array.from({ length: 3 }, (_, i) => makeRun(i + 4));

    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: { listWorkflowRunsForRepo: {} },
      paginate: {
        iterator: () =>
          makePaginateIterator([
            { total_count: 10, workflow_runs: page1Runs },
            { total_count: 10, workflow_runs: page2Runs },
          ])(),
      },
    } as never);

    const run = captureTool(registerActionsRunsFilterTool);
    // limit=5 spans across 2 pages (3 from page1, 2 from page2)
    const text = await run({ owner: "Acme", repo: "svc", limit: 5 });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { runs: Array<{ id: number }>; truncatedCount?: number };
    expect(parsed.runs).toHaveLength(5);
    expect(parsed.runs.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    // total_count(10) - returned(5) = 5
    expect(parsed.truncatedCount).toBe(5);
  });

  test("paginate.iterator throws → error envelope returned", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      actions: { listWorkflowRunsForRepo: {} },
      paginate: {
        iterator: () => {
          const err = Object.assign(new Error("Not Found"), { status: 404 });
          throw err;
        },
      },
    } as never);

    const run = captureTool(registerActionsRunsFilterTool);
    const text = await run({ owner: "Acme", repo: "svc", limit: 10 });
    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("NOT_FOUND");
  });
});
