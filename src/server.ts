#!/usr/bin/env node
import { FastMCP } from "fastmcp";

import { readMcpServerVersion } from "./server/json.js";
import { registerRethunkGitHubTools } from "./server/tools.js";

const server = new FastMCP({
  name: "rethunk-github",
  version: readMcpServerVersion(),
});

registerRethunkGitHubTools(server);

void server.start({ transportType: "stdio" });
