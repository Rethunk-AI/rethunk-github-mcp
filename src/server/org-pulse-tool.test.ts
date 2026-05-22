import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerOrgPulseTool } from "./org-pulse-tool.js";
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

function makeOrgPulseResponse(overrides?: {
  ciState?: string;
  prUpdatedAt?: string;
  prDraft?: boolean;
}) {
  const updatedAt = overrides?.prUpdatedAt ?? "2020-01-01T00:00:00Z"; // very stale
  return {
    organization: {
      repositories: {
        nodes: [
          {
            name: "svc",
            nameWithOwner: "Acme/svc",
            pushedAt: "2024-03-01T00:00:00Z",
            isArchived: false,
            defaultBranchRef: {
              name: "main",
              target: {
                statusCheckRollup: overrides?.ciState ? { state: overrides.ciState } : null,
              },
            },
            pullRequests: {
              totalCount: 1,
              nodes: [
                {
                  number: 10,
                  title: "Old PR",
                  updatedAt,
                  isDraft: overrides?.prDraft ?? false,
                  author: { login: "alice" },
                  reviewDecision: null,
                  reviewRequests: { totalCount: 1 },
                },
              ],
            },
            issues: { totalCount: 2 },
          },
        ],
      },
    },
  };
}

describe("org_pulse tool (mocked)", () => {
  test("happy path: detects stale PR and returns summary (JSON)", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makeOrgPulseResponse() as never,
    );
    const run = captureTool(registerOrgPulseTool);
    const text = await run({ org: "Acme", staleDays: 1, format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      org: string;
      scannedRepos: number;
      summary: { stalePRs: number; unreviewedPRs: number };
      attention: Array<{ repo: string; stalePRs: unknown[]; unreviewedPRs: unknown[] }>;
    };

    expect(parsed.org).toBe("Acme");
    expect(parsed.scannedRepos).toBe(1);
    expect(parsed.summary.stalePRs).toBeGreaterThan(0);
    expect(parsed.attention).toHaveLength(1);
    expect(parsed.attention[0]?.repo).toBe("Acme/svc");
    expect(parsed.attention[0]?.stalePRs).toHaveLength(1);
  });

  test("draft PRs are not counted as stale", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makeOrgPulseResponse({ prDraft: true }) as never,
    );
    const run = captureTool(registerOrgPulseTool);
    const text = await run({ org: "Acme", staleDays: 1, format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as {
      summary: { stalePRs: number };
      attention: unknown[];
    };
    // Draft PR should not appear as stale
    expect(parsed.summary.stalePRs).toBe(0);
  });

  test("NOT_FOUND error when org is inaccessible", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue({
      organization: null,
    } as never);
    const run = captureTool(registerOrgPulseTool);
    const text = await run({ org: "nonexistent", format: "json" });
    spy.mockRestore();

    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  test("markdown format includes Needs Attention section", async () => {
    const spy = spyOn(githubClient, "graphqlQuery").mockResolvedValue(
      makeOrgPulseResponse() as never,
    );
    const run = captureTool(registerOrgPulseTool);
    const text = await run({ org: "Acme", staleDays: 1, format: "markdown" });
    spy.mockRestore();

    expect(text).toContain("# Org Pulse: Acme");
    expect(text).toContain("## Needs Attention");
    expect(text).toContain("Acme/svc");
  });
});
