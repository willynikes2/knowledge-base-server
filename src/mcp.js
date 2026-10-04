import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startBusPushNotifier } from './bus/notifier.js';
import { registerBusResources } from './bus/resources.js';
import { getToolDefinitions } from './tools.js';

export async function start() {
  const server = new McpServer({
    name: 'knowledge-base',
    version: '1.0.0',
  });

  // Register all tools from shared definitions
  for (const tool of getToolDefinitions()) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }
  registerBusResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  startBusPushNotifier(server);
}

// Allow direct execution
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('mcp.js')) {
  start().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
