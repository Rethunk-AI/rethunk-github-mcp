/**
 * Lightweight test harness for MCP tool execute handlers.
 *
 * FastMCP does not expose a way to inject a custom transport, so the full
 * MCP client/server stack cannot be wired up in tests without stdio or HTTP.
 * Instead, we use a duck-typed fake server that satisfies the FastMCP interface
 * just enough for tool registration: it captures `addTool` calls so we can
 * invoke `execute` directly, bypassing the transport layer entirely.
 *
 * Context passed to execute is a no-op stub — none of the current tools
 * use the context object (logging, progress, etc.).
 *
 * Usage:
 *   const run = captureTool(registerRepoStatusTool);
 *   const result = await run({ repos: [...], format: "json" });
 *   // result is a JSON-parseable string or markdown string
 */

import type { FastMCP } from "fastmcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

type ExecuteFn = (args: AnyRecord, context: AnyRecord) => Promise<string | AnyRecord | undefined>;

interface CapturedTool {
  name: string;
  execute: ExecuteFn;
}

// Stub context — no tool currently uses context
const STUB_CONTEXT: AnyRecord = {
  log: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
  reportProgress: async () => undefined,
  session: undefined,
};

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

function makeFakeServer(): { server: FastMCP; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    sessions: [],
    addTool(tool: { name: string; execute: ExecuteFn }) {
      tools.push({ name: tool.name, execute: tool.execute });
    },
  } as unknown as FastMCP;
  return { server, tools };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register one tool and return a caller that invokes its execute handler.
 * The returned function accepts tool args and returns the raw result as a string.
 *
 * Most tools require GitHub auth (GITHUB_TOKEN / GH_TOKEN / `gh auth token`).
 * Tests that exercise post-auth paths should run in environments where auth
 * is available (developer machine with `gh` configured, or CI with GITHUB_TOKEN).
 */
export function captureTool(
  register: (server: FastMCP) => void,
  toolName?: string,
): (args: AnyRecord) => Promise<string> {
  const { server, tools } = makeFakeServer();
  register(server);

  const pick = toolName ? tools.find((t) => t.name === toolName) : tools[0];

  if (!pick) {
    throw new Error(
      `captureTool: no tool captured${toolName ? ` named "${toolName}"` : ""}. Did you forget to call register?`,
    );
  }

  return async (args: AnyRecord): Promise<string> => {
    const result = await pick.execute(args, STUB_CONTEXT);
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  };
}
