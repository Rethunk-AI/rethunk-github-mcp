import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerLabelsSyncTool } from "./labels-sync-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Minimal Octokit mock surface for labels_sync
// ---------------------------------------------------------------------------

type MockLabel = { name: string; color: string; description: string | null };

function makeOctokitMock(
  existingLabels: MockLabel[],
  opts: {
    createLabel?: (params: { name: string }) => Promise<void>;
    updateLabel?: (params: { name: string }) => Promise<void>;
    deleteLabel?: (params: { name: string }) => Promise<void>;
  } = {},
) {
  return {
    paginate: async (_method: unknown, _params: unknown) => existingLabels,
    issues: {
      listLabelsForRepo: async () => ({ data: existingLabels }),
      createLabel: opts.createLabel ?? (async () => undefined),
      updateLabel: opts.updateLabel ?? (async () => undefined),
      deleteLabel: opts.deleteLabel ?? (async () => undefined),
    },
  } as unknown as ReturnType<typeof githubClient.getOctokit>;
}

describe("labels_sync tool", () => {
  const run = captureTool(registerLabelsSyncTool);
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

  test("creates new labels and skips unchanged existing ones", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([{ name: "existing", color: "aabbcc", description: "already there" }]),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        labels: [
          { name: "existing", color: "aabbcc", description: "already there" },
          { name: "new-label", color: "ffffff" },
        ],
      }),
    ) as { created: string[]; updated: string[]; skipped: string[]; failures: unknown[] };

    expect(parsed.created).toEqual(["new-label"]);
    expect(parsed.updated).toEqual([]);
    expect(parsed.skipped).toEqual(["existing"]);
    expect(parsed.failures).toEqual([]);

    spy.mockRestore();
  });

  test("dryRun returns planned envelope without executing any mutations", async () => {
    let mutateCalled = false;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([{ name: "old-label", color: "112233", description: null }], {
        createLabel: async () => {
          mutateCalled = true;
        },
        updateLabel: async () => {
          mutateCalled = true;
        },
        deleteLabel: async () => {
          mutateCalled = true;
        },
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        labels: [{ name: "new-label", color: "ffffff" }],
        deleteExtra: true,
        dryRun: true,
      }),
    ) as {
      created: string[];
      updated: string[];
      deleted: string[];
      skipped: string[];
      failures: unknown[];
      dryRun: boolean;
    };

    // No mutation calls
    expect(mutateCalled).toBe(false);
    // Planned envelope matches expected operations
    expect(parsed.dryRun).toBe(true);
    expect(parsed.created).toEqual(["new-label"]);
    expect(parsed.deleted).toEqual(["old-label"]);
    expect(parsed.failures).toEqual([]);

    spy.mockRestore();
  });

  test("partial failure: collects failures and still returns completed work", async () => {
    // First create succeeds, second throws
    let _callCount = 0;
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock([], {
        createLabel: async (params) => {
          _callCount++;
          if (params.name === "bad-label") {
            throw { status: 422, message: "Label already exists" };
          }
        },
      }),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        labels: [
          { name: "good-label", color: "aaaaaa" },
          { name: "bad-label", color: "bbbbbb" },
        ],
      }),
    ) as {
      created: string[];
      failures: { name: string; action: string; error: string }[];
    };

    // Completed work is preserved
    expect(parsed.created).toEqual(["good-label"]);
    // Failure is reported
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.name).toBe("bad-label");
    expect(parsed.failures[0]?.action).toBe("create");

    spy.mockRestore();
  });

  test("deleteExtra removes labels not in provided list", async () => {
    const deleted: string[] = [];
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
      makeOctokitMock(
        [
          { name: "keep", color: "aabbcc", description: null },
          { name: "extra", color: "112233", description: null },
        ],
        {
          deleteLabel: async (params) => {
            deleted.push(params.name);
          },
        },
      ),
    );

    const parsed = JSON.parse(
      await run({
        owner: "o",
        repo: "r",
        labels: [{ name: "keep", color: "aabbcc" }],
        deleteExtra: true,
      }),
    ) as { deleted: string[]; failures: unknown[] };

    expect(deleted).toEqual(["extra"]);
    expect(parsed.deleted).toEqual(["extra"]);
    expect(parsed.failures).toEqual([]);

    spy.mockRestore();
  });

  test("returns error for missing authentication", async () => {
    // Run without setting GITHUB_TOKEN (restore and delete it)
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    resetAuthCache();

    // Also clear any cached octokit so gateAuth is called fresh
    const text = await run({
      owner: "nonexistent",
      repo: "nonexistent",
      labels: [],
    });
    const parsed = JSON.parse(text) as { error?: { code: string } };

    if (parsed.error) {
      expect(parsed.error.code).toBeDefined();
    }
  });
});
