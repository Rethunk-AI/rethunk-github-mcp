import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { classifyError, getOctokit, parallelApi } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";

export interface LabelInput {
  name: string;
  color: string;
  description?: string;
}

export interface LabelsSyncResult {
  created: string[];
  updated: string[];
  deleted: string[];
  skipped: string[];
}

export function registerLabelsSyncTool(server: FastMCP): void {
  server.addTool({
    name: "labels_sync",
    description:
      "Synchronize labels in a GitHub repository. Creates new labels, updates existing ones, and optionally deletes extra labels not in the provided list.",
    annotations: { readOnlyHint: false },
    parameters: z.object({
      owner: z.string().describe("GitHub owner or organization."),
      repo: z.string().describe("GitHub repository name."),
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
    }),
    execute: async (args) => {
      try {
        const octokit = getOctokit();
        const { owner, repo, labels, deleteExtra } = args;

        // Fetch existing labels
        const existingResponse = await octokit.issues.listLabelsForRepo({
          owner,
          repo,
          per_page: 100,
        });
        const existingLabels = new Map(
          (existingResponse.data || []).map((label) => [label.name.toLowerCase(), label]),
        );

        const result: LabelsSyncResult = {
          created: [],
          updated: [],
          deleted: [],
          skipped: [],
        };

        const providedNames = new Set(labels.map((l) => l.name.toLowerCase()));

        // Create or update labels in parallel
        await parallelApi(labels, async (label) => {
          const existing = existingLabels.get(label.name.toLowerCase());
          const normalizedColor = label.color.replace(/^#/, "");

          if (existing) {
            // Check if update is needed
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
              result.updated.push(label.name);
            } else {
              result.skipped.push(label.name);
            }
          } else {
            // Create new label
            await octokit.issues.createLabel({
              owner,
              repo,
              name: label.name,
              color: normalizedColor,
              ...(label.description ? { description: label.description } : {}),
            });
            result.created.push(label.name);
          }
        });

        // Delete extra labels if requested (in parallel)
        if (deleteExtra) {
          const labelsToDelete = Array.from(existingLabels.entries()).filter(
            ([lowerName]) => !providedNames.has(lowerName),
          );
          await parallelApi(labelsToDelete, async ([, label]) => {
            await octokit.issues.deleteLabel({
              owner,
              repo,
              name: label.name,
            });
            result.deleted.push(label.name);
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
