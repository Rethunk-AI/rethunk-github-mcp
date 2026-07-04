import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";

export interface LabelInput {
  name: string;
  color: string;
  description?: string;
}

export interface LabelsSyncFailure {
  name: string;
  action: "create" | "update" | "delete";
  error: string;
}

export interface LabelsSyncResult {
  created: string[];
  updated: string[];
  deleted: string[];
  skipped: string[];
  failures: LabelsSyncFailure[];
  dryRun?: boolean;
}

export function registerLabelsSyncTool(server: FastMCP): void {
  server.addTool({
    name: "labels_sync",
    description:
      "Synchronize labels in a GitHub repository. Creates new labels, updates existing ones, and optionally deletes extra labels not in the provided list.",
    annotations: { readOnlyHint: false },
    parameters: z.object({
      owner: z.string().describe("Owner."),
      repo: z.string().describe("Repo."),
      labels: z
        .array(
          z.object({
            name: z.string().describe("Label name."),
            color: z.string().describe("Label color (hex code without #, e.g., 'ffffff')."),
            description: z.string().optional().describe("Label description."),
          }),
        )
        .describe("Array of labels to sync to the repository."),
      deleteExtra: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, delete labels not in the provided list."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview only; returns the planned change without mutating."),
    }),
    execute: async (args) => {
      // gateAuth before try so auth errors are not swallowed by the catch
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      try {
        const octokit = getOctokit();
        const { owner, repo, labels, deleteExtra, dryRun } = args;

        // Fetch ALL existing labels using pagination (fixes cap at 100)
        const existingRaw = await octokit.paginate(octokit.issues.listLabelsForRepo, {
          owner,
          repo,
          per_page: 100,
        });
        const existingLabels = new Map(
          existingRaw.map((label) => [label.name.toLowerCase(), label]),
        );

        const result: LabelsSyncResult = {
          created: [],
          updated: [],
          deleted: [],
          skipped: [],
          failures: [],
        };

        const providedNames = new Set(labels.map((l) => l.name.toLowerCase()));

        if (dryRun) {
          // Compute planned changes without executing any mutations
          for (const label of labels) {
            const existing = existingLabels.get(label.name.toLowerCase());
            const normalizedColor = label.color.replace(/^#/, "");

            if (existing) {
              const needsUpdate =
                existing.color.toLowerCase() !== normalizedColor.toLowerCase() ||
                (label.description && existing.description !== label.description) ||
                (!label.description && existing.description);

              if (needsUpdate) {
                result.updated.push(label.name);
              } else {
                result.skipped.push(label.name);
              }
            } else {
              result.created.push(label.name);
            }
          }

          if (deleteExtra) {
            for (const [lowerName, label] of existingLabels) {
              if (!providedNames.has(lowerName)) {
                result.deleted.push(label.name);
              }
            }
          }

          return jsonRespond({ ...result, dryRun: true });
        }

        // Execute create/update operations with Promise.allSettled (partial failure safe)
        const createUpdateOps = labels.map(async (label) => {
          const existing = existingLabels.get(label.name.toLowerCase());
          const normalizedColor = label.color.replace(/^#/, "");

          if (existing) {
            const needsUpdate =
              existing.color.toLowerCase() !== normalizedColor.toLowerCase() ||
              (label.description && existing.description !== label.description) ||
              (!label.description && existing.description);

            if (needsUpdate) {
              await octokit.issues.updateLabel({
                owner,
                repo,
                name: label.name,
                color: normalizedColor,
                ...(label.description ? { description: label.description } : {}),
              });
              return { action: "update" as const, name: label.name };
            }
            return { action: "skip" as const, name: label.name };
          }

          await octokit.issues.createLabel({
            owner,
            repo,
            name: label.name,
            color: normalizedColor,
            ...(label.description ? { description: label.description } : {}),
          });
          return { action: "create" as const, name: label.name };
        });

        const createUpdateResults = await Promise.allSettled(createUpdateOps);
        createUpdateResults.forEach((r, i) => {
          if (r.status === "fulfilled") {
            if (r.value.action === "update") result.updated.push(r.value.name);
            else if (r.value.action === "create") result.created.push(r.value.name);
            else result.skipped.push(r.value.name);
          } else {
            // Determine what action was attempted
            const label = labels[i];
            const labelName = label?.name ?? `label[${i}]`;
            const existing = label ? existingLabels.get(label.name.toLowerCase()) : undefined;
            const action = existing ? ("update" as const) : ("create" as const);
            result.failures.push({
              name: labelName,
              action,
              error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            });
          }
        });

        // Delete extra labels if requested
        if (deleteExtra) {
          const labelsToDelete = Array.from(existingLabels.entries()).filter(
            ([lowerName]) => !providedNames.has(lowerName),
          );

          const deleteOps = labelsToDelete.map(async ([, label]) => {
            await octokit.issues.deleteLabel({
              owner,
              repo,
              name: label.name,
            });
            return label.name;
          });

          const deleteResults = await Promise.allSettled(deleteOps);
          deleteResults.forEach((r, i) => {
            if (r.status === "fulfilled") {
              result.deleted.push(r.value);
            } else {
              const labelName = labelsToDelete[i]?.[1]?.name ?? "unknown";
              result.failures.push({
                name: labelName,
                action: "delete" as const,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              });
            }
          });
        }

        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[labels_sync] Failed to sync labels for ${args.owner}/${args.repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
