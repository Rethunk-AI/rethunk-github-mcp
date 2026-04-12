import { z } from "zod";

export const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

export const RepoRefSchema = z.object({
  owner: z.string().describe("GitHub owner or organization."),
  repo: z.string().describe("GitHub repository name."),
});

export const LocalOrRemoteRepoSchema = z.union([
  RepoRefSchema,
  z.object({ localPath: z.string().describe("Absolute path to a local clone.") }),
]);
