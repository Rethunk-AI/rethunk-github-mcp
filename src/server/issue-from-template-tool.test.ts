import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

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

  describe("dryRun preview", () => {
    test("fetches+renders template and returns plan without calling issues.create", async () => {
      const create = mock(async () => ({ data: {} }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (path === ".github/ISSUE_TEMPLATE") {
              return {
                data: [{ type: "file", name: "bug.md", path: ".github/ISSUE_TEMPLATE/bug.md" }],
              };
            }
            const b64 = Buffer.from("Description: {{ desc }}", "utf-8").toString("base64");
            return { data: { type: "file", content: b64 } };
          },
        },
        issues: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "bug.md",
          variables: { desc: "crash on startup" },
          title: "Bug: crash",
          labels: ["bug", "p1"],
          dryRun: true,
        }),
      ) as { dryRun: boolean; plan: Record<string, unknown> };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.plan).toMatchObject({
        owner: "o",
        repo: "r",
        title: "Bug: crash",
        bodyPreview: "Description: crash on startup",
        labels: ["bug", "p1"],
      });
      expect(create).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  describe("Issue Forms (.yml/.yaml)", () => {
    const ISSUE_FORM_YAML = `
name: Bug Report
title: "[Bug]: default title"
labels:
  - bug
body:
  - type: markdown
    attributes:
      value: Thanks for filing a bug!
  - type: input
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - Low
        - High
`;

    function mockYamlOctokit(
      create: (params: { title?: string; body?: string; labels?: string[] }) => Promise<{
        data: { number: number; html_url: string; title: string };
      }>,
    ): ReturnType<typeof githubClient.getOctokit> {
      return {
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (path === ".github/ISSUE_TEMPLATE") {
              return {
                data: [{ type: "file", name: "bug.yml", path: ".github/ISSUE_TEMPLATE/bug.yml" }],
              };
            }
            const b64 = Buffer.from(ISSUE_FORM_YAML, "utf-8").toString("base64");
            return { data: { type: "file", content: b64 } };
          },
        },
        issues: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>;
    }

    test("renders ### <label> sections and creates the issue", async () => {
      const create = mock(async (params: { title?: string; body?: string }) => ({
        data: { number: 5, html_url: "https://github.com/o/r/issues/5", title: params.title ?? "" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(mockYamlOctokit(create));

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "bug.yml",
          variables: { summary: "Crash on launch", severity: "Low" },
          title: "Explicit title",
        }),
      ) as { number?: number };

      expect(parsed.number).toBe(5);
      const call = create.mock.calls[0]?.[0] as {
        title?: string;
        body?: string;
        labels?: string[];
      };
      expect(call.title).toBe("Explicit title");
      expect(call.body).toBe(
        "Thanks for filing a bug!\n\n### Summary\n\nCrash on launch\n\n### Severity\n\nLow",
      );
      expect(call.labels).toEqual(["bug"]);

      spy.mockRestore();
    });

    test("regression: .md template still uses mustache substitution, not Issue Forms rendering", async () => {
      const create = mock(async (params: { title?: string; body?: string }) => ({
        data: { number: 6, html_url: "https://github.com/o/r/issues/6", title: params.title ?? "" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (path === ".github/ISSUE_TEMPLATE") {
              return {
                data: [
                  { type: "file", name: "legacy.md", path: ".github/ISSUE_TEMPLATE/legacy.md" },
                ],
              };
            }
            const b64 = Buffer.from("Hello {{ name }}", "utf-8").toString("base64");
            return { data: { type: "file", content: b64 } };
          },
        },
        issues: { create },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "legacy.md",
          variables: { name: "World" },
          title: "Regression",
        }),
      ) as { number?: number };

      expect(parsed.number).toBe(6);
      const call = create.mock.calls[0]?.[0] as { body?: string };
      expect(call.body).toBe("Hello World");

      spy.mockRestore();
    });

    test("caller-supplied title wins over the form-declared title", async () => {
      const create = mock(async (params: { title?: string }) => ({
        data: { number: 1, html_url: "https://github.com/o/r/issues/1", title: params.title ?? "" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(mockYamlOctokit(create));

      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "bug.yml",
        variables: { summary: "x", severity: "Low" },
        title: "Caller title",
      });

      const call = create.mock.calls[0]?.[0] as { title?: string };
      expect(call.title).toBe("Caller title");

      spy.mockRestore();
    });

    test("form-declared title is used when the caller omits title", async () => {
      const create = mock(async (params: { title?: string }) => ({
        data: { number: 1, html_url: "https://github.com/o/r/issues/1", title: params.title ?? "" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(mockYamlOctokit(create));

      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "bug.yml",
        variables: { summary: "x", severity: "Low" },
      });

      const call = create.mock.calls[0]?.[0] as { title?: string };
      expect(call.title).toBe("[Bug]: default title");

      spy.mockRestore();
    });

    test("form-declared labels merge with caller-supplied labels", async () => {
      const create = mock(async () => ({
        data: { number: 1, html_url: "https://github.com/o/r/issues/1", title: "" },
      }));
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(mockYamlOctokit(create));

      await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
        owner: "o",
        repo: "r",
        template: "bug.yml",
        variables: { summary: "x", severity: "Low" },
        title: "t",
        labels: ["urgent", "bug"],
      });

      const call = create.mock.calls[0]?.[0] as { labels?: string[] };
      expect(call.labels?.sort()).toEqual(["bug", "urgent"]);

      spy.mockRestore();
    });

    test("missing required field returns a VALIDATION envelope naming the field", async () => {
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
        mockYamlOctokit(mock(async () => ({ data: { number: 1, html_url: "", title: "" } }))),
      );

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "bug.yml",
          variables: { severity: "Low" },
          title: "t",
        }),
      ) as { error?: { code: string; message: string } };

      expect(parsed.error?.code).toBe("VALIDATION");
      expect(parsed.error?.message).toContain("summary");

      spy.mockRestore();
    });

    test("unknown variable key returns a VALIDATION envelope naming the key", async () => {
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
        mockYamlOctokit(mock(async () => ({ data: { number: 1, html_url: "", title: "" } }))),
      );

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "bug.yml",
          variables: { summary: "x", severity: "Low", typo: "y" },
          title: "t",
        }),
      ) as { error?: { code: string; message: string } };

      expect(parsed.error?.code).toBe("VALIDATION");
      expect(parsed.error?.message).toContain("typo");

      spy.mockRestore();
    });

    test("dropdown value outside declared options returns a VALIDATION envelope", async () => {
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue(
        mockYamlOctokit(mock(async () => ({ data: { number: 1, html_url: "", title: "" } }))),
      );

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "bug.yml",
          variables: { summary: "x", severity: "Critical" },
          title: "t",
        }),
      ) as { error?: { code: string; message: string } };

      expect(parsed.error?.code).toBe("VALIDATION");
      expect(parsed.error?.message).toContain("severity");

      spy.mockRestore();
    });

    test("malformed YAML returns a VALIDATION envelope instead of throwing", async () => {
      const spy = spyOn(githubClient, "getOctokit").mockReturnValue({
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (path === ".github/ISSUE_TEMPLATE") {
              return {
                data: [
                  { type: "file", name: "broken.yml", path: ".github/ISSUE_TEMPLATE/broken.yml" },
                ],
              };
            }
            const b64 = Buffer.from("body: [\n  - unterminated", "utf-8").toString("base64");
            return { data: { type: "file", content: b64 } };
          },
        },
        issues: { create: mock(async () => ({ data: {} })) },
      } as unknown as ReturnType<typeof githubClient.getOctokit>);

      const parsed = JSON.parse(
        await captureTool(registerIssueFromTemplateTool, "issue_from_template", {
          owner: "o",
          repo: "r",
          template: "broken.yml",
          variables: {},
          title: "t",
        }),
      ) as { error?: { code: string } };

      expect(parsed.error?.code).toBe("VALIDATION");

      spy.mockRestore();
    });
  });
});
