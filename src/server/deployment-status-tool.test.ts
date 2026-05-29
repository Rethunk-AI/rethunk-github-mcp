import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerDeploymentStatusTool } from "./deployment-status-tool.js";
import * as githubAuth from "./github-auth.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { mkError } from "./json.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeDeployment(overrides: {
  id: number;
  environment: string;
  ref?: string;
  sha?: string;
  creator?: string;
}) {
  return {
    id: overrides.id,
    environment: overrides.environment,
    ref: overrides.ref ?? "main",
    sha: overrides.sha ?? "abcdef1234567890",
    creator: { login: overrides.creator ?? "deployer" },
    created_at: "2026-05-28T10:00:00Z",
    updated_at: "2026-05-28T10:05:00Z",
    url: `https://api.github.com/repos/o/r/deployments/${overrides.id}`,
  };
}

function makeStatus(state: string, targetUrl = "") {
  return { state, target_url: targetUrl };
}

function makeOctokitMock(opts: {
  deployments?: object[];
  statusesByDeploymentId?: Record<number, object[]>;
}) {
  const deployments = opts.deployments ?? [];
  const statuses = opts.statusesByDeploymentId ?? {};

  return {
    repos: {
      listDeployments: async (_params: unknown) => ({ data: deployments }),
      listDeploymentStatuses: async (params: { deployment_id: number }) => ({
        data: statuses[params.deployment_id] ?? [],
      }),
    },
  } as unknown as ReturnType<typeof githubClient.getOctokit>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deployment_status tool", () => {
  const run = captureTool(registerDeploymentStatusTool);
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

  test("(a) deployments with statuses return correct shape and byEnvironment map", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        deployments: [
          makeDeployment({ id: 1, environment: "production", sha: "abcdef1234567890" }),
          makeDeployment({ id: 2, environment: "staging", sha: "1234567890abcdef" }),
        ],
        statusesByDeploymentId: {
          1: [makeStatus("success", "https://prod.example.com")],
          2: [makeStatus("in_progress")],
        },
      }),
    );

    type DeploymentResult = {
      environmentFilter: string | null;
      deployments: Array<{
        id: number;
        environment: string;
        ref: string;
        sha: string;
        state: string;
        creator: string;
        createdAt: string;
        url: string;
      }>;
      byEnvironment: Record<string, string>;
      truncatedCount: number;
    };

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as DeploymentResult;

    expect(parsed.environmentFilter).toBeNull();
    expect(parsed.truncatedCount).toBe(0);
    expect(parsed.deployments).toHaveLength(2);

    const prod = parsed.deployments.find((d) => d.environment === "production");
    expect(prod).toBeDefined();
    expect(prod?.state).toBe("success");
    expect(prod?.sha).toBe("abcdef1"); // sha7 of "abcdef1234567890"
    expect(prod?.url).toBe("https://prod.example.com");
    expect(prod?.creator).toBe("deployer");

    const staging = parsed.deployments.find((d) => d.environment === "staging");
    expect(staging?.state).toBe("in_progress");

    expect(parsed.byEnvironment.production).toBe("success");
    expect(parsed.byEnvironment.staging).toBe("in_progress");

    spy.mockRestore();
  });

  test("(b) environment filter is passed through and reflected in result", async () => {
    let capturedParams: unknown;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        listDeployments: async (params: unknown) => {
          capturedParams = params;
          return {
            data: [makeDeployment({ id: 10, environment: "production" })],
          };
        },
        listDeploymentStatuses: async () => ({ data: [makeStatus("success")] }),
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(await run({ owner: "o", repo: "r", environment: "production" })) as {
      environmentFilter: string | null;
      deployments: object[];
    };

    expect(parsed.environmentFilter).toBe("production");
    expect((capturedParams as { environment?: string }).environment).toBe("production");

    spy.mockRestore();
  });

  test("(c) empty deployment list returns empty shape", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({ deployments: [] }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as {
      deployments: object[];
      byEnvironment: Record<string, string>;
      truncatedCount: number;
    };

    expect(parsed.deployments).toHaveLength(0);
    expect(Object.keys(parsed.byEnvironment)).toHaveLength(0);
    expect(parsed.truncatedCount).toBe(0);

    spy.mockRestore();
  });

  test("(d) deployment with no status entry gets state=unknown", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        deployments: [makeDeployment({ id: 99, environment: "preview" })],
        statusesByDeploymentId: {}, // no statuses
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as {
      deployments: Array<{ state: string }>;
    };

    expect(parsed.deployments[0]?.state).toBe("unknown");

    spy.mockRestore();
  });

  test("(e) auth missing returns AUTH_MISSING error", async () => {
    const authSpy = spyOn(githubAuth, "gateAuth").mockReturnValue({
      ok: false,
      envelope: mkError("AUTH_MISSING", "No GitHub token found."),
    });

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as { error?: { code: string } };

    expect(parsed.error?.code).toBe("AUTH_MISSING");

    authSpy.mockRestore();
  });

  test("(f) byEnvironment reflects latest state when same environment has multiple deployments", async () => {
    // Two production deployments: id=1 (newer) has success, id=2 (older) has failure
    // listDeployments returns newest-first, so id=1 should win
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock({
        deployments: [
          makeDeployment({ id: 1, environment: "production" }),
          makeDeployment({ id: 2, environment: "production" }),
        ],
        statusesByDeploymentId: {
          1: [makeStatus("success")],
          2: [makeStatus("failure")],
        },
      }),
    );

    const parsed = JSON.parse(await run({ owner: "o", repo: "r" })) as {
      byEnvironment: Record<string, string>;
    };

    // First-seen wins (newest-first from API = latest)
    expect(parsed.byEnvironment.production).toBe("success");

    spy.mockRestore();
  });
});
