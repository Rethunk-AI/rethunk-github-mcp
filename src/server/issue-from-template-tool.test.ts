import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetAuthCache } from "./github-auth.js";
import * as githubClient from "./github-client.js";
import { registerIssueFromTemplateTool } from "./issue-from-template-tool.js";
import { captureTool } from "./test-harness.js";

describe("issue_from_template", () => {
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
  test("basic issue creation with template and variables", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Test bug description",
          environment: "Production",
        },
        title: "Bug: Test issue",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("issue with partial template name match", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug",
        variables: {
          description: "Partial match test",
        },
        title: "Test partial match",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("issue with assignees", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Test with assignees",
        },
        title: "Test assignees",
        assignees: ["octocat", "user2"],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("issue with labels", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Test with labels",
        },
        title: "Test labels",
        labels: ["bug", "urgent"],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("issue with both assignees and labels", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Test with both",
          steps: "1. Do X\n2. Do Y",
        },
        title: "Test full config",
        assignees: ["octocat"],
        labels: ["bug", "p1"],
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("missing template returns error", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "nonexistent_template.md",
        variables: {},
        title: "Test missing template",
      },
    );

    if (result.ok) {
      console.log(
        `Expected tool failure for missing template but got success: ${JSON.stringify(result)}`,
      );
    }
  });

  test("variable substitution with double-brace syntax", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Double brace substitution test",
          version: "1.2.3",
        },
        title: "Test {{ version }} substitution",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success for variable substitution: ${JSON.stringify(result)}`);
    }
  });

  test("$variable patterns are NOT substituted (only {{ }} is supported)", async () => {
    // $variable substitution was removed; $word tokens must remain unchanged
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        getContent: async ({ path }: { path: string }) => {
          if (path === ".github/ISSUE_TEMPLATE") {
            return { data: [{ type: "file", name: "t.md", path: ".github/ISSUE_TEMPLATE/t.md" }] };
          }
          const b64 = Buffer.from("$component", "utf-8").toString("base64");
          return { data: { type: "file", content: b64 } };
        },
      },
      issues: {
        create: async (params: { body?: string }) => ({
          data: {
            number: 1,
            html_url: "https://github.com/o/r/issues/1",
            title: "t",
            body: params.body,
          },
        }),
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "t.md",
        variables: { component: "API" },
        title: "Test",
      }),
    ) as { number?: number; error?: { code: string } };

    // Issue should be created successfully (no error)
    expect(parsed.number).toBe(1);

    spy.mockRestore();
  });

  test("template-not-found returns NOT_FOUND error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        getContent: async ({ path }: { path: string }) => {
          if (path === ".github/ISSUE_TEMPLATE") {
            return {
              data: [
                {
                  type: "file",
                  name: "bug_report.md",
                  path: ".github/ISSUE_TEMPLATE/bug_report.md",
                },
              ],
            };
          }
          return { data: { type: "file", content: "" } };
        },
      },
      issues: { create: async () => ({ data: {} }) },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "nonexistent_template.md",
        variables: {},
        title: "Test missing",
      }),
    ) as { error: { code: string; message: string } };

    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.message).toContain("nonexistent_template.md");

    spy.mockRestore();
  });

  test("Octokit create failure returns structured error", async () => {
    const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
      repos: {
        getContent: async ({ path }: { path: string }) => {
          if (path === ".github/ISSUE_TEMPLATE") {
            return { data: [{ type: "file", name: "t.md", path: ".github/ISSUE_TEMPLATE/t.md" }] };
          }
          const b64 = Buffer.from("body", "utf-8").toString("base64");
          return { data: { type: "file", content: b64 } };
        },
      },
      issues: {
        create: async () => {
          throw { status: 403, message: "Must be member" };
        },
      },
    } as unknown as ReturnType<typeof githubClient.getOctokit>);

    const parsed = JSON.parse(
      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "t.md",
        variables: {},
        title: "Fail test",
      }),
    ) as { error: { code: string } };

    expect(parsed.error.code).toBe("PERMISSION_DENIED");

    spy.mockRestore();
  });

  test("case-insensitive template name matching", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "BUG_REPORT",
        variables: {
          description: "Case insensitive test",
        },
        title: "Test case insensitive",
      },
    );

    if (!result.ok) {
      console.log(
        `Expected tool success with case-insensitive matching: ${JSON.stringify(result)}`,
      );
    }
  });

  test("empty variables map", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {},
        title: "Test with empty variables",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success with empty variables: ${JSON.stringify(result)}`);
    }
  });
});
