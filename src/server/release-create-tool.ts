import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseCreateResult {
  url: string;
  id: number;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  warnings?: string[];
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerReleaseCreateTool(server: FastMCP): void {
  server.addTool({
    name: "release_create",
    description:
      "Create a GitHub release. Accepts tag, optional name/body, draft/prerelease flags, and auto-generate option.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      tag: z.string().describe('Release tag (e.g. "v1.2.3")'),
      name: z.string().optional().describe("Release title; defaults to tag name."),
      body: z.string().optional().describe("Release notes (markdown)."),
      draft: z.boolean().optional().default(false).describe("Mark as draft; defaults to false."),
      prerelease: z
        .boolean()
        .optional()
        .default(false)
        .describe("Mark as prerelease; defaults to false."),
      generateNotes: z
        .boolean()
        .optional()
        .default(false)
        .describe("Auto-generate release notes from commits; overrides body."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return the resolved parameters that WOULD be used WITHOUT creating the release.",
        ),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, tag, draft, prerelease, generateNotes, dryRun } = args;
      const name = args.name ?? tag;
      const body = args.body ?? "";

      const warnings: string[] = [];

      // Warn when generateNotes and body are both supplied (generateNotes wins)
      if (generateNotes && args.body) {
        warnings.push(
          "Both 'generateNotes' and 'body' were supplied; 'body' is ignored when 'generateNotes' is true.",
        );
      }

      if (dryRun) {
        const dryRunResult: ReleaseCreateResult = {
          url: "",
          id: 0,
          tag,
          draft,
          prerelease,
          dryRun: true,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        return jsonRespond(dryRunResult);
      }

      try {
        const octokit = getOctokit();

        // Pre-check: return a clear CONFLICT error if a release already exists for this tag
        try {
          await octokit.repos.getReleaseByTag({ owner, repo, tag });
          return errorRespond(
            mkError(
              "VALIDATION",
              `A release for tag '${tag}' already exists in ${owner}/${repo}. Delete it first or use a different tag.`,
              { suggestedFix: "Check existing releases or choose a new tag." },
            ),
          );
        } catch (checkErr) {
          const e = checkErr as { status?: number };
          // 404 means no existing release — proceed
          if (e.status !== 404) throw checkErr;
        }

        const release = await octokit.repos.createRelease({
          owner,
          repo,
          tag_name: tag,
          name,
          body,
          draft,
          prerelease,
          generate_release_notes: generateNotes,
        });

        const result: ReleaseCreateResult = {
          url: release.data.html_url,
          id: release.data.id,
          tag: release.data.tag_name,
          draft: release.data.draft,
          prerelease: release.data.prerelease,
          ...(warnings.length > 0 ? { warnings } : {}),
        };

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[release_create] Failed to create release for ${owner}/${repo} tag ${tag}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
