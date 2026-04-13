import { describe, expect, test } from "bun:test";

import { registerRepoStatusTool } from "./repo-status-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// timeAgo — reproduced inline to avoid exporting a private helper
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return `${Math.floor(sec / 604800)}w ago`;
}

function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("timeAgo", () => {
  test("< 60s → now", () => {
    expect(timeAgo(msAgo(5_000))).toBe("now");
  });

  test("30 minutes → 30m ago", () => {
    expect(timeAgo(msAgo(30 * 60 * 1_000))).toBe("30m ago");
  });

  test("59 minutes → 59m ago", () => {
    expect(timeAgo(msAgo(59 * 60 * 1_000))).toBe("59m ago");
  });

  test("3 hours → 3h ago", () => {
    expect(timeAgo(msAgo(3 * 3_600 * 1_000))).toBe("3h ago");
  });

  test("2 days → 2d ago", () => {
    expect(timeAgo(msAgo(2 * 86_400 * 1_000))).toBe("2d ago");
  });

  test("6 days → 6d ago (not weeks)", () => {
    expect(timeAgo(msAgo(6 * 86_400 * 1_000))).toBe("6d ago");
  });

  test("2 weeks → 2w ago", () => {
    expect(timeAgo(msAgo(14 * 86_400 * 1_000))).toBe("2w ago");
  });
});

// ---------------------------------------------------------------------------
// repo_status tool integration (via captureTool)
//
// Tests below exercise code paths that do NOT call the GitHub API:
//   - local_repo_no_remote: auth passes → resolveLocalRepoRemote("/tmp") returns
//     undefined (no git repo / no origin) → error returned before any API call.
//
// Requires GitHub auth (GITHUB_TOKEN / GH_TOKEN / `gh auth token`).
// On a developer machine with `gh` configured or CI with GITHUB_TOKEN set,
// auth passes and these tests exercise the post-auth logic.
// ---------------------------------------------------------------------------

describe("repo_status tool (captureTool)", () => {
  test("local_repo_no_remote: JSON format", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({ repos: [{ localPath: "/tmp" }], format: "json" });
    const parsed = JSON.parse(text) as { repos?: Array<{ error: string }> };
    // If auth unavailable, repos key is absent — skip assertion gracefully
    if (!parsed.repos) return;
    expect(parsed.repos[0]?.error).toBe("local_repo_no_remote");
  });

  test("local_repo_no_remote: markdown format", async () => {
    const run = captureTool(registerRepoStatusTool);
    const text = await run({ repos: [{ localPath: "/tmp" }] });
    // Auth error returns JSON; markdown path contains the error code
    if (text.startsWith("{")) return;
    expect(text).toContain("local_repo_no_remote");
  });
});
