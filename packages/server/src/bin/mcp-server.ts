#!/usr/bin/env node
/**
 * sn-mcp MCP server (stdio). Register it with a local MCP client; see docs/INSTALL.md.
 * stdout is the MCP channel, so diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BridgeClient } from '../bridge/client.js';
import { createMcpServer } from '../mcp/server.js';

console.log = (...args: unknown[]) => console.error(...args);

const bridge = new BridgeClient({
  label: {
    name: process.env.SN_MCP_CLIENT_NAME ?? 'sn-mcp server',
    pid: process.pid,
    cwd: process.cwd(),
  },
});
const server = createMcpServer(bridge);
await server.connect(new StdioServerTransport());

const shutdown = () => {
  bridge.close();
  void server.close().finally(() => process.exit(0));
};
process.stdin.once('end', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
