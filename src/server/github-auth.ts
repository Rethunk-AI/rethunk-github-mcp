import { execFileSync } from "node:child_process";

interface AuthOk {
  ok: true;
  token: string;
}

interface AuthError {
  ok: false;
  body: Record<string, unknown>;
}

type AuthResult = AuthOk | AuthError;

let cached: AuthResult | undefined;

/**
 * Resolve a GitHub personal access token.
 *
 * Priority: GITHUB_TOKEN env → GH_TOKEN env → `gh auth token` subprocess.
 * Result is cached after first call.
 */
export function gateAuth(): AuthResult {
  if (cached) return cached;

  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken) {
    cached = { ok: true, token: envToken };
    return cached;
  }

  // Fallback: try `gh auth token`
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      cached = { ok: true, token };
      return cached;
    }
  } catch {
    // gh not installed or not authenticated — fall through
  }

  cached = {
    ok: false,
    body: {
      error: "github_auth_missing",
      hint: "Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
    },
  };
  return cached;
}

/** Clear the cached auth result (useful for testing). */
export function resetAuthCache(): void {
  cached = undefined;
}
