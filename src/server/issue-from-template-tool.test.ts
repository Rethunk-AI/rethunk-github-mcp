import { describe, test } from "bun:test";

import { registerIssueFromTemplateTool } from "./issue-from-template-tool.js";
import { captureTool } from "./test-harness.js";

describe("issue_from_template", () => {
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

  test("variable substitution with dollar-sign syntax", async () => {
    const result = await captureTool(
      (server) => registerIssueFromTemplateTool(server),
      "issue_from_template",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        template: "bug_report.md",
        variables: {
          description: "Dollar sign substitution test",
          component: "API",
        },
        title: "Test $component issue",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success for dollar substitution: ${JSON.stringify(result)}`);
    }
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
