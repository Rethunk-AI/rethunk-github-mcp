import { z } from "zod";

/** Max repos per `repo_status` / `ecosystem_activity` request (aligned with rethunk-git inventory default). */
export const MAX_REPOS_PER_REQUEST = 64;

export const FormatSchema: z.ZodDefault<
  z.ZodOptional<z.ZodEnum<{ json: "json"; markdown: "markdown" }>>
> = z.enum(["markdown", "json"]).optional().default("json");

export const RepoRefSchema: z.ZodObject<{ owner: z.ZodString; repo: z.ZodString }, z.core.$strip> =
  z.object({
    owner: z.string().describe("Owner."),
    repo: z.string().describe("Repo."),
  });

export const LocalOrRemoteRepoSchema: z.ZodUnion<
  readonly [
    z.ZodObject<{ owner: z.ZodString; repo: z.ZodString }, z.core.$strip>,
    z.ZodObject<{ localPath: z.ZodString }, z.core.$strip>,
  ]
> = z.union([
  RepoRefSchema,
  z.object({ localPath: z.string().describe("Absolute path to a local clone.") }),
]);

/** Max commits to compare/fetch (shared by release_readiness and changelog_draft). */
export const MaxCommitsSchema: z.ZodDefault<z.ZodOptional<z.ZodNumber>> = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .default(50);

/** Max log lines to fetch per failing CI job (shared by ci_diagnosis and pr_preflight). */
export const MaxLogLinesSchema: z.ZodDefault<z.ZodOptional<z.ZodNumber>> = z
  .number()
  .int()
  .min(10)
  .max(500)
  .optional()
  .default(50);
