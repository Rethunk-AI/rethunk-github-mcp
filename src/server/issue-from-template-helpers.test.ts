import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import {
  fetchIssueTemplateDirectory,
  fetchIssueTemplateFileContent,
  findTemplate,
  type IssueForm,
  IssueFormValidationError,
  type IssueTemplateOctokit,
  parseIssueForm,
  renderIssueForm,
  slugifyLabel,
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

  test("coerces numbers and booleans to string", () => {
    const out = substituteVariables("{{ n }} {{ b }}", { n: 42, b: true });
    expect(out).toBe("42 true");
  });

  test("leaves $word patterns untouched (not a supported syntax)", () => {
    // $variable substitution was removed to prevent unintended rewrites
    // of shell tokens, numeric references like $100, etc.
    const out = substituteVariables("Path $dir ok", { dir: "/tmp" });
    expect(out).toBe("Path $dir ok");
  });

  test("handles adjacent brace patterns", () => {
    const out = substituteVariables("{{a}}{{b}}", { a: "1", b: "2" });
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

const ISSUE_FORM_YAML = `
name: Bug Report
title: "[Bug]: default title"
labels:
  - bug
  - triage
assignees:
  - octocat
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
  - type: textarea
    id: repro
    attributes:
      label: Steps to Reproduce
      value: No steps provided by default.
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - Low
        - Medium
        - High
  - type: checkboxes
    id: confirm
    attributes:
      label: Confirmations
      options:
        - label: I searched existing issues
          required: true
        - label: I can reproduce reliably
`;

function loadIssueForm(): IssueForm {
  return parseIssueForm(parseYaml(ISSUE_FORM_YAML));
}

describe("slugifyLabel", () => {
  test("lowercases and collapses non-alphanumerics to a single dash", () => {
    expect(slugifyLabel("Steps to Reproduce!")).toBe("steps-to-reproduce");
  });
});

describe("parseIssueForm", () => {
  test("parses declared title/labels/assignees and the body array", () => {
    const form = loadIssueForm();
    expect(form.title).toBe("[Bug]: default title");
    expect(form.labels).toEqual(["bug", "triage"]);
    expect(form.assignees).toEqual(["octocat"]);
    expect(form.body).toHaveLength(5);
  });

  test("throws IssueFormValidationError when the document isn't a mapping", () => {
    expect(() => parseIssueForm("just a string")).toThrow(IssueFormValidationError);
  });

  test("throws IssueFormValidationError when `body` is missing", () => {
    expect(() => parseIssueForm({ title: "x" })).toThrow(IssueFormValidationError);
  });
});

describe("renderIssueForm", () => {
  test("renders markdown inline and ### <label> sections in body order", () => {
    const rendered = renderIssueForm(loadIssueForm(), {
      summary: "Crash on launch",
      severity: "Medium",
      confirm: ["I searched existing issues", "I can reproduce reliably"],
    });

    expect(rendered.body).toBe(
      [
        "Thanks for filing a bug!",
        "### Summary\n\nCrash on launch",
        "### Steps to Reproduce\n\nNo steps provided by default.",
        "### Severity\n\nMedium",
        "### Confirmations\n\n- [x] I searched existing issues\n- [x] I can reproduce reliably",
      ].join("\n\n"),
    );
    expect(rendered.title).toBe("[Bug]: default title");
    expect(rendered.labels).toEqual(["bug", "triage"]);
    expect(rendered.assignees).toEqual(["octocat"]);
  });

  test("uses the declared attributes.value default when the caller omits a field", () => {
    const rendered = renderIssueForm(loadIssueForm(), {
      summary: "Crash on launch",
      confirm: "I searched existing issues",
    });
    expect(rendered.body).toContain("### Steps to Reproduce\n\nNo steps provided by default.");
  });

  test("renders _No response_ for an optional field with no value and no default", () => {
    const rendered = renderIssueForm(loadIssueForm(), {
      summary: "Crash on launch",
      confirm: "I searched existing issues",
    });
    expect(rendered.body).toContain("### Severity\n\n_No response_");
  });

  test("accepts a comma-separated string for checkbox selection", () => {
    const rendered = renderIssueForm(loadIssueForm(), {
      summary: "Crash on launch",
      confirm: "I searched existing issues, I can reproduce reliably",
    });
    expect(rendered.body).toContain(
      "- [x] I searched existing issues\n- [x] I can reproduce reliably",
    );
  });

  test("renders unchecked boxes for options the caller didn't select", () => {
    const rendered = renderIssueForm(loadIssueForm(), {
      summary: "Crash on launch",
      confirm: "I searched existing issues",
    });
    expect(rendered.body).toContain(
      "- [x] I searched existing issues\n- [ ] I can reproduce reliably",
    );
  });

  test("throws IssueFormValidationError naming the field when required and unmet", () => {
    expect(() =>
      renderIssueForm(loadIssueForm(), { confirm: "I searched existing issues" }),
    ).toThrow(/summary/);
  });

  test("throws IssueFormValidationError naming a missing required checkbox option", () => {
    expect(() =>
      renderIssueForm(loadIssueForm(), { summary: "Crash on launch", confirm: [] }),
    ).toThrow(/I searched existing issues/);
  });

  test("throws IssueFormValidationError when a dropdown value isn't a declared option", () => {
    expect(() =>
      renderIssueForm(loadIssueForm(), {
        summary: "Crash on launch",
        severity: "Critical",
        confirm: "I searched existing issues",
      }),
    ).toThrow(/severity/);
  });

  test("throws IssueFormValidationError naming an unknown variable key", () => {
    expect(() =>
      renderIssueForm(loadIssueForm(), {
        summary: "Crash on launch",
        confirm: "I searched existing issues",
        nope: "typo",
      }),
    ).toThrow(/nope/);
  });
});
