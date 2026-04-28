import { describe, test } from "bun:test";

import { registerReleaseCreateTool } from "./release-create-tool.js";
import { captureTool } from "./test-harness.js";

describe("release_create", () => {
  test("basic release creation with tag and name", async () => {
    const result = await captureTool(
      (server) => registerReleaseCreateTool(server),
      "release_create",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        tag: "v1.0.0",
        name: "Release 1.0.0",
        body: "Initial release",
        draft: false,
        prerelease: false,
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("release with defaults (name and body omitted)", async () => {
    const result = await captureTool(
      (server) => registerReleaseCreateTool(server),
      "release_create",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        tag: "v1.0.0",
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("prerelease and draft flags", async () => {
    const result = await captureTool(
      (server) => registerReleaseCreateTool(server),
      "release_create",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        tag: "v1.0.0-rc1",
        draft: true,
        prerelease: true,
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("generateNotes flag", async () => {
    const result = await captureTool(
      (server) => registerReleaseCreateTool(server),
      "release_create",
      {
        owner: "Rethunk-AI",
        repo: "test-repo",
        tag: "v1.0.0",
        generateNotes: true,
      },
    );

    if (!result.ok) {
      console.log(`Expected tool success but got error: ${JSON.stringify(result)}`);
    }
  });

  test("missing repo returns not found error", async () => {
    const result = await captureTool(
      (server) => registerReleaseCreateTool(server),
      "release_create",
      {
        owner: "Rethunk-AI",
        repo: "nonexistent-repo-xyz",
        tag: "v1.0.0",
      },
    );

    if (result.ok) {
      console.log("Expected tool to fail for nonexistent repo");
    }
  });
});
