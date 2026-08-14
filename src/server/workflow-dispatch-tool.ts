import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import { classifyError, getOctokit, withRetry, withTimeout } from "./github-client.js";
import { errorRespond, jsonRespond, spreadDefined } from "./json.js";
import { RepoRefSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowDispatchResult {
  message: string;
  dryRun?: boolean;
  runId?: number;
  url?: string;
  status?: string;
  conclusion?: string;
  timedOut?: boolean;
}

type OctokitClient = ReturnType<typeof getOctokit>;
type WorkflowRun = Awaited<ReturnType<OctokitClient["actions"]["getWorkflowRun"]>>["data"];

// ---------------------------------------------------------------------------
// Watch mode — poll for the dispatched run, then for its completion
// ---------------------------------------------------------------------------

/** Poll interval floor for watch mode; short so a just-dispatched run is found quickly. */
const WATCH_POLL_BASE_DELAY_MS = 2000;
/** Upper bound on attempts — withTimeout (via `timeoutSec`) is the real deadline; this only
 * guards against an unbounded loop if a caller passes a huge timeoutSec. */
const WATCH_MAX_RETRIES = 50;

/**
 * Signals "not ready yet" to withRetry by reusing the same `_isTimeout` flag
 * classifyError already treats as a retryable UPSTREAM_FAILURE. This lets withRetry's
 * existing backoff loop drive polling instead of a hand-rolled sleep loop.
 */
function notReadyYet(message: string): never {
  throw Object.assign(new Error(message), { _isTimeout: true });
}

/** Poll workflow runs for the one this dispatch created, until found or `timeoutMs` elapses. */
async function waitForRunStart(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  workflowId: string | number,
  ref: string,
  sinceMs: number,
  timeoutMs: number,
): Promise<WorkflowRun | undefined> {
  try {
    return await withTimeout(
      withRetry(
        async () => {
          const res = await octokit.actions.listWorkflowRuns({
            owner,
            repo,
            workflow_id: workflowId,
            branch: ref,
            per_page: 5,
          });
          const match = res.data.workflow_runs.find(
            (r) => new Date(r.created_at).getTime() >= sinceMs,
          );
          if (!match) notReadyYet("Dispatched run not yet visible.");
          return match;
        },
        { maxRetries: WATCH_MAX_RETRIES, baseDelayMs: WATCH_POLL_BASE_DELAY_MS },
      ),
      timeoutMs,
      "waiting for dispatched run to appear",
    );
  } catch {
    return undefined;
  }
}

/** Poll a known run until `status: "completed"` or `timeoutMs` elapses. */
async function waitForRunCompletion(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  runId: number,
  timeoutMs: number,
): Promise<{ run: WorkflowRun | undefined; timedOut: boolean }> {
  let lastKnown: WorkflowRun | undefined;
  try {
    const run = await withTimeout(
      withRetry(
        async () => {
          const res = await octokit.actions.getWorkflowRun({ owner, repo, run_id: runId });
          lastKnown = res.data;
          if (res.data.status !== "completed") notReadyYet("Run not completed yet.");
          return res.data;
        },
        { maxRetries: WATCH_MAX_RETRIES, baseDelayMs: WATCH_POLL_BASE_DELAY_MS },
      ),
      timeoutMs,
      "waiting for run to complete",
    );
    return { run, timedOut: false };
  } catch {
    return { run: lastKnown, timedOut: true };
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerWorkflowDispatchTool(server: FastMCP): void {
  server.addTool({
    name: "workflow_dispatch",
    description:
      "Trigger a GitHub Actions workflow via workflow_dispatch event. GitHub returns 204 with no body, so run ID must be polled separately if needed.",
    annotations: { readOnlyHint: false },
    parameters: RepoRefSchema.extend({
      workflow: z.string().describe("Workflow file name (e.g. 'ci.yml') or workflow ID."),
      ref: z.string().describe("Branch or tag to run the workflow on (e.g. 'main')."),
      inputs: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional workflow input parameters as key-value pairs."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview only; returns the planned change without mutating."),
      watch: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, poll for the dispatched run and wait for it to complete before returning runId/url/status/conclusion.",
        ),
      timeoutSec: z
        .number()
        .int()
        .min(5)
        .max(300)
        .optional()
        .default(60)
        .describe(
          "Max seconds to wait in watch mode before giving up (5-300). Ignored unless watch is true.",
        ),
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const { owner, repo, workflow, ref, inputs, dryRun, watch, timeoutSec } = args;

      // Only coerce to Number when the string is purely numeric (e.g. a workflow ID integer).
      // The GitHub API accepts filename strings directly without coercion.
      const workflowId = /^\d+$/.test(workflow) ? Number(workflow) : workflow;

      if (dryRun) {
        const dryRunResult: WorkflowDispatchResult = {
          message: `[dry-run] Would dispatch workflow '${workflow}' on ${owner}/${repo}:${ref} with workflow_id=${JSON.stringify(workflowId)}${inputs ? ` and inputs ${JSON.stringify(inputs)}` : ""}.`,
          dryRun: true,
        };
        return jsonRespond(dryRunResult);
      }

      try {
        const octokit = getOctokit();

        // Captured before dispatch so the run-lookup below can't miss a run created
        // in the (small) window between this timestamp and the dispatch call landing.
        const dispatchedAtMs = Date.now();

        await octokit.actions.createWorkflowDispatch({
          owner,
          repo,
          workflow_id: workflowId,
          ref,
          inputs: inputs ?? {},
        });

        const message = `Workflow '${workflow}' dispatched successfully on ${owner}/${repo}:${ref}. GitHub returns 204 (no run ID); poll workflow runs to find the dispatched run.`;

        if (!watch) {
          const result: WorkflowDispatchResult = { message };
          return jsonRespond(result);
        }

        const deadlineMs = timeoutSec * 1000;
        const watchStartedAt = Date.now();

        const startedRun = await waitForRunStart(
          octokit,
          owner,
          repo,
          workflowId,
          ref,
          dispatchedAtMs,
          deadlineMs,
        );
        if (!startedRun) {
          const result: WorkflowDispatchResult = {
            message: `${message} Watch mode timed out after ${timeoutSec}s before the dispatched run became visible.`,
            timedOut: true,
          };
          return jsonRespond(result);
        }

        const remainingMs = Math.max(0, deadlineMs - (Date.now() - watchStartedAt));
        const { run: completedRun, timedOut } = await waitForRunCompletion(
          octokit,
          owner,
          repo,
          startedRun.id,
          remainingMs,
        );
        const finalRun = completedRun ?? startedRun;

        const result: WorkflowDispatchResult = {
          message: timedOut
            ? `${message} Watch mode timed out after ${timeoutSec}s before the run completed.`
            : `Workflow '${workflow}' dispatched and completed on ${owner}/${repo}:${ref}.`,
          runId: finalRun.id,
          url: finalRun.html_url,
          ...spreadDefined("status", finalRun.status ?? undefined),
          ...spreadDefined("conclusion", finalRun.conclusion ?? undefined),
          ...(timedOut ? { timedOut: true } : {}),
        };
        return jsonRespond(result);
      } catch (err) {
        console.error(
          `[workflow_dispatch] Failed to dispatch workflow '${workflow}' for ${owner}/${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
        return errorRespond(classifyError(err));
      }
    },
  });
}
