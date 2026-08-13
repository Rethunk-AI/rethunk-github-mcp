import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerPrCreateTool } from "./pr-create-tool.js";
import { captureTool } from "./test-harness.js";

describe("pr_create", () => {
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

    test("returns plan without calling pulls.create", async () => {
      const create = mock(async () => ({ data: {} }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        pulls: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerPrCreateTool, "pr_create", {
          owner: "o",
          repo: "r",
          title: "My PR",
          head: "feature/x",
          base: "main",
          body: "Some body text",
          dryRun: true,
        }),
      ) as { dryRun: boolean; plan: Record<string, unknown> };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.plan).toMatchObject({
        owner: "o",
        repo: "r",
        head: "feature/x",
        base: "main",
        title: "My PR",
        draft: false,
        bodyPreview: "Some body text",
      });
      expect(create).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });
});
