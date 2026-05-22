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

/** Full search response with review requests and assigned issues populated */
function makeFullSearchResponse() {
  return {
    authored: {
      nodes: [
        {
          __typename: "PullRequest",
          number: 10,
          title: "Fix regression",
          isDraft: false,
          updatedAt: "2024-04-01T10:00:00Z",
          repository: { nameWithOwner: "Org/repo" },
          author: { login: "bob" },
          reviewDecision: "CHANGES_REQUESTED",
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }],
          },
        },
      ],
    },
    reviewRequested: {
      nodes: [
        {
          __typename: "PullRequest",
          number: 20,
          title: "Add tests",
          isDraft: false,
          updatedAt: "2024-04-02T09:00:00Z",
          repository: { nameWithOwner: "Org/other" },
          author: { login: "carol" },
          reviewDecision: null,
          commits: { nodes: [] },
        },
      ],
    },
    assignedIssues: {
      nodes: [
        {
          __typename: "Issue",
          number: 99,
          title: "Bug: crash on startup",
          updatedAt: "2024-04-03T08:00:00Z",
          repository: { nameWithOwner: "Org/issues" },
          labels: { nodes: [{ name: "bug" }, { name: "critical" }] },
        },
      ],
    },
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

  test("viewer login failure returns error (lines 77-81)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockRejectedValueOnce(
      new Error("network error") as never,
    );

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error).toBeDefined();
  });

  test("reviewRequests and assignedIssues are mapped (lines 138-153, 192-196, 204-209)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "bob" } } as never)
      .mockResolvedValueOnce(makeFullSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      username: string;
      authoredPrs: Array<{ ci: string; reviewDecision: string | null }>;
      reviewRequests: Array<{ repo: string; number: number; author: string }>;
      assignedIssues: Array<{ repo: string; number: number; labels: string[] }>;
    };

    expect(parsed.reviewRequests).toHaveLength(1);
    expect(parsed.reviewRequests[0]?.repo).toBe("Org/other");
    expect(parsed.reviewRequests[0]?.number).toBe(20);
    expect(parsed.reviewRequests[0]?.author).toBe("carol");

    expect(parsed.assignedIssues).toHaveLength(1);
    expect(parsed.assignedIssues[0]?.repo).toBe("Org/issues");
    expect(parsed.assignedIssues[0]?.number).toBe(99);
    expect(parsed.assignedIssues[0]?.labels).toEqual(["bug", "critical"]);
  });

  test("blockedOnMe=true filters authored PRs to actionable items (lines 158-161)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "bob" } } as never)
      .mockResolvedValueOnce(makeFullSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json", blockedOnMe: true });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      authoredPrs: Array<{ number: number; ci: string; reviewDecision: string | null }>;
    };
    // The authored PR has CI:FAILURE and CHANGES_REQUESTED — should pass the blockedOnMe filter
    expect(parsed.authoredPrs).toHaveLength(1);
    expect(parsed.authoredPrs[0]?.number).toBe(10);
  });

  test("blockedOnMe=true excludes PRs with passing CI and approved review", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "alice" } } as never)
      .mockResolvedValueOnce(makeSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json", blockedOnMe: true });
    spy.mockRestore();

    const parsed = JSON.parse(text) as { authoredPrs: unknown[] };
    // The authored PR in makeSearchResponse has SUCCESS + APPROVED — filtered out by blockedOnMe
    expect(parsed.authoredPrs).toHaveLength(0);
  });

  test("markdown: empty authored PRs section renders 'No open PRs.' (line 175)", async () => {
    const emptyResponse = {
      authored: { nodes: [] },
      reviewRequested: { nodes: [] },
      assignedIssues: { nodes: [] },
    };

    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "alice" } } as never)
      .mockResolvedValueOnce(emptyResponse as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "markdown" });
    spy.mockRestore();

    expect(text).toContain("No open PRs.");
    expect(text).toContain("No review requests.");
    expect(text).toContain("No assigned issues.");
  });

  test("markdown: review requests and assigned issues with data render inline (lines 192-196, 204-209)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "bob" } } as never)
      .mockResolvedValueOnce(makeFullSearchResponse() as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "markdown" });
    spy.mockRestore();

    // Review requests section
    expect(text).toContain("## Review Requests (1)");
    expect(text).toContain("Add tests");
    expect(text).toContain("by carol");

    // Assigned issues section with labels
    expect(text).toContain("## Assigned Issues (1)");
    expect(text).toContain("Bug: crash on startup");
    expect(text).toContain("(bug, critical)");
  });

  test("search query failure returns error (lines 214-218)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "alice" } } as never)
      .mockRejectedValueOnce(new Error("GraphQL error") as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error).toBeDefined();
  });

  test("markdown: CI:fail and CI:? labels render correctly for non-SUCCESS states", async () => {
    const failureResponse = {
      authored: {
        nodes: [
          {
            __typename: "PullRequest",
            number: 77,
            title: "Failing PR",
            isDraft: true,
            updatedAt: "2024-05-01T10:00:00Z",
            repository: { nameWithOwner: "Org/repo" },
            author: { login: "dave" },
            reviewDecision: null,
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }],
            },
          },
          {
            __typename: "PullRequest",
            number: 78,
            title: "No CI PR",
            isDraft: false,
            updatedAt: "2024-05-01T10:00:00Z",
            repository: { nameWithOwner: "Org/repo" },
            author: { login: "dave" },
            reviewDecision: "CHANGES_REQUESTED",
            commits: { nodes: [] },
          },
        ],
      },
      reviewRequested: { nodes: [] },
      assignedIssues: { nodes: [] },
    };

    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "dave" } } as never)
      .mockResolvedValueOnce(failureResponse as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "markdown" });
    spy.mockRestore();

    expect(text).toContain("CI:fail");
    expect(text).toContain("CI:?");
    expect(text).toContain("[DRAFT]");
    // reviewDecision null → "pending"
    expect(text).toContain("pending");
    // reviewDecision CHANGES_REQUESTED → "changes requested"
    expect(text).toContain("changes requested");
  });

  test("assigned issue with no labels renders without parentheses", async () => {
    const noLabelResponse = {
      authored: { nodes: [] },
      reviewRequested: { nodes: [] },
      assignedIssues: {
        nodes: [
          {
            __typename: "Issue",
            number: 42,
            title: "Unlabeled issue",
            updatedAt: "2024-04-01T00:00:00Z",
            repository: { nameWithOwner: "Org/repo" },
            labels: { nodes: [] },
          },
        ],
      },
    };

    const spy = spyOn(githubClient, "graphqlQuery")
      .mockResolvedValueOnce({ viewer: { login: "eve" } } as never)
      .mockResolvedValueOnce(noLabelResponse as never);

    const run = captureTool(registerMyWorkTool);
    const text = await run({ format: "markdown" });
    spy.mockRestore();

    expect(text).toContain("Unlabeled issue");
    // No label parenthetical
    expect(text).not.toContain("()");
  });
});
