/**
 * pfsense-mcp - MCP server for pfSense
 *
 * Bidirectional AI control of your firewall with NEVERHANG reliability
 * and A.L.A.N. persistent learning.
 *
 * @author Claude (claude@arktechnwa.com) + Meldrey
 * @license MIT
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SERVER_NAME = "pfsense-mcp";
const SERVER_VERSION = "0.0.1";

async function main() {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // TODO: Phase A1 - Core infrastructure
  // - pfSense API client
  // - Authentication
  // - NEVERHANG v2.0
  // - A.L.A.N. persistence

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
