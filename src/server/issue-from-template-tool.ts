import type { FastMCP } from "fastmcp";
import { parse as parseYaml } from "yaml";
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
// GitHub Issue Forms (YAML) rendering
// ---------------------------------------------------------------------------

/** A single declared checkbox option; `required` means that box must be checked. */
export interface IssueFormCheckboxOption {
  label: string;
  required?: boolean;
}

export interface IssueFormAttributes {
  label?: string;
  value?: string;
  placeholder?: string;
  /** `dropdown` options are plain labels; `checkboxes` options carry a per-box `required` flag. */
  options?: string[] | IssueFormCheckboxOption[];
}

export interface IssueFormElement {
  type: "markdown" | "input" | "textarea" | "dropdown" | "checkboxes";
  id?: string;
  attributes?: IssueFormAttributes;
  validations?: { required?: boolean };
}

export interface IssueForm {
  name?: string;
  description?: string;
  title?: string;
  labels?: string[];
  assignees?: string[];
  body: IssueFormElement[];
}

export interface RenderedIssueForm {
  body: string;
  title?: string;
  labels: string[];
  assignees: string[];
}

/** Raised for any Issue Form problem that should surface as a `VALIDATION` tool error. */
export class IssueFormValidationError extends Error {
  readonly suggestedFix?: string;

  constructor(message: string, suggestedFix?: string) {
    super(message);
    this.name = "IssueFormValidationError";
    this.suggestedFix = suggestedFix;
  }
}

/** Lowercase, non-alphanumerics collapsed to `-`, matching GitHub's own field-id slugging. */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Validate the minimal shape needed to render — an Issue Form is a mapping with a `body` array. */
export function parseIssueForm(raw: unknown): IssueForm {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IssueFormValidationError("Issue form YAML must be a top-level mapping.");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.body)) {
    throw new IssueFormValidationError("Issue form YAML is missing a top-level `body` array.");
  }
  return {
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.title === "string" ? { title: obj.title } : {}),
    ...(Array.isArray(obj.labels) ? { labels: obj.labels.map(String) } : {}),
    ...(Array.isArray(obj.assignees) ? { assignees: obj.assignees.map(String) } : {}),
    body: obj.body as IssueFormElement[],
  };
}

function fieldKey(element: IssueFormElement): string {
  return element.id ?? slugifyLabel(element.attributes?.label ?? "");
}

function normalizeCheckboxSelection(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === "string") {
    return new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
  if (value === undefined || value === null) return new Set();
  return new Set([String(value)]);
}

/**
 * Render a GitHub Issue Form definition into the markdown body GitHub itself
 * would produce, resolving each declared field from `variables`.
 * Throws `IssueFormValidationError` for unknown variable keys, unmet
 * `validations.required`, or a dropdown value outside its declared options.
 */
export function renderIssueForm(
  form: IssueForm,
  variables: Record<string, unknown>,
): RenderedIssueForm {
  const knownKeys = new Set<string>();
  for (const element of form.body) {
    if (element.type !== "markdown") knownKeys.add(fieldKey(element));
  }

  const unknownKeys = Object.keys(variables).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new IssueFormValidationError(
      `Unknown variable key(s): ${unknownKeys.join(", ")}. Valid field ids: ${
        [...knownKeys].join(", ") || "(none)"
      }.`,
      `Remove or correct: ${unknownKeys.join(", ")}.`,
    );
  }

  const missingRequired: string[] = [];
  const invalidDropdown: string[] = [];
  const blocks: string[] = [];

  for (const element of form.body) {
    if (element.type === "markdown") {
      blocks.push(String(element.attributes?.value ?? ""));
      continue;
    }

    const key = fieldKey(element);
    const label = element.attributes?.label ?? key;
    const provided = variables[key];

    if (element.type === "checkboxes") {
      const options = (element.attributes?.options ?? []) as IssueFormCheckboxOption[];
      const selected = normalizeCheckboxSelection(provided);
      const lines = options.map((option) => {
        const checked = selected.has(option.label);
        if (option.required && !checked) {
          missingRequired.push(`${key} ("${option.label}")`);
        }
        return `- [${checked ? "x" : " "}] ${option.label}`;
      });
      blocks.push(`### ${label}\n\n${lines.join("\n")}`);
      continue;
    }

    let value: string | undefined;
    if (provided !== undefined) {
      value = String(provided);
    } else if (element.attributes?.value !== undefined) {
      value = String(element.attributes.value);
    }

    if (element.type === "dropdown" && value !== undefined) {
      const options = (element.attributes?.options ?? []) as string[];
      if (!options.includes(value)) {
        invalidDropdown.push(`${key}="${value}" (expected one of: ${options.join(", ")})`);
      }
    }

    if (value === undefined) {
      if (element.validations?.required) missingRequired.push(key);
      value = "_No response_";
    }

    blocks.push(`### ${label}\n\n${value}`);
  }

  if (missingRequired.length > 0) {
    throw new IssueFormValidationError(
      `Missing required field(s): ${missingRequired.join(", ")}`,
      `Provide values for: ${missingRequired.join(", ")}.`,
    );
  }
  if (invalidDropdown.length > 0) {
    throw new IssueFormValidationError(
      `Invalid dropdown value(s): ${invalidDropdown.join("; ")}`,
      "Use one of the declared dropdown options.",
    );
  }

  return {
    body: blocks.join("\n\n"),
    ...(form.title !== undefined ? { title: form.title } : {}),
    labels: form.labels ?? [],
    assignees: form.assignees ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerIssueFromTemplateTool(server: FastMCP): void {
  server.addTool({
    name: "issue_from_template",
    description:
      "Create a GitHub issue from a repository issue template. Searches for the template by filename (exact or partial match), substitutes variables, and creates the issue. `.yml`/`.yaml` templates are rendered as GitHub Issue Forms; other extensions use mustache `{{ var }}` substitution.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      template: z
        .string()
        .describe(
          'Template filename (e.g. "bug_report.md" or "bug_report.yml") or partial match. Matched case-insensitively.',
        ),
      variables: z
        .record(z.string(), z.any())
        .describe(
          "Key-value pairs used for template rendering. For `.md` templates, replaces {{ key }} patterns only. For Issue Form `.yml`/`.yaml` templates, keys are field `id`s (or slugified `label`s).",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Issue title. Required unless the matched template is an Issue Form declaring a top-level `title:`.",
        ),
      assignees: z
        .array(z.string())
        .optional()
        .describe("GitHub usernames to assign to the issue."),
      labels: z.array(z.string()).optional().describe("Labels to apply to the issue."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview only; returns the planned change without mutating."),
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

        const isIssueForm = /\.ya?ml$/i.test(matchedTemplate.name);

        let body: string;
        let effectiveTitle = title;
        let effectiveLabels = labels ?? [];
        let effectiveAssignees = assignees ?? [];

        if (isIssueForm) {
          let parsedYaml: unknown;
          try {
            parsedYaml = parseYaml(templateContent);
          } catch (yamlErr) {
            return errorRespond(
              mkError(
                "VALIDATION",
                `Malformed YAML in issue form template "${matchedTemplate.name}": ${
                  yamlErr instanceof Error ? yamlErr.message : String(yamlErr)
                }`,
                { suggestedFix: "Fix the YAML syntax in the template file." },
              ),
            );
          }

          try {
            const form = parseIssueForm(parsedYaml);
            const rendered = renderIssueForm(form, variables as Record<string, unknown>);
            body = rendered.body;
            effectiveTitle = title ?? rendered.title;
            effectiveLabels = [...new Set([...(labels ?? []), ...rendered.labels])];
            effectiveAssignees = [...new Set([...(assignees ?? []), ...rendered.assignees])];
          } catch (formErr) {
            if (formErr instanceof IssueFormValidationError) {
              return errorRespond(
                mkError("VALIDATION", formErr.message, {
                  ...(formErr.suggestedFix !== undefined
                    ? { suggestedFix: formErr.suggestedFix }
                    : {}),
                }),
              );
            }
            return errorRespond(
              mkError("VALIDATION", formErr instanceof Error ? formErr.message : String(formErr)),
            );
          }
        } else {
          body = substituteVariables(
            templateContent,
            variables as Record<string, string | number | boolean>,
          );
        }

        if (!effectiveTitle) {
          return errorRespond(
            mkError("VALIDATION", "Issue title is required.", {
              suggestedFix: isIssueForm
                ? "Pass `title`, or declare a top-level `title:` in the issue form template."
                : "Pass `title`.",
            }),
          );
        }

        if (dryRun) {
          const plan: IssueFromTemplateDryRunResult["plan"] = {
            owner,
            repo,
            title: effectiveTitle,
            bodyPreview: truncateText(body, 200),
            labels: effectiveLabels,
          };
          return jsonRespond({ dryRun: true, plan });
        }

        // Create the issue with the rendered template
        const requestParams: Parameters<typeof octokit.issues.create>[0] = {
          owner,
          repo,
          title: effectiveTitle,
          body,
          ...(effectiveAssignees.length > 0 ? { assignees: effectiveAssignees } : {}),
          ...(effectiveLabels.length > 0 ? { labels: effectiveLabels } : {}),
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
