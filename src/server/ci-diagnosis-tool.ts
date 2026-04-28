import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit } from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema, MaxLogLinesSchema, RepoRefSchema } from "./schemas.js";
import { isFailed, sha7, tailTruncate } from "./utils.js";

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

export function registerCiDiagnosisTool(server: FastMCP): void {
  server.addTool({
    name: "ci_diagnosis",
    description:
      "Diagnose CI failures: fetches the relevant workflow run, extracts failed job logs, shows trigger commit. " +
      "Pass runId, prNumber, or ref to target a specific run.",
    annotations: { readOnlyHint: true },
    parameters: RepoRefSchema.extend({
      ref: z.string().optional().describe("Branch or SHA to find the latest run."),
      prNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("PR number; finds runs for its head SHA."),
      runId: z.number().int().positive().optional().describe("Exact run ID to fetch."),
      maxLogLines: MaxLogLinesSchema.describe("Max lines per job log tail."),
      grepLog: z
        .string()
        .optional()
        .describe("Regex applied to each log; only matching lines are returned."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo } = args;

      try {
        const octokit = getOctokit();

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
            res.data.workflow_runs.find((r) => isFailed(r.conclusion)) ?? res.data.workflow_runs[0];
        } else {
          const res = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            status: "failure" as const,
            per_page: 1,
          });
          run = res.data.workflow_runs[0];
        }

        if (!run) {
          return errorRespond(
            mkError("NO_CI_RUNS", `No workflow runs found for ${owner}/${repo}.`, {
              suggestedFix:
                "Verify the ref/PR has triggered a workflow, or pass an explicit runId.",
            }),
          );
        }

        const jobsRes = await octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: run.id,
          filter: "latest",
        });

        const allJobs = jobsRes.data.jobs;
        const failed = allJobs.filter((j) => isFailed(j.conclusion));
        const jobsToAnalyze = failed.length > 0 ? failed : allJobs;

        const grepRe = args.grepLog ? new RegExp(args.grepLog, "i") : undefined;

        const failedJobs: FailedJob[] = [];
        for (const job of jobsToAnalyze) {
          let logText = "[logs unavailable]";
          try {
            const logRes = await octokit.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: job.id,
            });
            let raw = String(logRes.data);
            if (grepRe) {
              raw = raw
                .split("\n")
                .filter((l) => grepRe.test(l))
                .join("\n");
            }
            logText = tailTruncate(raw, args.maxLogLines);
          } catch (err) {
            // logs expired or unavailable
            console.error(
              `[ci_diagnosis] Failed to download logs for job ${job.id}:`,
              err instanceof Error ? err.message : String(err),
            );
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
            sha7: sha7(run.head_sha),
            message: run.head_commit?.message ?? "unknown",
            author: run.head_commit?.author?.name ?? "unknown",
          },
          failedJobs,
        };

        if (args.format === "json") return jsonRespond(result);

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
      } catch (err) {
        console.error(
          `[ci_diagnosis] Failed to diagnose CI for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
