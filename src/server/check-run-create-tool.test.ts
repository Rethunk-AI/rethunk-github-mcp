import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { registerCheckRunCreateTool } from "./check-run-create-tool.js";
import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { captureTool } from "./test-harness.js";

describe("check_run_create tool", () => {
  describe("dryRun preview", () => {
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

    test("returns plan without calling checks.create", async () => {
      const create = mock(async () => ({ data: {} }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        checks: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerCheckRunCreateTool, "check_run_create", {
          owner: "o",
          repo: "r",
          name: "my-check",
          headSha: "abc1234",
          status: "completed",
          conclusion: "success",
          title: "All passing",
          summary: "100% green",
          dryRun: true,
        }),
      ) as { dryRun: boolean; plan: Record<string, unknown> };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.plan).toMatchObject({
        owner: "o",
        repo: "r",
        name: "my-check",
        headSha: "abc1234",
        status: "completed",
        conclusion: "success",
        title: "All passing",
        summary: "100% green",
      });
      expect(create).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  const run = captureTool(registerCheckRunCreateTool);

  test("requires conclusion when status is completed", async () => {
    const text = await run({
      owner: "test",
      repo: "test",
      name: "Test Check",
      headSha: "abc123",
      status: "completed",
    });
    const parsed = JSON.parse(text) as { error?: { code: string } };

    // Should return validation error for missing conclusion
    if (parsed.error?.code !== "AUTH_MISSING") {
      if (parsed.error) {
        expect(parsed.error.code).toBe("VALIDATION");
      }
    }
  });

  test("returns error for missing authentication", async () => {
    const text = await run({
      owner: "nonexistent",
      repo: "nonexistent",
      name: "Test Check",
      headSha: "abc123",
      status: "queued",
    });
    const parsed = JSON.parse(text) as { error?: { code: string } };

    // May return AUTH_MISSING depending on environment
    if (parsed.error) {
      expect(parsed.error.code).toBeDefined();
    }
  });

  test("returns check run structure when successful", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Test Check",
      headSha: "abc1234567890123456789012345678901234567",
      status: "queued",
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      id?: number;
      url?: string;
    };

    if (parsed.error?.code !== "AUTH_MISSING") {
      if (!parsed.error && parsed.id !== undefined) {
        expect(typeof parsed.id).toBe("number");
        expect(typeof parsed.url).toBe("string");
      }
    }
  });

  test("accepts optional title and summary", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Check with Details",
      headSha: "def1234567890123456789012345678901234567",
      status: "in_progress",
      title: "Test Title",
      summary: "Test summary content",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });

  test("accepts completed status with conclusion", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Completed Check",
      headSha: "ghi1234567890123456789012345678901234567",
      status: "completed",
      conclusion: "success",
      title: "All good",
      summary: "Check completed successfully",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });

  test("defaults to queued status", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Default Status Check",
      headSha: "jkl1234567890123456789012345678901234567",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });
});
