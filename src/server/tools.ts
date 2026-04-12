import type { FastMCP } from "fastmcp";

import { registerCiDiagnosisTool } from "./ci-diagnosis-tool.js";
import { registerMyWorkTool } from "./my-work-tool.js";
import { registerOrgPulseTool } from "./org-pulse-tool.js";
import { registerPrPreflightTool } from "./pr-preflight-tool.js";
import { registerReleaseReadinessTool } from "./release-readiness-tool.js";
import { registerRepoStatusTool } from "./repo-status-tool.js";

export function registerRethunkGitHubTools(server: FastMCP): void {
  registerRepoStatusTool(server);
  registerMyWorkTool(server);
  registerPrPreflightTool(server);
  registerReleaseReadinessTool(server);
  registerCiDiagnosisTool(server);
  registerOrgPulseTool(server);
}
