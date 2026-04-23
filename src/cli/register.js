import { parseRegisterArgs, registerAgents } from './mcp-register.js';

export function register(args = []) {
  const agents = parseRegisterArgs(args);
  const results = registerAgents(agents);

  console.log('MCP server registered for:');
  for (const result of results) {
    console.log(`- ${result.agent}: ${result.path}`);
  }
  console.log('');
  console.log('Restart these local agent sessions to activate the updated knowledge-base tools.');
  console.log('Core tools: kb_search, kb_list, kb_read, kb_ingest, ...');
  console.log('Local-only bus tools: bus_send, bus_inbox, bus_wait');
  console.log('Long-lived sessions that cannot restart can still use the CLI fallback: bus-send / bus-inbox / bus-wait');
}
