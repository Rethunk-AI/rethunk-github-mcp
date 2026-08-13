import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { gateAuth } from "./github-auth.js";
import {
  classifyError,
  fetchLatestSemverTag,
  fetchPRMetadata,
  getOctokit,
  graphqlQuery,
  parallelApi,
  resolveLocalRepoRemote,
} from "./github-client.js";
import {
  errorRespond,
  jsonRespond,
  type McpErrorEnvelope,
  mkError,
  mkLocalRepoNoRemote,
  truncateText,
} from "./json.js";
import { resolveOptionalLocalPath } from "./roots.js";
import {
  FormatSchema,
  LocalOrRemoteRepoSchema,
  MAX_REPOS_PER_REQUEST,
  MaxCommitsSchema,
} from "./schemas.js";
import {
  type CheckNode,
  extractPRNumbers,
  firstLine,
  normalizeFailedChecks,
  sha7,
} from "./utils.js";

interface CommitForRelease {
  sha7: string;
  message: string;
  author: string;
  date: string;
  pr?: { number: number; title: string; labels: string[] };
}

export interface ArtifactIntegrity {
  verdict: "ok" | "warn" | "skip";
  details: string;
  missingFromChecksum: string[];
  checksumAsset?: string;
}

interface ReleaseReadinessSuccess {
  owner: string;
  repo: string;
  base: string;
  head: string;
  aheadBy: number;
  truncatedCount?: number;
  headCi: { status: string; failedChecks: { name: string; conclusion: string }[] };
  commits: CommitForRelease[];
  stats: { additions: number; deletions: number; changedFiles: number };
  artifactIntegrity: ArtifactIntegrity;
  error?: undefined;
}

interface ReleaseReadinessFailure {
  owner: string;
  repo: string;
  error: McpErrorEnvelope;
}

type ReleaseReadinessResult = ReleaseReadinessSuccess | ReleaseReadinessFailure;

async function fetchHeadCI(
  owner: string,
  repo: string,
  headRef: string,
): Promise<{ status: string; failedChecks: { name: string; conclusion: string }[] }> {
  const query = `query($owner:String!,$repo:String!,$expr:String!){
    repository(owner:$owner,name:$repo){
      object(expression:$expr){
        ...on Commit{statusCheckRollup{state contexts(first:20){nodes{...on CheckRun{name conclusion}...on StatusContext{context state}}}}}
      }
    }
  }`;

  try {
    const data = await graphqlQuery<{
      repository: {
        object: {
          statusCheckRollup: { state: string; contexts: { nodes: CheckNode[] } } | null;
        } | null;
      };
    }>(query, { owner, repo, expr: headRef });

    const rollup = data.repository.object?.statusCheckRollup;
    if (!rollup) return { status: "not_configured", failedChecks: [] };

    const failed = normalizeFailedChecks(rollup.contexts.nodes);

    return { status: rollup.state.toLowerCase(), failedChecks: failed };
  } catch (err) {
    console.error(
      `[fetchHeadCI] Failed to fetch CI status for ${owner}/${repo} @ ${headRef}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { status: "error_fetching", failedChecks: [] };
  }
}

/**
 * Check artifact integrity for a release.
 * - If no assets: verdict "skip"
 * - If checksum asset exists: parse it and verify all other assets are listed
 * - If assets but no checksum: verdict "warn"
 */
async function checkArtifactIntegrity(
  owner: string,
  repo: string,
  releaseId: number,
  tag: string,
): Promise<ArtifactIntegrity> {
  try {
    const octokit = getOctokit();

    // Fetch all assets for the release
    const assetsRes = await octokit.repos.listReleaseAssets({
      owner,
      repo,
      release_id: releaseId,
      per_page: 100,
    });

    const assets = assetsRes.data;
    if (assets.length === 0) {
      return {
        verdict: "skip",
        details: "No release assets",
        missingFromChecksum: [],
      };
    }

    // Look for a checksum file (SHA256SUMS, checksums.txt, sha256sums, etc.)
    const checksumAsset = assets.find((a) => /sha256|checksums|integrity/i.test(a.name));

    if (!checksumAsset) {
      return {
        verdict: "warn",
        details: "No checksum asset found",
        missingFromChecksum: assets.map((a) => a.name),
      };
    }

    // Download and parse the checksum file
    try {
      const checksumRes = await octokit.repos.getReleaseAsset({
        owner,
        repo,
        asset_id: checksumAsset.id,
        headers: { Accept: "application/octet-stream" },
      });

      // The response.data should be a string (the file content)
      const checksumContent = String(checksumRes.data);

      // Parse the checksum file — extract asset names
      // Common formats: "sha256 filename" or "sha256  filename" (with 1 or 2 spaces)
      const checksumLines = checksumContent.split("\n").filter((line) => line.trim().length > 0);

      const checksummedAssets = new Set<string>();
      for (const line of checksumLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          // Last part is typically the filename
          const filename = parts[parts.length - 1];
          if (filename) {
            checksummedAssets.add(filename);
          }
        }
      }

      // Find assets not in the checksum file
      const missingFromChecksum = assets
        .filter((a) => a.name !== checksumAsset.name)
        .filter((a) => !checksummedAssets.has(a.name))
        .map((a) => a.name);

      const verdict = missingFromChecksum.length === 0 ? "ok" : "warn";
      const details =
        verdict === "ok"
          ? "All assets covered by checksum file"
          : `${missingFromChecksum.length} asset(s) not in checksum file`;

      return {
        verdict,
        details,
        missingFromChecksum,
        checksumAsset: checksumAsset.name,
      };
    } catch (parseErr) {
      console.error(
        `[checkArtifactIntegrity] Failed to download/parse checksum file ${checksumAsset.name} for ${owner}/${repo} release ${tag}:`,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      return {
        verdict: "warn",
        details: `Failed to parse checksum file: ${parseErr instanceof Error ? parseErr.message : "unknown error"}`,
        missingFromChecksum: assets.filter((a) => a.name !== checksumAsset.name).map((a) => a.name),
        checksumAsset: checksumAsset.name,
      };
    }
  } catch (err) {
    console.error(
      `[checkArtifactIntegrity] Failed to check artifact integrity for ${owner}/${repo} release ${tag}:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      verdict: "warn",
      details: `Error checking integrity: ${err instanceof Error ? err.message : "unknown error"}`,
      missingFromChecksum: [],
    };
  }
}

function formatOneReleaseReadiness(r: ReleaseReadinessSuccess): string {
  const truncatedCount = r.truncatedCount ?? 0;
  const aheadSuffix =
    truncatedCount > 0
      ? ` — list truncated, ${truncatedCount} commit${truncatedCount === 1 ? "" : "s"} not shown`
      : "";
  const lines: string[] = [
    `## ${r.owner}/${r.repo}`,
    "",
    `${r.base} → ${r.head} (${r.aheadBy} commits ahead${aheadSuffix})`,
  ];

  const ciState =
    r.headCi.status === "success"
      ? "CI: passing"
      : r.headCi.status === "not_configured"
        ? "CI: not configured"
        : r.headCi.status === "pending" || r.headCi.status === "expected"
          ? "CI: pending"
          : `CI: failing (${r.headCi.failedChecks.map((c) => c.name).join(", ")})`;
  lines.push(ciState);

  if (r.artifactIntegrity.verdict === "ok") {
    lines.push("Artifacts: integrity verified");
  } else if (r.artifactIntegrity.verdict === "warn") {
    const missing =
      r.artifactIntegrity.missingFromChecksum.length > 0
        ? ` (${r.artifactIntegrity.missingFromChecksum.length} uncovered)`
        : "";
    lines.push(`Artifacts: ⚠ ${r.artifactIntegrity.details}${missing}`);
  } else {
    lines.push("Artifacts: skipped");
  }

  lines.push("");

  if (r.commits.length === 0) {
    lines.push("*(no commits)*");
  } else {
    lines.push("## Unreleased Commits");
    for (const c of r.commits) {
      const msg = truncateText(c.message, 72);
      const pr = c.pr ? ` [#${c.pr.number}]` : "";
      lines.push(`- \`${c.sha7}\` ${msg}${pr} — ${c.author}`);
    }
  }

  lines.push(
    "",
    `+${r.stats.additions} −${r.stats.deletions} across ${r.stats.changedFiles} files`,
  );

  return lines.join("\n");
}

function formatReleaseReadinessMarkdown(results: ReleaseReadinessResult[]): string {
  return results
    .map((r) =>
      r.error
        ? `## ${r.owner}/${r.repo}\nError (${r.error.code}): ${r.error.message}`
        : formatOneReleaseReadiness(r),
    )
    .join("\n\n");
}

export function registerReleaseReadinessTool(server: FastMCP): void {
  server.addTool({
    name: "release_readiness",
    description:
      "Unreleased-commit scope report: compares base..head, lists commits with PRs, CI status on head, and diff stats. " +
      `Omit \`base\` to auto-pick the latest semver tag. Accepts up to ${MAX_REPOS_PER_REQUEST} repos; omit repos to use the active MCP workspace root.`,
    annotations: { readOnlyHint: true },
    parameters: z.object({
      repos: z
        .array(LocalOrRemoteRepoSchema)
        .min(1)
        .max(MAX_REPOS_PER_REQUEST)
        .optional()
        .describe("Repos to query."),
      base: z
        .string()
        .optional()
        .describe("Base ref (tag/branch). Omit to auto-pick the latest semver tag."),
      head: z.string().optional().describe("Head ref; defaults to default branch."),
      maxCommits: MaxCommitsSchema,
      format: FormatSchema,
    }),
    execute: async (args) => {
      const auth = gateAuth();
      if (!auth.ok) return errorRespond(auth.envelope);

      const defaultLocalPath = resolveOptionalLocalPath(server);
      const repoRefs = args.repos ?? (defaultLocalPath ? [{ localPath: defaultLocalPath }] : []);
      if (repoRefs.length === 0) {
        return errorRespond(
          mkError("VALIDATION", "No repository target provided and no MCP workspace root found.", {
            suggestedFix:
              "Open a workspace folder or pass repos: [{ owner, repo }] / [{ localPath }].",
          }),
        );
      }

      const octokit = getOctokit();
      const { maxCommits } = args;

      const results = await parallelApi<(typeof repoRefs)[number], ReleaseReadinessResult>(
        repoRefs,
        async (repoRef) => {
          let owner: string;
          let repo: string;

          if ("localPath" in repoRef) {
            const localPath =
              resolveOptionalLocalPath(server, repoRef.localPath) ?? repoRef.localPath;
            const resolved = resolveLocalRepoRemote(localPath);
            if (!resolved) {
              return { owner: "unknown", repo: localPath, error: mkLocalRepoNoRemote(localPath) };
            }
            owner = resolved.owner;
            repo = resolved.repo;
          } else {
            owner = repoRef.owner;
            repo = repoRef.repo;
          }

          let head = args.head;
          let base = args.base;

          try {
            if (!head) {
              const repoData = await octokit.repos.get({ owner, repo });
              head = repoData.data.default_branch;
            }

            if (!base) {
              const fetchedTag = await fetchLatestSemverTag(owner, repo);
              if (fetchedTag === null) {
                return {
                  owner,
                  repo,
                  error: mkError(
                    "NOT_FOUND",
                    `No semver tag found in ${owner}/${repo}; pass base explicitly.`,
                    { suggestedFix: "Create a tag (e.g. v0.1.0) or pass base explicitly." },
                  ),
                };
              }
              base = fetchedTag;
            }

            const cmp = await octokit.repos.compareCommitsWithBasehead({
              owner,
              repo,
              basehead: `${base}...${head}`,
            });

            const aheadBy = cmp.data.ahead_by;
            const rawCommits = cmp.data.commits.slice(0, maxCommits);
            // The compare endpoint caps at 250 commits; maxCommits may also truncate the list.
            // Track how many commits were not shown so we can surface that to the caller.
            const truncatedCount = aheadBy - rawCommits.length;

            const allPRNumbers = new Set<number>();
            for (const c of rawCommits) {
              for (const n of extractPRNumbers(c.commit.message)) allPRNumbers.add(n);
            }

            const prMap = await fetchPRMetadata(owner, repo, [...allPRNumbers]);
            const ciStatus = await fetchHeadCI(owner, repo, head);

            const commits: CommitForRelease[] = rawCommits.map((c) => {
              const prNums = extractPRNumbers(c.commit.message);
              const firstPR = prNums[0] !== undefined ? prMap.get(prNums[0]) : undefined;
              return {
                sha7: sha7(c.sha),
                message: truncateText(firstLine(c.commit.message), 72),
                author: c.commit.author?.name ?? c.author?.login ?? "unknown",
                date: c.commit.author?.date ?? "",
                ...(firstPR
                  ? {
                      pr: {
                        number: firstPR.number,
                        title: firstPR.title,
                        labels: firstPR.labels.nodes.map((l) => l.name),
                      },
                    }
                  : {}),
              };
            });

            const stats = {
              additions: (cmp.data.files ?? []).reduce((s, f) => s + f.additions, 0),
              deletions: (cmp.data.files ?? []).reduce((s, f) => s + f.deletions, 0),
              changedFiles: cmp.data.files?.length ?? 0,
            };

            // Check artifact integrity if the base ref is a release tag
            let artifactIntegrity: ArtifactIntegrity;
            try {
              const releaseRes = await octokit.repos.getReleaseByTag({ owner, repo, tag: base });
              artifactIntegrity = await checkArtifactIntegrity(
                owner,
                repo,
                releaseRes.data.id,
                base,
              );
            } catch (_err) {
              // base is not a release tag, or API error — skip integrity check
              artifactIntegrity = {
                verdict: "skip",
                details: "Base ref is not a release tag",
                missingFromChecksum: [],
              };
            }

            return {
              owner,
              repo,
              base,
              head,
              aheadBy,
              truncatedCount: truncatedCount > 0 ? truncatedCount : undefined,
              headCi: ciStatus,
              commits,
              stats,
              artifactIntegrity,
            };
          } catch (err) {
            console.error(
              `[release_readiness] Failed to generate release readiness report for ${owner}/${repo}:`,
              err instanceof Error ? err.message : String(err),
            );
            return { owner, repo, error: classifyError(err) };
          }
        },
      );

      if (args.format === "json") return jsonRespond({ repos: results });

      return formatReleaseReadinessMarkdown(results);
    },
  });
}
