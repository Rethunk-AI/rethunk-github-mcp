import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { registerChangelogDraftTool } from "./changelog-draft-tool.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompareResponse(
  commits: Array<{ sha: string; message: string; prNumber?: number }>,
  totalCommitsOverride?: number,
) {
  return {
    data: {
      total_commits: totalCommitsOverride ?? commits.length,
      commits: commits.map((c) => ({
        sha: c.sha,
        commit: {
          message: c.prNumber ? `${c.message} (#${c.prNumber})` : c.message,
          author: { name: "Alice", date: "2024-03-01T00:00:00Z" },
        },
        author: { login: "alice" },
      })),
      files: [],
    },
  };
}

/**
 * Build a PR metadata response that matches the `fetchPRMetadata` query shape.
 * fetchPRMetadata uses per-PR field aliases on repository: `pr${number}: pullRequest(...)`.
 */
function makePRMetadataResponse(prs: Array<{ number: number; title: string; labels: string[] }>) {
  const repo: Record<string, unknown> = {};
  for (const pr of prs) {
    repo[`pr${pr.number}`] = {
      number: pr.number,
      title: pr.title,
      labels: { nodes: pr.labels.map((name) => ({ name })) },
    };
  }
  return { repository: repo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("changelog_draft tool (mocked)", () => {
  test("happy path: groups entries by LABEL_ORDER and renders markdown", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () =>
          makeCompareResponse([
            { sha: "a".repeat(40), message: "fix something", prNumber: 1 },
            { sha: "b".repeat(40), message: "add feature", prNumber: 2 },
            { sha: "c".repeat(40), message: "breaking change", prNumber: 3 },
          ]),
      },
    } as never);

    // fetchPRMetadata uses graphqlQuery with pr${n} aliases on repository
    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRMetadataResponse([
        { number: 1, title: "Fix the bug", labels: ["fix"] },
        { number: 2, title: "New feature", labels: ["feat"] },
        { number: 3, title: "Break API", labels: ["breaking"] },
      ]) as never,
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    // Sections must appear in LABEL_ORDER: breaking before feat before fix
    const breakingPos = text.indexOf("### Breaking");
    const featPos = text.indexOf("### Feat");
    const fixPos = text.indexOf("### Fix");

    expect(breakingPos).toBeGreaterThan(-1);
    expect(featPos).toBeGreaterThan(-1);
    expect(fixPos).toBeGreaterThan(-1);
    expect(breakingPos).toBeLessThan(featPos);
    expect(featPos).toBeLessThan(fixPos);
  });

  test("JSON format returns structured entries array", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () =>
          makeCompareResponse([
            { sha: "d".repeat(40), message: "chore: update deps", prNumber: 10 },
          ]),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRMetadataResponse([{ number: 10, title: "Update deps", labels: ["chore"] }]) as never,
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      version: string;
      base: string;
      head: string;
      entries: Array<{ sha7: string; pr?: { labels: string[] } }>;
    };

    expect(parsed.base).toBe("v1.0.0");
    expect(parsed.head).toBe("main");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.pr?.labels).toContain("chore");
  });

  test("empty commits: no entries in JSON output, no truncatedCount", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => makeCompareResponse([]),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      repository: {},
    } as never);

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as { entries: unknown[]; truncatedCount?: number };
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.truncatedCount).toBeUndefined();
  });

  test("truncatedCount emitted when total_commits exceeds maxCommits", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () =>
          // Return 2 commits but signal total_commits = 10
          makeCompareResponse(
            [
              { sha: "a".repeat(40), message: "fix a", prNumber: 1 },
              { sha: "b".repeat(40), message: "fix b", prNumber: 2 },
            ],
            10,
          ),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRMetadataResponse([
        { number: 1, title: "Fix A", labels: ["fix"] },
        { number: 2, title: "Fix B", labels: ["fix"] },
      ]) as never,
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      maxCommits: 2,
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      entries: unknown[];
      truncatedCount?: number;
    };
    expect(parsed.entries).toHaveLength(2);
    // total_commits(10) - returned(2) = 8
    expect(parsed.truncatedCount).toBe(8);
  });

  test("compareCommitsWithBasehead throws → error envelope", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () => {
          const err = Object.assign(new Error("Not Found"), { status: 404 });
          throw err;
        },
      },
    } as never);

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  test("Other label appears last in markdown output", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async () =>
          makeCompareResponse([
            { sha: "e".repeat(40), message: "fix thing", prNumber: 20 },
            { sha: "f".repeat(40), message: "unlabeled commit", prNumber: 21 },
          ]),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRMetadataResponse([
        { number: 20, title: "Fix thing", labels: ["fix"] },
        { number: 21, title: "Unlabeled", labels: [] },
      ]) as never,
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      owner: "Acme",
      repo: "svc",
      base: "v1.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const fixPos = text.indexOf("### Fix");
    const otherPos = text.indexOf("### Other");

    expect(fixPos).toBeGreaterThan(-1);
    expect(otherPos).toBeGreaterThan(-1);
    // "Other" must come after "Fix"
    expect(otherPos).toBeGreaterThan(fixPos);
  });
});
