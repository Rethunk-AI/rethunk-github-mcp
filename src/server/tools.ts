import type { FastMCP } from "fastmcp";

import { registerCiDiagnosisTool } from "./ci-diagnosis-tool.js";
import { registerEcosystemActivityTool } from "./ecosystem-activity-tool.js";
import { registerModulePinHintTool } from "./module-pin-hint-tool.js";
import { registerMyWorkTool } from "./my-work-tool.js";
import { registerOrgPulseTool } from "./org-pulse-tool.js";
import { registerPinDriftTool } from "./pin-drift-tool.js";
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
  registerPinDriftTool(server);
  registerEcosystemActivityTool(server);
  registerModulePinHintTool(server);
}
