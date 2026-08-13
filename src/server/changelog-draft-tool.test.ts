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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    expect(text).toContain("## Acme/svc");

    // Sections must appear in LABEL_ORDER: breaking before feat before fix
    const breakingPos = text.indexOf("#### Breaking");
    const featPos = text.indexOf("#### Feat");
    const fixPos = text.indexOf("#### Fix");

    expect(breakingPos).toBeGreaterThan(-1);
    expect(featPos).toBeGreaterThan(-1);
    expect(fixPos).toBeGreaterThan(-1);
    expect(breakingPos).toBeLessThan(featPos);
    expect(featPos).toBeLessThan(fixPos);
  });

  test("JSON format returns structured repos[] with owner/repo on every entry", async () => {
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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{
        owner: string;
        repo: string;
        base: string;
        head: string;
        entries: Array<{ sha7: string; pr?: { labels: string[] } }>;
      }>;
    };

    expect(parsed.repos).toHaveLength(1);
    const [entry] = parsed.repos;
    if (!entry) throw new Error("Expected one repo entry");
    expect(entry.owner).toBe("Acme");
    expect(entry.repo).toBe("svc");
    expect(entry.base).toBe("v1.0.0");
    expect(entry.head).toBe("main");
    expect(entry.entries).toHaveLength(1);
    expect(entry.entries[0]?.pr?.labels).toContain("chore");
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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ entries: unknown[]; truncatedCount?: number }>;
    };
    expect(parsed.repos[0]?.entries).toHaveLength(0);
    expect(parsed.repos[0]?.truncatedCount).toBeUndefined();
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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      maxCommits: 2,
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ entries: unknown[]; truncatedCount?: number }>;
    };
    expect(parsed.repos[0]?.entries).toHaveLength(2);
    // total_commits(10) - returned(2) = 8
    expect(parsed.repos[0]?.truncatedCount).toBe(8);
  });

  test("compareCommitsWithBasehead throws → per-repo error, batch does not fail", async () => {
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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();

    const parsed = JSON.parse(text) as { repos: Array<{ error?: { code: string } }> };
    expect(parsed.repos[0]?.error?.code).toBe("NOT_FOUND");
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
      repos: [{ owner: "Acme", repo: "svc" }],
      base: "v1.0.0",
      head: "main",
      format: "markdown",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const fixPos = text.indexOf("#### Fix");
    const otherPos = text.indexOf("#### Other");

    expect(fixPos).toBeGreaterThan(-1);
    expect(otherPos).toBeGreaterThan(-1);
    // "Other" must come after "Fix"
    expect(otherPos).toBeGreaterThan(fixPos);
  });

  test("multi-repo success: independent per-repo entries, both keep owner/repo", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async (params: { repo: string }) =>
          params.repo === "svc"
            ? makeCompareResponse([{ sha: "a".repeat(40), message: "fix a", prNumber: 1 }])
            : makeCompareResponse([{ sha: "b".repeat(40), message: "add b", prNumber: 2 }]),
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockImplementation(
      async (_query: string, variables?: Record<string, unknown>) => {
        const repo = (variables as { repo: string }).repo;
        return repo === "svc"
          ? makePRMetadataResponse([{ number: 1, title: "Fix A", labels: ["fix"] }])
          : makePRMetadataResponse([{ number: 2, title: "Add B", labels: ["feat"] }]);
      },
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      repos: [
        { owner: "Acme", repo: "svc" },
        { owner: "Acme", repo: "other" },
      ],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ owner: string; repo: string; entries: Array<{ pr?: { labels: string[] } }> }>;
    };

    expect(parsed.repos).toHaveLength(2);
    const svc = parsed.repos.find((r) => r.repo === "svc");
    const other = parsed.repos.find((r) => r.repo === "other");
    if (!svc || !other) throw new Error("Expected both svc and other entries");
    expect(svc.entries[0]?.pr?.labels).toContain("fix");
    expect(other.entries[0]?.pr?.labels).toContain("feat");
  });

  test("per-repo error isolation: one failing repo does not fail the batch", async () => {
    const octokitSpy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        compareCommitsWithBasehead: async (params: { repo: string }) => {
          if (params.repo === "broken") {
            const err = Object.assign(new Error("Not Found"), { status: 404 });
            throw err;
          }
          return makeCompareResponse([{ sha: "a".repeat(40), message: "fix a", prNumber: 1 }]);
        },
      },
    } as never);

    const graphqlSpy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makePRMetadataResponse([{ number: 1, title: "Fix A", labels: ["fix"] }]) as never,
    );

    const run = captureTool(registerChangelogDraftTool);
    const text = await run({
      repos: [
        { owner: "Acme", repo: "svc" },
        { owner: "Acme", repo: "broken" },
      ],
      base: "v1.0.0",
      head: "main",
      format: "json",
    });

    octokitSpy.mockRestore();
    graphqlSpy.mockRestore();

    const parsed = JSON.parse(text) as {
      repos: Array<{ repo: string; entries?: unknown[]; error?: { code: string } }>;
    };

    expect(parsed.repos).toHaveLength(2);
    const svc = parsed.repos.find((r) => r.repo === "svc");
    const broken = parsed.repos.find((r) => r.repo === "broken");
    if (!svc || !broken) throw new Error("Expected both svc and broken entries");
    expect(svc.entries).toHaveLength(1);
    expect(svc.error).toBeUndefined();
    expect(broken.error?.code).toBe("NOT_FOUND");
  });

  test("no repos and no MCP workspace root → VALIDATION envelope", async () => {
    const run = captureTool(registerChangelogDraftTool);
    const text = await run({ format: "json" });

    const parsed = JSON.parse(text) as { error?: { code: string } };
    expect(parsed.error?.code).toBe("VALIDATION");
  });

  test("workspace-root fallback: omitted repos uses the active MCP root", async () => {
    // No `repos` passed, but a workspace root is present — the tool must fall back
    // to it (proven by the localPath reaching resolveLocalRepoRemote and failing
    // with LOCAL_REPO_NO_REMOTE, rather than the "no target" VALIDATION error).
    const run = captureTool(registerChangelogDraftTool, "changelog_draft", { format: "json" }, [
      "file:///tmp",
    ]);
    const text = await run;

    const parsed = JSON.parse(text) as { repos?: Array<{ error?: { code: string } }> };
    expect(parsed.repos?.[0]?.error?.code).toBe("LOCAL_REPO_NO_REMOTE");
  });
});
