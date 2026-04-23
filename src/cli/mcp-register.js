import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'gemini'];
export const KB_MCP_SERVER_NAME = 'knowledge-base';
export const KB_ENTRYPOINT_PATH = fileURLToPath(new URL('../../bin/kb.js', import.meta.url));
export const KB_MCP_SERVER_CONFIG = {
  command: process.execPath,
  args: [KB_ENTRYPOINT_PATH, 'mcp'],
};

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export function getAgentConfigPath(agent, homeDir = homedir()) {
  if (agent === 'claude') return join(homeDir, '.claude.json');
  if (agent === 'codex') return join(homeDir, '.codex', 'mcp.json');
  if (agent === 'gemini') return join(homeDir, '.gemini', 'mcp.json');
  throw new Error(`Unsupported agent: ${agent}`);
}

export function parseRegisterArgs(args = []) {
  const flag = args.find(arg => arg.startsWith('--agents='));
  if (!flag) return [...SUPPORTED_AGENTS];

  const agents = flag
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map(agent => agent.trim().toLowerCase())
    .filter(Boolean);

  const invalid = agents.filter(agent => !SUPPORTED_AGENTS.includes(agent));
  if (invalid.length > 0) {
    throw new Error(`Unsupported agent(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_AGENTS.join(', ')}`);
  }
  if (agents.length === 0) {
    throw new Error('No agents provided. Example: kb register --agents=claude,codex');
  }
  return [...new Set(agents)];
}

export function registerAgents(agents, homeDir = homedir()) {
  return agents.map(agent => {
    const path = getAgentConfigPath(agent, homeDir);
    mkdirSync(join(path, '..'), { recursive: true });
    const config = readJson(path);
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[KB_MCP_SERVER_NAME] = KB_MCP_SERVER_CONFIG;
    writeFileSync(path, JSON.stringify(config, null, 2));
    return { agent, path };
  });
}
