import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastMCP } from "fastmcp";

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function gitTopLevel(localPath: string): string | null {
  try {
    return execFileSync("git", ["-C", localPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function listFileRoots(server: FastMCP): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const session of server.sessions) {
    for (const root of session.roots ?? []) {
      const path = uriToPath(root.uri);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function normalizeLocalPath(localPath: string): string {
  const absolute = resolve(localPath);
  return gitTopLevel(absolute) ?? absolute;
}

export function resolveOptionalLocalPath(
  server: FastMCP,
  explicitLocalPath?: string,
): string | undefined {
  const explicit = explicitLocalPath?.trim();
  if (explicit) return normalizeLocalPath(explicit);
  const primaryRoot = listFileRoots(server)[0];
  return primaryRoot ? normalizeLocalPath(primaryRoot) : undefined;
}
