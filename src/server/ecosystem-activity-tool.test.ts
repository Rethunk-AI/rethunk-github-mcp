import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { registerEcosystemActivityTool } from "./ecosystem-activity-tool.js";
import { resetAuthCache } from "./github-auth.js";
import { MAX_REPOS_PER_REQUEST } from "./schemas.js";
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

describe("ecosystem_activity tool (captureTool)", () => {
  test("JSON format returns stable result shape for local repo resolution errors", async () => {
    const run = captureTool(registerEcosystemActivityTool);

    const text = await run({
      repos: [{ localPath: "/tmp" }],
      since: "48h",
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      since?: string;
      repos?: Array<{
        owner: string;
        repo: string;
        commitCount: number;
        error?: { code: string; retryable: boolean };
      }>;
      commits?: unknown[];
      summary?: {
        totalCommits: number;
        repoBreakdown: Record<string, number>;
      };
    };

    expect(parsed.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.repos).toEqual([
      {
        owner: "unknown",
        repo: "/tmp",
        commitCount: 0,
        error: expect.objectContaining({
          code: "LOCAL_REPO_NO_REMOTE",
          retryable: false,
        }),
      },
    ]);
    expect(parsed.commits).toEqual([]);
    expect(parsed.summary).toEqual({ totalCommits: 0, repoBreakdown: {} });
  });

  test(`accepts ${MAX_REPOS_PER_REQUEST} repos in one JSON result`, async () => {
    const run = captureTool(registerEcosystemActivityTool);
    const repos = Array.from({ length: MAX_REPOS_PER_REQUEST }, () => ({
      localPath: "/tmp",
    }));

    const text = await run({
      repos,
      since: "48h",
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      repos?: Array<{ error?: { code: string } }>;
      summary?: { totalCommits: number };
    };

    expect(parsed.repos).toHaveLength(MAX_REPOS_PER_REQUEST);
    expect(parsed.repos?.[0]?.error?.code).toBe("LOCAL_REPO_NO_REMOTE");
    expect(parsed.summary?.totalCommits).toBe(0);
  });

  test("markdown format includes empty activity and error sections", async () => {
    const run = captureTool(registerEcosystemActivityTool);

    const text = await run({
      repos: [{ localPath: "/tmp" }],
      since: "48h",
      format: "markdown",
    });

    expect(text).toContain("# Ecosystem Activity");
    expect(text).toContain("*(no commits in range)*");
    expect(text).toContain("## Errors");
    expect(text).toContain("LOCAL_REPO_NO_REMOTE");
  });
});
