import { z } from "zod";

export const FormatSchema = z.enum(["markdown", "json"]).optional().default("json");

export const RepoRefSchema = z.object({
  owner: z.string().describe("GitHub owner or organization."),
  repo: z.string().describe("GitHub repository name."),
});

export const LocalOrRemoteRepoSchema = z.union([
  RepoRefSchema,
  z.object({ localPath: z.string().describe("Absolute path to a local clone.") }),
]);

/** Max commits to compare/fetch (shared by release_readiness and changelog_draft). */
export const MaxCommitsSchema = z.number().int().min(1).max(200).optional().default(50);

/** Max log lines to fetch per failing CI job (shared by ci_diagnosis and pr_preflight). */
export const MaxLogLinesSchema = z.number().int().min(10).max(500).optional().default(50);
