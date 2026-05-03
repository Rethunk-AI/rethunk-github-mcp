import { describe, expect, test } from "bun:test";

import {
  fetchIssueTemplateDirectory,
  fetchIssueTemplateFileContent,
  findTemplate,
  type IssueTemplateOctokit,
  substituteVariables,
} from "./issue-from-template-tool.js";

describe("substituteVariables", () => {
  test("replaces double-brace placeholders when defined", () => {
    const out = substituteVariables("Hello {{ name }}", { name: "World" });
    expect(out).toBe("Hello World");
  });

  test("leaves double-brace placeholder when key missing", () => {
    const out = substituteVariables("Hello {{ missing }}", {});
    expect(out).toBe("Hello {{ missing }}");
  });

  test("replaces $word placeholders when defined", () => {
    const out = substituteVariables("Path $dir ok", { dir: "/tmp" });
    expect(out).toBe("Path /tmp ok");
  });

  test("leaves $placeholder when key missing", () => {
    const out = substituteVariables("Keep $x", {});
    expect(out).toBe("Keep $x");
  });

  test("coerces numbers and booleans to string", () => {
    const out = substituteVariables("{{ n }} $b", { n: 42, b: true });
    expect(out).toBe("42 true");
  });

  test("handles adjacent brace and dollar patterns", () => {
    const out = substituteVariables("{{a}}$b", { a: "1", b: "2" });
    expect(out).toBe("12");
  });
});

describe("findTemplate", () => {
  const templates = [
    { name: "bug_report.md", path: ".github/ISSUE_TEMPLATE/bug_report.md" },
    { name: "feature.md", path: ".github/ISSUE_TEMPLATE/feature.md" },
  ];

  test("exact match is case-insensitive", () => {
    expect(findTemplate(templates, "BUG_REPORT.MD")).toEqual(templates[0]);
  });

  test("partial match is case-insensitive", () => {
    expect(findTemplate(templates, "feat")).toEqual(templates[1]);
  });

  test("returns undefined when nothing matches", () => {
    expect(findTemplate(templates, "nope")).toBeUndefined();
  });
});

describe("fetchIssueTemplateDirectory", () => {
  test("maps file entries from directory listing", async () => {
    const octokit: IssueTemplateOctokit = {
      repos: {
        getContent: async () => ({
          data: [
            { type: "file", name: "a.md", path: ".github/ISSUE_TEMPLATE/a.md" },
            { type: "dir", name: "ignored", path: ".github/ISSUE_TEMPLATE/ignored" },
          ],
        }),
      },
    };
    const rows = await fetchIssueTemplateDirectory(octokit, "o", "r");
    expect(rows).toEqual([{ name: "a.md", path: ".github/ISSUE_TEMPLATE/a.md" }]);
  });

  test("returns empty array when response is not a directory listing", async () => {
    const octokit: IssueTemplateOctokit = {
      repos: {
        getContent: async () => ({
          data: { type: "file", content: "" },
        }),
      },
    };
    expect(await fetchIssueTemplateDirectory(octokit, "o", "r")).toEqual([]);
  });

  test("returns empty array when getContent throws", async () => {
    const octokit: IssueTemplateOctokit = {
      repos: {
        getContent: async () => {
          throw new Error("404");
        },
      },
    };
    expect(await fetchIssueTemplateDirectory(octokit, "o", "r")).toEqual([]);
  });
});

describe("fetchIssueTemplateFileContent", () => {
  test("decodes base64 file body", async () => {
    const body = "hello\nworld";
    const b64 = Buffer.from(body, "utf-8").toString("base64");
    const octokit: IssueTemplateOctokit = {
      repos: {
        getContent: async () => ({
          data: { type: "file", content: b64, encoding: "base64" },
        }),
      },
    };
    const text = await fetchIssueTemplateFileContent(octokit, "o", "r", "t.md");
    expect(text).toBe(body);
  });

  test("throws when payload is not a single file", async () => {
    const octokit: IssueTemplateOctokit = {
      repos: {
        getContent: async () => ({
          data: [{ type: "file" }],
        }),
      },
    };
    await expect(fetchIssueTemplateFileContent(octokit, "o", "r", "x")).rejects.toThrow(
      "Template at x is not a file",
    );
  });
});
