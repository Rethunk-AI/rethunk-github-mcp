import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";

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
      const auth = gateAuth();
      if (!auth.ok) {
        return jsonRespond({ authenticated: false } satisfies GhAuthStatusResult);
      }

      try {
        const octokit = getOctokit();
        const user = await octokit.users.getAuthenticated();

        // GitHub returns granted scopes in the `x-oauth-scopes` response header
        // as a comma-space-separated string (e.g. "repo, user, gist").
        const scopeHeader = (user.headers as Record<string, string | undefined>)["x-oauth-scopes"];
        const scopes = scopeHeader ? scopeHeader.split(", ").filter(Boolean) : [];

        const result: GhAuthStatusResult = {
          authenticated: true,
          login: user.data.login,
          scopes,
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
        return errorRespond(classifyError(err));
      }
    },
  });
}
