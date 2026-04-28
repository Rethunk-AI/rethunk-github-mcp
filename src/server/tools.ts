import type { FastMCP } from "fastmcp";

import { registerChangelogDraftTool } from "./changelog-draft-tool.js";
import { registerCiDiagnosisTool } from "./ci-diagnosis-tool.js";
import { registerEcosystemActivityTool } from "./ecosystem-activity-tool.js";
import { registerIssueFromTemplateTool } from "./issue-from-template-tool.js";
import { registerModulePinHintTool } from "./module-pin-hint-tool.js";
import { registerMyWorkTool } from "./my-work-tool.js";
import { registerOrgPulseTool } from "./org-pulse-tool.js";
import { registerPinDriftTool } from "./pin-drift-tool.js";
import { registerPrCommentBatchTool } from "./pr-comment-batch-tool.js";
import { registerPrCreateTool } from "./pr-create-tool.js";
import { registerPrPreflightTool } from "./pr-preflight-tool.js";
import { registerReleaseCreateTool } from "./release-create-tool.js";
import { registerReleaseReadinessTool } from "./release-readiness-tool.js";
import { registerRepoStatusTool } from "./repo-status-tool.js";
import { registerWorkflowDispatchTool } from "./workflow-dispatch-tool.js";

export function registerRethunkGitHubTools(server: FastMCP): void {
  registerRepoStatusTool(server);
  registerMyWorkTool(server);
  registerPrPreflightTool(server);
  registerPrCommentBatchTool(server);
  registerPrCreateTool(server);
  registerIssueFromTemplateTool(server);
  registerReleaseReadinessTool(server);
  registerReleaseCreateTool(server);
  registerCiDiagnosisTool(server);
  registerOrgPulseTool(server);
  registerPinDriftTool(server);
  registerEcosystemActivityTool(server);
  registerModulePinHintTool(server);
  registerChangelogDraftTool(server);
  registerWorkflowDispatchTool(server);
}
