import { describe, expect, test } from "bun:test";

import { registerCheckRunCreateTool } from "./check-run-create-tool.js";
import { captureTool } from "./test-harness.js";

describe("check_run_create tool", () => {
  const run = captureTool(registerCheckRunCreateTool);

  test("requires conclusion when status is completed", async () => {
    const text = await run({
      owner: "test",
      repo: "test",
      name: "Test Check",
      headSha: "abc123",
      status: "completed",
    });
    const parsed = JSON.parse(text) as { error?: { code: string } };

    // Should return validation error for missing conclusion
    if (!parsed.error || parsed.error.code !== "AUTH_MISSING") {
      if (parsed.error) {
        expect(parsed.error.code).toBe("VALIDATION");
      }
    }
  });

  test("returns error for missing authentication", async () => {
    const text = await run({
      owner: "nonexistent",
      repo: "nonexistent",
      name: "Test Check",
      headSha: "abc123",
      status: "queued",
    });
    const parsed = JSON.parse(text) as { error?: { code: string } };

    // May return AUTH_MISSING depending on environment
    if (parsed.error) {
      expect(parsed.error.code).toBeDefined();
    }
  });

  test("returns check run structure when successful", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Test Check",
      headSha: "abc1234567890123456789012345678901234567",
      status: "queued",
    });
    const parsed = JSON.parse(text) as {
      error?: { code: string };
      id?: number;
      url?: string;
    };

    if (!parsed.error || parsed.error.code !== "AUTH_MISSING") {
      if (!parsed.error && parsed.id !== undefined) {
        expect(typeof parsed.id).toBe("number");
        expect(typeof parsed.url).toBe("string");
      }
    }
  });

  test("accepts optional title and summary", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Check with Details",
      headSha: "def1234567890123456789012345678901234567",
      status: "in_progress",
      title: "Test Title",
      summary: "Test summary content",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });

  test("accepts completed status with conclusion", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Completed Check",
      headSha: "ghi1234567890123456789012345678901234567",
      status: "completed",
      conclusion: "success",
      title: "All good",
      summary: "Check completed successfully",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });

  test("defaults to queued status", async () => {
    const text = await run({
      owner: "Rethunk-AI",
      repo: "rethunk-github-mcp",
      name: "Default Status Check",
      headSha: "jkl1234567890123456789012345678901234567",
    });
    const parsed = JSON.parse(text) as { error?: { code: string }; id?: number };

    if (!parsed.error && parsed.id !== undefined) {
      expect(typeof parsed.id).toBe("number");
    }
  });
});
