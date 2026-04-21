import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  getOctokit,
  graphqlQuery,
  resolveLocalRepoRemote,
} from "./github-client.js";
import { errorRespond, jsonRespond, mkError } from "./json.js";
import { FormatSchema } from "./schemas.js";

interface ReviewNode {
  author: { login: string };
  state: string;
}

interface CheckContext {
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string;
  state?: string;
}

interface PRPreflightData {
  repository: {
    pullRequest: {
      title: string;
      state: string;
      isDraft: boolean;
      mergeable: string;
      mergeStateStatus: string;
      baseRefName: string;
      headRefName: string;
      reviewDecision: string | null;
      labels: { nodes: { name: string }[] };
      reviews: { nodes: ReviewNode[] };
      reviewRequests: {
        nodes: { requestedReviewer: { login?: string; name?: string } }[];
      };
      commits: {
        nodes: {
          commit: {
            statusCheckRollup: {
              state: string;
              contexts: { nodes: CheckContext[] };
            } | null;
          };
        }[];
      };
    } | null;
  };
}

const PR_PREFLIGHT_QUERY = `
query PRPreflight($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft mergeable mergeStateStatus
      baseRefName headRefName reviewDecision
      labels(first: 20) { nodes { name } }
      reviews(last: 20) { nodes { author { login } state } }
      reviewRequests(first: 10) {
        nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name conclusion status }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Resolve a PR ref that may be a number, a URL, or a "owner/repo#N" slug. */
function parsePrRef(
  ref: string | number | undefined,
  ownerHint: string,
  repoHint: string,
): { owner: string; repo: string; number: number } | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return { owner: ownerHint, repo: repoHint, number: ref };

  // PR URL: https://github.com/owner/repo/pull/N
  const urlM = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(ref);
  if (urlM?.[1] && urlM[2] && urlM[3]) {
    return { owner: urlM[1], repo: urlM[2], number: Number.parseInt(urlM[3], 10) };
  }

  // owner/repo#N slug
  const slugM = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (slugM?.[1] && slugM[2] && slugM[3]) {
    return { owner: slugM[1], repo: slugM[2], number: Number.parseInt(slugM[3], 10) };
  }

  // bare number string
  const n = Number.parseInt(String(ref), 10);
  if (!Number.isNaN(n)) return { owner: ownerHint, repo: repoHint, number: n };

  return undefined;
}

async function checkOnePR(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{
  number: number;
  title: string;
  safe: boolean;
  reasons: string[];
  mergeable: string;
  reviewDecision: string | null;
  reviews: { author: string; state: string }[];
  pendingReviewers: string[];
  ci: { status: string; checks: { name: string; conclusion: string | null; status: string }[] };
  behindBase: number;
  labels: string[];
  conflicts: boolean;
  error?: { code: string; message: string };
}> {
  const octokit = getOctokit();

  const data = await graphqlQuery<PRPreflightData>(PR_PREFLIGHT_QUERY, {
    owner,
    repo,
    number: prNumber,
  });

  const pr = data.repository.pullRequest;
  if (!pr) {
    return {
      number: prNumber,
      title: "",
      safe: false,
      reasons: [`PR ${owner}/${repo}#${prNumber} not found`],
      mergeable: "UNKNOWN",
      reviewDecision: null,
      reviews: [],
      pendingReviewers: [],
      ci: { status: "UNKNOWN", checks: [] },
      behindBase: 0,
      labels: [],
      conflicts: false,
      error: { code: "NOT_FOUND", message: `PR ${owner}/${repo}#${prNumber} not found.` },
    };
  }

  // Behind-base count via REST compare
  let behindBy = 0;
  try {
    const cmp = await octokit.repos.compareCommits({
      owner,
      repo,
      base: pr.baseRefName,
      head: pr.headRefName,
    });
    behindBy = cmp.data.behind_by ?? 0;
  } catch {
    // comparison not available
  }

  // De-duplicate reviews: latest per author
  const reviewMap = new Map<string, ReviewNode>();
  for (const r of pr.reviews.nodes) reviewMap.set(r.author.login, r);
  const reviews = [...reviewMap.values()];

  const pendingReviewers = pr.reviewRequests.nodes
    .map((n) => n.requestedReviewer.login ?? n.requestedReviewer.name ?? "unknown")
    .filter(Boolean);

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const ciStatus = rollup?.state ?? "UNKNOWN";
  const checks = (rollup?.contexts.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "unknown",
    conclusion: c.conclusion ?? c.state ?? null,
    status: c.status ?? c.state ?? "UNKNOWN",
  }));

  const labels = pr.labels.nodes.map((l) => l.name);

  const reasons: string[] = [];
  let safe = true;

  if (pr.state !== "OPEN") {
    safe = false;
    reasons.push(`PR is ${pr.state}`);
  }
  if (pr.isDraft) {
    safe = false;
    reasons.push("PR is a draft");
  }
  if (pr.mergeable === "CONFLICTING") {
    safe = false;
    reasons.push("Has merge conflicts");
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    safe = false;
    const who = reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author.login);
    reasons.push(`Changes requested by ${who.join(", ")}`);
  } else if (pr.reviewDecision !== "APPROVED" && pendingReviewers.length > 0) {
    safe = false;
    reasons.push("Not yet approved");
  }

  const failingChecks = checks.filter(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "failure",
  );
  if (failingChecks.length > 0) {
    safe = false;
    reasons.push(`CI failing: ${failingChecks.map((c) => c.name).join(", ")}`);
  }
  const pendingChecks = checks.filter((c) => c.conclusion === null && c.status !== "COMPLETED");
  if (pendingChecks.length > 0) {
    safe = false;
    reasons.push("CI still running");
  }
  if (behindBy > 0) {
    reasons.push(`${behindBy} commits behind ${pr.baseRefName}`);
  }

  return {
    number: prNumber,
    title: pr.title,
    safe,
    reasons,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    reviews: reviews.map((r) => ({ author: r.author.login, state: r.state })),
    pendingReviewers,
    ci: { status: ciStatus, checks },
    behindBase: behindBy,
    labels,
    conflicts: pr.mergeable === "CONFLICTING",
  };
}

export function registerPrPreflightTool(server: FastMCP): void {
  server.addTool({
    name: "pr_preflight",
    description:
      "Pre-merge safety check: mergeable state, reviews, CI status, behind-base count, and a computed safe-to-merge verdict. " +
      "Pass a single `number` or an array `numbers` to batch-check multiple PRs. " +
      "Accepts owner+repo OR localPath (auto-detects from git remote). " +
      "The `ref` parameter accepts a PR number, GitHub PR URL, or owner/repo#N slug.",
    annotations: { readOnlyHint: true },
    parameters: z.object({
      owner: z.string().optional().describe("GitHub owner. Not required when localPath is set."),
      repo: z.string().optional().describe("GitHub repo name. Not required when localPath is set."),
      localPath: z
        .string()
        .optional()
        .describe("Local clone path; auto-detects owner/repo from git remote."),
      number: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Single PR number (use `numbers` for batch)."),
      numbers: z
        .array(z.number().int().positive())
        .optional()
        .describe("Batch PR numbers to check in one call."),
      ref: z
        .string()
        .optional()
        .describe("PR number, GitHub PR URL, or owner/repo#N slug (alternative to number)."),
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      // Resolve owner/repo
      let owner: string;
      let repo: string;

      if (args.localPath) {
        const resolved = resolveLocalRepoRemote(args.localPath);
        if (!resolved) {
          return errorRespond(
            mkError(
              "LOCAL_REPO_NO_REMOTE",
              `No GitHub origin found for local path ${args.localPath}`,
              { suggestedFix: "Ensure the path is a git clone with a GitHub `origin` remote." },
            ),
          );
        }
        owner = resolved.owner;
        repo = resolved.repo;
      } else if (args.owner && args.repo) {
        owner = args.owner;
        repo = args.repo;
      } else {
        return errorRespond(
          mkError("VALIDATION", "Provide owner+repo or localPath.", {
            suggestedFix: "Pass { owner, repo } or { localPath } parameters.",
          }),
        );
      }

      // Collect PR numbers to check
      let prNumbers: number[] = [];

      if (args.numbers && args.numbers.length > 0) {
        prNumbers = args.numbers;
      } else if (args.number !== undefined) {
        prNumbers = [args.number];
      } else if (args.ref !== undefined) {
        const parsed = parsePrRef(args.ref, owner, repo);
        if (!parsed) {
          return errorRespond(
            mkError("VALIDATION", `Cannot parse PR ref: ${args.ref}`, {
              suggestedFix: "Use a PR number, GitHub PR URL, or owner/repo#N slug.",
            }),
          );
        }
        // If ref contains a different owner/repo, use those
        owner = parsed.owner;
        repo = parsed.repo;
        prNumbers = [parsed.number];
      } else {
        return errorRespond(
          mkError("VALIDATION", "Provide number, numbers, or ref.", {
            suggestedFix: "Pass at least one of: number, numbers[], or ref.",
          }),
        );
      }

      try {
        const results = await Promise.all(
          prNumbers.map((n) =>
            checkOnePR(owner, repo, n).catch((err) => ({
              number: n,
              title: "",
              safe: false,
              reasons: [String(err)],
              mergeable: "UNKNOWN",
              reviewDecision: null,
              reviews: [],
              pendingReviewers: [],
              ci: { status: "UNKNOWN", checks: [] },
              behindBase: 0,
              labels: [],
              conflicts: false,
              error: classifyError(err),
            })),
          ),
        );

        // Unwrap single-PR result to preserve backward compat
        const isBatch = prNumbers.length > 1;

        if (args.format === "json") {
          if (!isBatch) {
            const single = results[0];
            return single ? jsonRespond(single) : jsonRespond({});
          }
          return jsonRespond({ results });
        }

        // Markdown
        const sections = results.map((result) => {
          if (!result) return "";
          const owner2 = owner;
          const repo2 = repo;
          const { safe, reasons, pendingReviewers, labels } = result;
          const verdict = safe ? "Safe to merge" : "NOT safe to merge";
          const blockers = reasons.filter((r) => !r.includes("commits behind"));
          const warnings = reasons.filter((r) => r.includes("commits behind"));

          const failingChecks = result.ci.checks.filter(
            (c) => c.conclusion === "FAILURE" || c.conclusion === "failure",
          );
          const pendingChecks = result.ci.checks.filter(
            (c) => c.conclusion === null && c.status !== "COMPLETED",
          );

          let md = `## PR Preflight: ${owner2}/${repo2}#${result.number}\n\n`;
          md += `**${verdict}**\n\n`;

          if (blockers.length > 0) {
            md += "Blockers:\n";
            for (const b of blockers) md += `- ${b}\n`;
            md += "\n";
          }
          if (warnings.length > 0) {
            md += "Warnings:\n";
            for (const w of warnings) md += `- ${w}\n`;
            md += "\n";
          }

          md += "| Check | Status |\n|-------|--------|\n";

          if (result.reviewDecision === "APPROVED") {
            const who = result.reviews
              .filter((r) => r.state === "APPROVED")
              .map((r) => `${r.author} ok`);
            md += `| Reviews | APPROVED (${who.join(", ")}) |\n`;
          } else if (result.reviewDecision === "CHANGES_REQUESTED") {
            const who = result.reviews
              .filter((r) => r.state === "CHANGES_REQUESTED")
              .map((r) => r.author);
            md += `| Reviews | Changes requested by ${who.join(", ")} |\n`;
          } else {
            md += `| Reviews | Pending (${pendingReviewers.join(", ") || "none"}) |\n`;
          }

          if (failingChecks.length > 0) {
            md += `| CI | ${failingChecks.length}/${result.ci.checks.length} failing |\n`;
          } else if (pendingChecks.length > 0) {
            md += `| CI | Running (${pendingChecks.length}/${result.ci.checks.length}) |\n`;
          } else {
            md += "| CI | Passing |\n";
          }

          md += `| Conflicts | ${result.mergeable === "CONFLICTING" ? "Has conflicts" : "None"} |\n`;
          if (pendingReviewers.length > 0) {
            md += `| Pending reviewers | ${pendingReviewers.join(", ")} |\n`;
          }
          if (labels.length > 0) {
            md += `| Labels | ${labels.join(", ")} |\n`;
          }
          return md;
        });

        return sections.join("\n---\n\n");
      } catch (err) {
        return errorRespond(classifyError(err));
      }
    },
  });
}
