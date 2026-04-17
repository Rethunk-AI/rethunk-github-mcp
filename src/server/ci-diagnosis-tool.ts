import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond } from "./json.js";
import { FormatSchema, RepoRefSchema } from "./schemas.js";

interface FailedStep {
  name: string;
  log: string;
}

interface FailedJob {
  name: string;
  conclusion: string;
  failedSteps: FailedStep[];
}

interface DiagnosisResult {
  runId: number;
  workflow: string;
  conclusion: string;
  branch: string;
  url: string;
  triggerCommit: { sha7: string; message: string; author: string };
  failedJobs: FailedJob[];
}

/** Tail-truncate: keep the LAST maxLines (failures are at the bottom). */
function tailTruncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `... [${lines.length - maxLines} lines above truncated]\n${lines.slice(-maxLines).join("\n")}`;
}

export function registerCiDiagnosisTool(server: FastMCP): void {
  server.addTool({
    name: "ci_diagnosis",
    description:
      "Diagnose CI failures: finds the relevant workflow run, extracts failed job " +
      "logs (truncated), and shows the trigger commit. Answers 'why is CI red?' " +
      "without navigating the Actions UI.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      ref: z.string().optional().describe("Branch name or SHA. Used to find the latest run."),
      prNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("PR number. Finds runs for the PR head."),
      runId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Specific workflow run ID to diagnose."),
      maxLogLines: z.number().int().min(10).max(500).optional().default(150),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo } = args;

      try {
        const octokit = getOctokit();

        // --- Resolve the workflow run ---
        type WorkflowRun = Awaited<ReturnType<typeof octokit.actions.getWorkflowRun>>["data"];
        let run: WorkflowRun | undefined;

        if (args.runId) {
          const res = await octokit.actions.getWorkflowRun({
            owner,
            repo,
            run_id: args.runId,
          });
          run = res.data;
        } else if (args.prNumber) {
          const pr = await octokit.pulls.get({ owner, repo, pull_number: args.prNumber });
          const res = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            head_sha: pr.data.head.sha,
            per_page: 1,
          });
          run = res.data.workflow_runs[0];
        } else if (args.ref) {
          const res = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            branch: args.ref,
            per_page: 5,
          });
          run =
            res.data.workflow_runs.find((r) => r.conclusion === "failure") ??
            res.data.workflow_runs[0];
        } else {
          const res = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            status: "failure" as const,
            per_page: 1,
          });
          run = res.data.workflow_runs[0];
        }

        if (!run) return jsonRespond({ error: "no_ci_runs", owner, repo });

        // --- Get jobs ---
        const jobsRes = await octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: run.id,
          filter: "latest",
        });

        const allJobs = jobsRes.data.jobs;
        const failed = allJobs.filter((j) => j.conclusion === "failure");
        const jobsToAnalyze = failed.length > 0 ? failed : allJobs;

        // --- Fetch logs for each job ---
        const failedJobs: FailedJob[] = [];
        for (const job of jobsToAnalyze) {
          let logText = "[logs unavailable]";
          try {
            const logRes = await octokit.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: job.id,
            });
            logText = tailTruncate(String(logRes.data), args.maxLogLines);
          } catch {
            // logs expired or unavailable
          }
          failedJobs.push({
            name: job.name,
            conclusion: job.conclusion ?? "unknown",
            failedSteps: [{ name: "logs", log: logText }],
          });
        }

        const result: DiagnosisResult = {
          runId: run.id,
          workflow: run.name ?? "unknown",
          conclusion: run.conclusion ?? "unknown",
          branch: run.head_branch ?? "unknown",
          url: run.html_url,
          triggerCommit: {
            sha7: run.head_sha.substring(0, 7),
            message: run.head_commit?.message ?? "unknown",
            author: run.head_commit?.author?.name ?? "unknown",
          },
          failedJobs,
        };

        if (args.format === "json") return jsonRespond(result);

        // Markdown
        const lines: string[] = [
          `# CI Diagnosis: ${owner}/${repo}`,
          "",
          `**Run:** #${result.runId} (${result.workflow}) — ${result.conclusion}`,
          `**Branch:** ${result.branch}`,
          `**Trigger:** \`${result.triggerCommit.sha7}\` ${result.triggerCommit.message} — ${result.triggerCommit.author}`,
          `**URL:** ${result.url}`,
          "",
        ];

        if (failedJobs.length === 0) {
          lines.push("No failed jobs found.");
        } else {
          lines.push("## Failed Jobs", "");
          for (const job of failedJobs) {
            lines.push(`### ${job.name} (${job.conclusion})`, "");
            for (const step of job.failedSteps) {
              lines.push(`#### ${step.name}`, "", "```", step.log, "```", "");
            }
          }
        }

        return lines.join("\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonRespond({ error: "ci_diagnosis_failed", owner, repo, message: msg });
      }
    },
  });
}
