import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerBranchProtectionTool } from "./branch-protection-tool.js";
import * as githubAuth from "./github-auth.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { mkError } from "./json.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeFullProtection() {
  return {
    data: {
      required_status_checks: { strict: true, contexts: ["ci/build", "ci/test"] },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
      },
      enforce_admins: { enabled: true },
      required_linear_history: { enabled: false },
      allow_force_pushes: { enabled: false },
      required_signatures: { enabled: true },
      restrictions: {
        users: [{ login: "alice" }, { login: "bob" }],
        teams: [{ slug: "core-team" }],
      },
    },
  };
}

function makeOctokitMock(opts: {
  getBranchProtection?: (params: { branch: string }) => Promise<{ data: unknown }>;
  getRepo?: () => Promise<{ data: { default_branch: string } }>;
}) {
  return {
    repos: {
      getBranchProtection:
        opts.getBranchProtection ??
        (async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }),
      get: opts.getRepo ?? (async () => ({ data: { default_branch: "main" } })),
    },
  } as unknown as ReturnType<typeof githubClient.getOctokit>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("branch_protection_status tool", () => {
  const run = captureTool(registerBranchProtectionTool);
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

  test("(a) protected branch returns full protection shape", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        getBranchProtection: async () => makeFullProtection() as { data: unknown },
        getRepo: async () => ({ data: { default_branch: "main" } }),
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r", branch: "main" })) as Record<
      string,
      unknown
    >;

    expect(parsed.protected).toBe(true);
    expect(parsed.branch).toBe("main");
    expect((parsed.requiredStatusChecks as { strict: boolean; contexts: string[] }).strict).toBe(
      true,
    );
    expect(
      (parsed.requiredStatusChecks as { strict: boolean; contexts: string[] }).contexts,
    ).toContain("ci/build");
    expect((parsed.requiredReviews as { count: number }).count).toBe(2);
    expect((parsed.requiredReviews as { dismissStaleReviews: boolean }).dismissStaleReviews).toBe(
      true,
    );
    expect(
      (parsed.requiredReviews as { requireCodeOwnerReviews: boolean }).requireCodeOwnerReviews,
    ).toBe(true);
    expect(parsed.enforceAdmins).toBe(true);
    expect(parsed.requiredSignatures).toBe(true);
    expect(parsed.allowForcePushes).toBe(false);
    expect((parsed.restrictions as { users: string[]; teams: string[] }).users).toContain("alice");
    expect((parsed.restrictions as { users: string[]; teams: string[] }).teams).toContain(
      "core-team",
    );

    spy.mockRestore();
  });

  test("(b) 404 from getBranchProtection returns {protected: false} — not an error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        getBranchProtection: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
        getRepo: async () => ({ data: { default_branch: "main" } }),
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r", branch: "feature" })) as Record<
      string,
      unknown
    >;

    expect(parsed.protected).toBe(false);
    expect(parsed.branch).toBe("feature");
    expect(parsed.error).toBeUndefined();

    spy.mockRestore();
  });

  test("(c) default branch resolved when branch omitted", async () => {
    let capturedBranch: string | undefined;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        getBranchProtection: async (params) => {
          capturedBranch = params.branch;
          return makeFullProtection() as { data: unknown };
        },
        getRepo: async () => ({ data: { default_branch: "trunk" } }),
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as Record<string, unknown>;

    // Branch should have been resolved from repos.get (trunk) not a hardcoded default
    expect(capturedBranch).toBe("trunk");
    expect(parsed.branch).toBe("trunk");
    expect(parsed.protected).toBe(true);

    spy.mockRestore();
  });

  test("(d) repo 404 (not branch protection 404) surfaces as NOT_FOUND error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        // repos.get 404s — repo doesn't exist
        getRepo: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
        getBranchProtection: async () => makeFullProtection() as { data: unknown },
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "nonexistent" })) as {
      error?: { code: string };
    };

    expect(parsed.error).toBeDefined();
    expect(parsed.error?.code).toBe("NOT_FOUND");

    spy.mockRestore();
  });

  test("(e) auth missing returns AUTH_MISSING error", async () => {
    const authSpy = spyOn(githubAuth, "gateAuth").mockReturnValue({
      ok: false,
      envelope: mkError("AUTH_MISSING", "No GitHub token found."),
    });

    const parsed = JSON.parse(await run({ owner: "o", repo: "r", branch: "main" })) as {
      error?: { code: string };
    };

    expect(parsed.error?.code).toBe("AUTH_MISSING");

    authSpy.mockRestore();
  });
});
