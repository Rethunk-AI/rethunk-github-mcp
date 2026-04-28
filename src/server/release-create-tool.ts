import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
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
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, tag, draft, prerelease, generateNotes } = args;
      const name = args.name ?? tag;
      let body = args.body ?? "";

      try {
        const octokit = getOctokit();

        // If generateNotes is true, auto-generate the release notes.
        if (generateNotes) {
          try {
            const notesRes = await octokit.repos.generateReleaseNotes({
              owner,
              repo,
              tag_name: tag,
            });
            body = notesRes.data.body;
          } catch (err) {
            console.error(
              `[release_create] Failed to generate release notes for ${owner}/${repo} tag ${tag}:`,
              err instanceof Error ? err.message : String(err),
            );
            // Fall through with empty body rather than failing entirely
          }
        }

        const release = await octokit.repos.createRelease({
          owner,
          repo,
          tag_name: tag,
          name,
          body,
          draft,
          prerelease,
          generate_release_notes: false, // We handle generation above
        });

        const result: ReleaseCreateResult = {
          url: release.data.html_url,
          id: release.data.id,
          tag: release.data.tag_name,
          draft: release.data.draft,
          prerelease: release.data.prerelease,
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
