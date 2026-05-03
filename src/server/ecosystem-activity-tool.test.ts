import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { registerEcosystemActivityTool } from "./ecosystem-activity-tool.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
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

describe("ecosystem_activity with mocked GraphQL", () => {
  test("aggregates remote repo commits in JSON format", async () => {
    const sampleHistory = {
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              nodes: [
                {
                  oid: `${"c".repeat(39)}f`,
                  messageHeadline: "fix crash (#77)",
                  committedDate: "2024-02-02T02:02:02Z",
                  author: { name: "Pat", user: { login: "pat" } },
                },
              ],
            },
          },
        },
      },
    };

    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(sampleHistory as never);
    const run = captureTool(registerEcosystemActivityTool);
    const text = await run({
      repos: [{ owner: "Acme", repo: "svc" }],
      since: "2020-01-01T00:00:00Z",
      format: "json",
    });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      commits: Array<{ owner: string; repo: string; author: string; pr: unknown }>;
      summary: { totalCommits: number };
    };
    expect(parsed.summary.totalCommits).toBe(1);
    expect(parsed.commits[0]?.owner).toBe("Acme");
    expect(parsed.commits[0]?.repo).toBe("svc");
    expect(parsed.commits[0]?.author).toBe("pat");
    expect(parsed.commits[0]?.pr).toEqual({ number: 77 });
  });

  test("renders markdown table and filters by grep", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              nodes: [
                {
                  oid: `${"d".repeat(39)}e`,
                  messageHeadline: "noise",
                  committedDate: "2024-02-03T00:00:00Z",
                  author: { name: "OnlyName", user: null },
                },
                {
                  oid: `${"e".repeat(39)}d`,
                  messageHeadline: "feat important",
                  committedDate: "2024-02-04T00:00:00Z",
                  author: { name: "", user: undefined },
                },
              ],
            },
          },
        },
      },
    } as never);

    const run = captureTool(registerEcosystemActivityTool);
    const text = await run({
      repos: [{ owner: "O", repo: "p" }],
      since: "2020-01-01T00:00:00Z",
      grep: "feat",
      format: "markdown",
    });
    spy.mockRestore();

    expect(text).toContain("| Date | Repo |");
    expect(text).toContain("feat important");
    expect(text).not.toContain("noise");
  });

  test("dedupes commits when multiple paths return the same SHA", async () => {
    const node = {
      oid: `${"f".repeat(39)}a`,
      messageHeadline: "dup",
      committedDate: "2024-02-05T00:00:00Z",
      author: { name: "x", user: { login: "x" } },
    };
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {
        defaultBranchRef: { target: { history: { nodes: [node] } } },
      },
    } as never);

    const run = captureTool(registerEcosystemActivityTool);
    const text = await run({
      repos: [{ owner: "O", repo: "p" }],
      since: "2020-01-01T00:00:00Z",
      paths: ["a.ts", "b.ts"],
      format: "json",
    });
    expect(spy.mock.calls.length).toBe(2);
    spy.mockRestore();

    const parsed = JSON.parse(text) as { summary: { totalCommits: number } };
    expect(parsed.summary.totalCommits).toBe(1);
  });
});
