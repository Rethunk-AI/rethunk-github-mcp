import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerMyWorkTool } from "./my-work-tool.js";
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

function makeSearchResponse() {
  return {
    authored: {
      nodes: [
        {
          __typename: "PullRequest",
          number: 55,
          title: "Add feature X",
          isDraft: false,
          updatedAt: "2024-03-01T12:00:00Z",
          repository: { nameWithOwner: "Acme/svc" },
          author: { login: "alice" },
          reviewDecision: "APPROVED",
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
          },
        },
      ],
    },
    reviewRequested: { nodes: [] },
    assignedIssues: { nodes: [] },
  };
}

describe("my_work tool (mocked)", () => {
  test("happy path: returns authored PRs with CI and review state (JSON)", async () => {
    // First call: viewer login; second call: search results
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "alice" } } as never)
      .mockResolvedValueOnce(makeSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      username: string;
      authoredPrs: Array<{
        repo: string;
        number: number;
        ci: string;
        reviewDecision: string | null;
      }>;
      reviewRequests: unknown[];
      assignedIssues: unknown[];
    };

    expect(parsed.username).toBe("alice");
    expect(parsed.authoredPrs).toHaveLength(1);
    expect(parsed.authoredPrs[0]?.repo).toBe("Acme/svc");
    expect(parsed.authoredPrs[0]?.number).toBe(55);
    expect(parsed.authoredPrs[0]?.ci).toBe("SUCCESS");
    expect(parsed.authoredPrs[0]?.reviewDecision).toBe("APPROVED");
    expect(parsed.reviewRequests).toHaveLength(0);
    expect(parsed.assignedIssues).toHaveLength(0);
  });

  test("explicit username skips viewer query and uses JS-interpolated search string", async () => {
    // Only one graphqlQuery call (no viewer lookup)
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValueOnce(
      makeSearchResponse() as never,
    );

    const run = captureTool(registerMyWorkTool);
    const text = await run({ username: "alice", format: "json" });

    // graphqlQuery called once (not twice) — capture before restore resets the spy state
    const callCount = spy.mock.calls.length;
    // The query string should contain the literal username, not $username
    const queryArg = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();

    expect(callCount).toBe(1);
    expect(queryArg).toContain("author:alice");
    expect(queryArg).not.toContain("$username");

    const parsed = JSON.parse(text) as { username: string };
    expect(parsed.username).toBe("alice");
  });

  test("VALIDATION error for invalid username characters", async () => {
    const run = captureTool(registerMyWorkTool);
    const text = await run({ username: "alice<script>", format: "json" });
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("VALIDATION");
  });

  test("markdown format renders authored PRs section", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "alice" } } as never)
      .mockResolvedValueOnce(makeSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "markdown" });
    spy.mockRestore();

    expect(text).toContain("# My Work (@alice)");
    expect(text).toContain("## Authored PRs");
    expect(text).toContain("Add feature X");
    expect(text).toContain("CI:ok");
  });
});
