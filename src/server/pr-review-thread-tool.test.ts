import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as githubAuth from "./github-auth.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerPrReviewThreadTool } from "./pr-review-thread-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token";
  resetAuthCache();
});

afterEach(() => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  }
  resetAuthCache();
});

function makeThreadNodes() {
  return [
    {
      id: "T_001",
      isResolved: false,
      isOutdated: false,
      path: "src/index.ts",
      line: 10,
      comments: {
        nodes: [{ author: { login: "alice" }, body: "Please add types here." }],
      },
    },
    {
      id: "T_002",
      isResolved: true,
      isOutdated: false,
      path: "src/utils.ts",
      line: 25,
      comments: {
        nodes: [{ author: { login: "bob" }, body: "Good catch, fixed." }],
      },
    },
  ];
}

function makeListResponse(nodes = makeThreadNodes(), hasNextPage = false) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          totalCount: nodes.length,
          pageInfo: { hasNextPage },
          nodes,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pr_review_thread_ops", () => {
  const run = captureTool(registerPrReviewThreadTool);

  // (a) action=list returns compact threads
  test("list returns compact threads with author and bodySnippet", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValueOnce(
      makeListResponse() as never,
    );

    const text = await run({ owner: "Rethunk-AI", repo: "test-repo", prNumber: 1, action: "list" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      threads: Array<{
        id: string;
        path: string;
        line: number | null;
        isResolved: boolean;
        isOutdated: boolean;
        author: string | null;
        bodySnippet: string;
      }>;
      truncatedCount?: number;
    };

    expect(parsed.threads).toHaveLength(2);

    const first = parsed.threads[0];
    expect(first?.id).toBe("T_001");
    expect(first?.path).toBe("src/index.ts");
    expect(first?.line).toBe(10);
    expect(first?.isResolved).toBe(false);
    expect(first?.isOutdated).toBe(false);
    expect(first?.author).toBe("alice");
    expect(first?.bodySnippet).toBe("Please add types here.");

    const second = parsed.threads[1];
    expect(second?.id).toBe("T_002");
    expect(second?.isResolved).toBe(true);
    expect(second?.author).toBe("bob");

    expect(parsed.truncatedCount).toBeUndefined();
  });

  test("list includes truncatedCount when pageInfo.hasNextPage is true", async () => {
    // 3 total but only 2 nodes returned; hasNextPage=true
    const nodes = makeThreadNodes();
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: 3,
            pageInfo: { hasNextPage: true },
            nodes,
          },
        },
      },
    } as never);

    const text = await run({ owner: "Rethunk-AI", repo: "test-repo", prNumber: 1, action: "list" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as { threads: unknown[]; truncatedCount: number };
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.truncatedCount).toBe(1); // 3 total - 2 returned
  });

  // (b) action=resolve with threadIds mutates and returns resolved ids
  test("resolve with threadIds calls mutation and returns resolved ids", async () => {
    let mutationCallCount = 0;
    const spy = spyOn(githubClient, "graphqlQuery").mockImplementation(
      async (query: string, variables?: Record<string, unknown>) => {
        if (query.includes("resolveReviewThread")) {
          mutationCallCount++;
          return { resolveReviewThread: { thread: { id: variables?.threadId } } } as never;
        }
        return {} as never;
      },
    );

    const text = await run({
      owner: "Rethunk-AI",
      repo: "test-repo",
      prNumber: 42,
      action: "resolve",
      threadIds: ["T_001", "T_002"],
    });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      action: string;
      resolved: string[];
      failures: unknown[];
    };

    expect(mutationCallCount).toBe(2);
    expect(parsed.action).toBe("resolve");
    expect(parsed.resolved).toContain("T_001");
    expect(parsed.resolved).toContain("T_002");
    expect(parsed.failures).toHaveLength(0);
  });

  // (c) resolve with dryRun returns targetThreadIds and performs NO mutation
  test("resolve with dryRun returns targetThreadIds without calling mutation", async () => {
    let mutationCalled = false;
    const spy = spyOn(githubClient, "graphqlQuery").mockImplementation(async (query: string) => {
      if (query.includes("resolveReviewThread") || query.includes("unresolveReviewThread")) {
        mutationCalled = true;
      }
      return {} as never;
    });

    const text = await run({
      owner: "Rethunk-AI",
      repo: "test-repo",
      prNumber: 42,
      action: "resolve",
      threadIds: ["T_001", "T_002"],
      dryRun: true,
    });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      dryRun: boolean;
      action: string;
      targetThreadIds: string[];
    };

    expect(mutationCalled).toBe(false);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.action).toBe("resolve");
    expect(parsed.targetThreadIds).toEqual(["T_001", "T_002"]);
  });

  // (d) partial failure: one thread rejects → appears in failures[], others in resolved[]
  test("partial failure: failed thread appears in failures, others in resolved", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockImplementation(
      async (_query: string, variables?: Record<string, unknown>) => {
        if (variables?.threadId === "T_BAD") {
          throw new Error("Thread not found");
        }
        return { resolveReviewThread: { thread: { id: variables?.threadId } } } as never;
      },
    );

    const text = await run({
      owner: "Rethunk-AI",
      repo: "test-repo",
      prNumber: 42,
      action: "resolve",
      threadIds: ["T_001", "T_BAD", "T_003"],
    });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      action: string;
      resolved: string[];
      failures: Array<{ threadId: string; error: string }>;
    };

    expect(parsed.action).toBe("resolve");
    expect(parsed.resolved).toContain("T_001");
    expect(parsed.resolved).toContain("T_003");
    expect(parsed.resolved).not.toContain("T_BAD");

    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.threadId).toBe("T_BAD");
    expect(parsed.failures[0]?.error).toContain("Thread not found");
  });

  // (e) resolveOutdated=true resolves ONLY unresolved+outdated threads
  test("resolveOutdated:true resolves only unresolved+outdated threads, not resolved or non-outdated", async () => {
    const resolvedMutationIds: string[] = [];

    const mixedNodes = [
      {
        id: "T_RESOLVED_OUTDATED",
        isResolved: true,
        isOutdated: true,
        path: "src/a.ts",
        line: 1,
        comments: { nodes: [] },
      },
      {
        id: "T_UNRESOLVED_OUTDATED",
        isResolved: false,
        isOutdated: true,
        path: "src/b.ts",
        line: 2,
        comments: { nodes: [] },
      },
      {
        id: "T_UNRESOLVED_NOT_OUTDATED",
        isResolved: false,
        isOutdated: false,
        path: "src/c.ts",
        line: 3,
        comments: { nodes: [] },
      },
    ];

    const spy = spyOn(githubClient, "graphqlQuery").mockImplementation(
      async (query: string, variables?: Record<string, unknown>) => {
        if (query.includes("resolveReviewThread")) {
          resolvedMutationIds.push(variables?.threadId as string);
          return { resolveReviewThread: { thread: { id: variables?.threadId } } } as never;
        }
        // list query
        return makeListResponse(mixedNodes) as never;
      },
    );

    const text = await run({
      owner: "Rethunk-AI",
      repo: "test-repo",
      prNumber: 99,
      action: "resolve",
      resolveOutdated: true,
    });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      action: string;
      resolved: string[];
      failures: unknown[];
    };

    // Mutation was called for exactly the unresolved+outdated thread
    expect(resolvedMutationIds).toEqual(["T_UNRESOLVED_OUTDATED"]);

    // Response reflects exactly those IDs
    expect(parsed.action).toBe("resolve");
    expect(parsed.resolved).toEqual(["T_UNRESOLVED_OUTDATED"]);
    expect(parsed.failures).toHaveLength(0);
  });

  // (f) auth missing returns error envelope
  test("auth missing returns AUTH_MISSING error", async () => {
    const authSpy = spyOn(githubAuth, "gateAuth").mockReturnValue({
      ok: false,
      envelope: {
        code: "AUTH_MISSING",
        message: "No GitHub credential available.",
        retryable: false,
        suggestedFix: "Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
      },
    });

    const text = await run({
      owner: "Rethunk-AI",
      repo: "test-repo",
      prNumber: 1,
      action: "list",
    });
    authSpy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("AUTH_MISSING");
  });
});
