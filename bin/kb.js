#!/usr/bin/env node
// bin/kb.js — CLI entry point
// Commands: start, stop, mcp, register, ingest <path>, search <query>, status

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start:    () => import('../src/server.js').then(m => m.start()),
  stop:     () => import('../src/cli/stop.js').then(m => m.stop()),
  mcp:      () => import('../src/mcp.js').then(m => m.start()),
  register: () => import('../src/cli/register.js').then(m => m.register()),
  ingest:   () => import('../src/cli/ingest-cli.js').then(m => m.ingest(args[0])),
  search:   () => import('../src/cli/search-cli.js').then(m => m.search(args.join(' '))),
  status:   () => import('../src/cli/status.js').then(m => m.status()),
  vault:    () => {
    const sub = args[0];
    if (sub === 'reindex') return import('../src/cli/vault-cli.js').then(m => m.vaultReindex());
    console.log('Usage: kb vault reindex');
    process.exit(1);
  },
};

if (!command || !commands[command]) {
  console.log(`Usage: kb <command>

Commands:
  start              Start the dashboard server (default :3838)
  stop               Stop the running server
  mcp                Start MCP stdio server (used by AI tools)
  register           Register MCP server with Claude Code
  ingest <path>      Ingest a file or directory
  search <query>     Search documents
  status             Show stats and server status
  vault reindex      Reindex Obsidian vault
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
