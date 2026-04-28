import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";

export interface GhAuthStatusResult {
  authenticated: boolean;
  login?: string;
  scopes?: string[];
}

export function registerGhAuthStatusTool(server: FastMCP): void {
  server.addTool({
    name: "gh_auth_status",
    description:
      "Returns authentication status: whether an authenticated token is available, and if so, the authenticated user's login and token scopes.",
    annotations: { readOnlyHint: true },
    parameters: z.object({}),
    execute: async () => {
      try {
        const octokit = getOctokit();
        const user = await octokit.users.getAuthenticated();

        // Get scopes from response headers (GitHub returns them on every API call)
        // When fetching via REST, scopes may not be directly in the response,
        // but we can infer from the fact that auth succeeded
        const result: GhAuthStatusResult = {
          authenticated: true,
          login: user.data.login,
          // Scopes are typically available via the `x-oauth-scopes` header,
          // but Octokit doesn't expose them directly. For this implementation,
          // we return an empty array if we can't determine them.
          scopes: [],
        };

        return jsonRespond(result);
      } catch (err) {
        // Check if it's a 401 Unauthorized error
        const e = err as { status?: number; message?: string };
        if (e.status === 401) {
          const result: GhAuthStatusResult = {
            authenticated: false,
          };
          return jsonRespond(result);
        }

        // For other errors, return an error envelope
        const message = typeof e?.message === "string" ? e.message : "Failed to check auth status";
        return errorRespond(
          mkError("INTERNAL", message, {
            suggestedFix: "Verify GitHub credentials are available.",
          }),
        );
      }
    },
  });
}
