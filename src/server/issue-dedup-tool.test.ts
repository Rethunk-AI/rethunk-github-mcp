import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as githubAuth from "./github-auth.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { jaccardSimilarity, normalizeTitle, registerIssueDedupTool } from "./issue-dedup-tool.js";
import { mkError } from "./json.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  pull_request?: { url: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOctokitMock(issues: MockIssue[]) {
  return {
    paginate: async (_method: unknown, _params: unknown) => issues,
    issues: {
      listForRepo: async () => ({ data: issues }),
    },
  } as unknown as ReturnType<typeof githubClient.getOctokit>;
}

function makeIssue(overrides: Partial<MockIssue> & { number: number; title: string }): MockIssue {
  return {
    state: "open",
    html_url: `https://github.com/o/r/issues/${overrides.number}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests for pure similarity functions
// ---------------------------------------------------------------------------

describe("normalizeTitle", () => {
  test("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Bug: Server Crash!")).toBe("bug server crash");
  });

  test("collapses whitespace", () => {
    expect(normalizeTitle("  extra   spaces  ")).toBe("extra spaces");
  });

  test("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

describe("jaccardSimilarity", () => {
  test("identical strings produce score 1", () => {
    expect(jaccardSimilarity("foo bar baz", "foo bar baz")).toBe(1);
  });

  test("completely different strings produce score 0", () => {
    expect(jaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  test("partial overlap produces value between 0 and 1", () => {
    const score = jaccardSimilarity("server crash on startup", "server crash in production");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test("both empty strings produce score 1", () => {
    expect(jaccardSimilarity("", "")).toBe(1);
  });

  test("one empty string produces score 0", () => {
    expect(jaccardSimilarity("something", "")).toBe(0);
    expect(jaccardSimilarity("", "something")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for the tool
// ---------------------------------------------------------------------------

describe("issue_dedup tool", () => {
  const run = captureTool(registerIssueDedupTool);
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    resetAuthCache();
  });

  afterEach(() => {
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
    resetAuthCache();
  });

  // (a) Finds a near-duplicate above threshold — ranked, score present
  test("finds near-duplicate above threshold with score present", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([
        makeIssue({ number: 1, title: "Server crashes on startup" }),
        makeIssue({ number: 2, title: "Unrelated issue about docs" }),
      ]),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        title: "Server crash on startup",
        threshold: 0.3,
        format: "json",
      }),
    ) as {
      candidateTitle: string;
      scanned: number;
      matches: { number: number; score: number; exactMatch: boolean }[];
    };

    expect(parsed.candidateTitle).toBe("Server crash on startup");
    expect(parsed.scanned).toBe(2);
    // The similar issue should be ranked first
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0]?.number).toBe(1);
    expect(typeof parsed.matches[0]?.score).toBe("number");
    expect(parsed.matches[0]?.score).toBeGreaterThanOrEqual(0.3);
    // Verify sorted desc by score
    for (let i = 1; i < parsed.matches.length; i++) {
      expect(parsed.matches[i - 1]?.score).toBeGreaterThanOrEqual(parsed.matches[i]?.score);
    }

    spy.mockRestore();
  });

  // (b) Exact title match flagged exactMatch:true score 1
  test("exact title match sets exactMatch:true and score 1", async () => {
    const exactTitle = "Server crash on startup";
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([makeIssue({ number: 5, title: exactTitle })]),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        title: exactTitle,
        threshold: 0.0,
        format: "json",
      }),
    ) as {
      matches: { number: number; score: number; exactMatch: boolean }[];
    };

    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]?.number).toBe(5);
    expect(parsed.matches[0]?.score).toBe(1);
    expect(parsed.matches[0]?.exactMatch).toBe(true);

    spy.mockRestore();
  });

  // (c) PRs filtered out — item with pull_request field must not appear in results
  test("filters out pull requests from results", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([
        makeIssue({ number: 10, title: "Real issue that matches" }),
        // This is a PR — has pull_request field
        {
          number: 11,
          title: "Real issue that matches",
          state: "open",
          html_url: "https://github.com/o/r/pull/11",
          pull_request: { url: "https://api.github.com/repos/o/r/pulls/11" },
        },
      ]),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        title: "Real issue that matches",
        threshold: 0.0,
        format: "json",
      }),
    ) as {
      scanned: number;
      matches: { number: number }[];
    };

    // PR should be excluded from scanned count and matches
    expect(parsed.scanned).toBe(1);
    const matchNumbers = parsed.matches.map((m) => m.number);
    expect(matchNumbers).not.toContain(11);
    expect(matchNumbers).toContain(10);

    spy.mockRestore();
  });

  // (d) No matches above threshold → empty matches array
  test("returns empty matches when nothing meets threshold", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([makeIssue({ number: 20, title: "Completely unrelated different thing" })]),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        title: "Authentication login bug",
        threshold: 0.9,
        format: "json",
      }),
    ) as {
      matches: unknown[];
    };

    expect(parsed.matches).toEqual([]);

    spy.mockRestore();
  });

  // (e) Auth missing returns error envelope
  test("returns error envelope when auth is missing", async () => {
    const authSpy = spyOn(githubAuth, "gateAuth").mockReturnValue({
      ok: false,
      envelope: mkError("AUTH_MISSING", "No GitHub credential available.", {
        suggestedFix: "Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
      }),
    });

    const text = await run({
      owner: "o",
      repo: "r",
      title: "Some issue",
      format: "json",
    });

    const parsed = JSON.parse(text) as { error?: { code: string; message: string } };
    expect(parsed.error).toBeDefined();
    expect(parsed.error?.code).toBe("AUTH_MISSING");

    authSpy.mockRestore();
  });

  // Additional: markdown format produces expected output shape
  test("markdown format renders ranked list", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([makeIssue({ number: 42, title: "Server crash on startup" })]),
    );

    const text = await run({
      owner: "o",
      repo: "r",
      title: "Server crash on startup",
      threshold: 0.0,
      format: "markdown",
    });

    expect(typeof text).toBe("string");
    expect(text).toContain("#42");
    expect(text).toContain("Server crash on startup");
    expect(text).toContain("score:");

    spy.mockRestore();
  });
});
