import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const MCP_COMMAND = process.execPath;
const MCP_ARGS = [
  resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/kb.js'),
  'mcp',
];

export function register() {
  const claudeJsonPath = join(homedir(), '.claude.json');

  let config = {};
  if (existsSync(claudeJsonPath)) {
    config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
  }

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['knowledge-base'] = {
    command: MCP_COMMAND,
    args: MCP_ARGS,
  };

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
  console.log('MCP server registered in ~/.claude.json');
  console.log('Restart Claude Code to activate the knowledge-base tools.');
  console.log('Tools available: kb_search, kb_list, kb_read, kb_ingest');
}
