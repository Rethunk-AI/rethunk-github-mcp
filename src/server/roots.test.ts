import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastMCP } from "fastmcp";

import { listFileRoots, resolveOptionalLocalPath } from "./roots.js";

const tmpPaths: string[] = [];

afterEach(() => {
  while (tmpPaths.length > 0) {
    const path = tmpPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tmpPaths.push(path);
  return path;
}

function fakeServer(roots: string[]): FastMCP {
  return {
    sessions: [
      {
        roots: roots.map((uri) => ({ uri })),
      },
    ],
  } as unknown as FastMCP;
}

describe("MCP workspace roots", () => {
  test("lists unique file roots and ignores non-file roots", () => {
    const a = tmpDir("github-root-a-");
    const b = tmpDir("github-root-b-");
    const server = fakeServer([
      `file://${a}`,
      "vscode-remote://ssh-remote/ignored",
      `file://${a}`,
      `file://${b}`,
    ]);
    expect(listFileRoots(server)).toEqual([a, b]);
  });

  test("normalizes workspace subdirectories to git top-level", () => {
    const repo = tmpDir("github-root-repo-");
    execFileSync("git", ["-C", repo, "init", "--initial-branch=main"], { stdio: "ignore" });
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(resolveOptionalLocalPath(fakeServer([`file://${nested}`]))).toBe(repo);
  });

  test("explicit localPath takes precedence over MCP roots", () => {
    const root = tmpDir("github-root-default-");
    const explicit = tmpDir("github-root-explicit-");
    expect(resolveOptionalLocalPath(fakeServer([`file://${root}`]), explicit)).toBe(explicit);
  });
});
