import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, mkError, truncateText } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueFromTemplateResult {
  number: number;
  url: string;
  title: string;
}

export interface IssueFromTemplateDryRunResult {
  dryRun: true;
  plan: {
    owner: string;
    repo: string;
    title: string;
    bodyPreview: string;
    labels: string[];
  };
}

// ---------------------------------------------------------------------------
// Helper Functions (exported pieces are covered by unit tests)
// ---------------------------------------------------------------------------

/** Minimal Octokit surface used by issue-template helpers. */
export type IssueTemplateOctokit = {
  repos: {
    getContent: (params: {
      owner: string;
      repo: string;
      path: string;
    }) => Promise<{ data: unknown }>;
  };
};

export type IssueTemplateEntry = { name: string; path: string };

/**
 * Fetch the list of issue templates from `.github/ISSUE_TEMPLATE/` directory.
 * Returns an array of { name: string, path: string } for each template file.
 */
export async function fetchIssueTemplateDirectory(
  octokit: IssueTemplateOctokit,
  owner: string,
  repo: string,
): Promise<IssueTemplateEntry[]> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: ".github/ISSUE_TEMPLATE",
    });

    // Response should be an array of files
    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .filter((item) => item.type === "file" && item.name)
      .map((item) => ({
        name: item.name || "",
        path: item.path || "",
      }));
  } catch (_err) {
    // If the directory doesn't exist or isn't accessible, return empty list
    return [];
  }
}

async function fetchTemplateList(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
): Promise<IssueTemplateEntry[]> {
  return fetchIssueTemplateDirectory(octokit, owner, repo);
}

/**
 * Find a template by filename or partial match.
 * Exact match takes precedence; falls back to case-insensitive partial match.
 */
export function findTemplate(
  templates: IssueTemplateEntry[],
  templateName: string,
): IssueTemplateEntry | undefined {
  // Try exact match first
  const exact = templates.find((t) => t.name.toLowerCase() === templateName.toLowerCase());
  if (exact) return exact;

  // Try partial match (case-insensitive)
  const partial = templates.find((t) => t.name.toLowerCase().includes(templateName.toLowerCase()));
  return partial;
}

/**
 * Fetch the content of a specific template file.
 */
export async function fetchIssueTemplateFileContent(
  octokit: IssueTemplateOctokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
  });

  const data: unknown = response.data;
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("content" in data)) {
    throw new Error(`Template at ${path} is not a file`);
  }

  const raw = (data as { content?: string }).content;
  // Decode base64 content
  const content = Buffer.from(raw || "", "base64").toString("utf-8");
  return content;
}

async function fetchTemplateContent(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  path: string,
): Promise<string> {
  return fetchIssueTemplateFileContent(octokit, owner, repo, path);
}

/**
 * Substitute template variables in the format {{ variable }}.
 * Only mustache-style `{{ variable }}` placeholders are supported.
 * The `$variable` syntax has been removed to avoid unintended rewrites of
 * shell-style tokens, numeric references like `$100`, and similar patterns.
 */
export function substituteVariables(
  template: string,
  variables: Record<string, string | number | boolean>,
): string {
  // Replace {{ variable }} style only
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value !== undefined ? String(value) : `{{ ${key} }}`;
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerIssueFromTemplateTool(server: FastMCP): void {
  server.addTool({
    name: "issue_from_template",
    description:
      "Create a GitHub issue from a repository issue template. Searches for the template by filename (exact or partial match), substitutes variables, and creates the issue.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      template: z
        .string()
        .describe(
          'Template filename (e.g. "bug_report.md") or partial match. Matched case-insensitively.',
        ),
      variables: z
        .record(z.string(), z.any())
        .describe(
          "Key-value pairs for template variable substitution. Replaces {{ key }} patterns only.",
        ),
      title: z.string().describe("Issue title."),
      assignees: z
        .array(z.string())
        .optional()
        .describe("GitHub usernames to assign to the issue."),
      labels: z.array(z.string()).optional().describe("Labels to apply to the issue."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, fetch and render the template (variable substitution included), then return the planned issue (owner/repo/title/bodyPreview/labels) WITHOUT executing any mutation.",
        ),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const {
        owner,
        repo,
        template: templateName,
        variables,
        title,
        assignees,
        labels,
        dryRun,
      } = args;

      try {
        const octokit = getOctokit();

        // Fetch the list of available templates
        const templates = await fetchTemplateList(octokit, owner, repo);
        if (templates.length === 0) {
          return errorRespond(
            mkError(
              "NOT_FOUND",
              `No issue templates found in ${owner}/${repo}/.github/ISSUE_TEMPLATE/`,
            ),
          );
        }

        // Find the matching template
        const matchedTemplate = findTemplate(templates, templateName);
        if (!matchedTemplate) {
          const availableTemplates = templates.map((t) => t.name).join(", ");
          return errorRespond(
            mkError(
              "NOT_FOUND",
              `Template "${templateName}" not found. Available templates: ${availableTemplates}`,
            ),
          );
        }

        // Fetch template content
        const templateContent = await fetchTemplateContent(
          octokit,
          owner,
          repo,
          matchedTemplate.path,
        );

        // Substitute variables in the template content
        // biome-ignore lint/suspicious/noExplicitAny: Runtime variable conversion from schema
        const body = substituteVariables(templateContent, variables as any);

        if (dryRun) {
          const plan: IssueFromTemplateDryRunResult["plan"] = {
            owner,
            repo,
            title,
            bodyPreview: truncateText(body, 200),
            labels: labels ?? [],
          };
          return jsonRespond({ dryRun: true, plan });
        }

        // Create the issue with the rendered template
        const requestParams: Parameters<typeof octokit.issues.create>[0] = {
          owner,
          repo,
          title,
          body,
          ...(assignees && assignees.length > 0 ? { assignees } : {}),
          ...(labels && labels.length > 0 ? { labels } : {}),
        };

        const issue = await octokit.issues.create(requestParams);

        const result: IssueFromTemplateResult = {
          number: issue.data.number,
          url: issue.data.html_url,
          title: issue.data.title,
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[issue_from_template] Failed to create issue for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
