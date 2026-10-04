#!/usr/bin/env node
// bin/kb.js — CLI entry point
// Commands: start, stop, mcp, register, ingest <path>, search <query>, status, setup, bus-send, bus-inbox, bus-wait

import '../src/paths.js'; // loads .env from ~/.knowledge-base/.env

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start:    () => import('../src/server.js').then(m => m.start()),
  stop:     () => import('../src/cli/stop.js').then(m => m.stop()),
  mcp:      () => import('../src/mcp.js').then(m => m.start()),
  register: () => import('../src/cli/register.js').then(m => m.register(args)),
  ingest:   () => import('../src/cli/ingest-cli.js').then(m => m.ingest(args[0])),
  search:   () => import('../src/cli/search-cli.js').then(m => m.search(args.join(' '))),
  'token-compare': () => import('../src/cli/token-compare.js').then(m => m.tokenCompare(args)),
  status:   () => import('../src/cli/status.js').then(m => m.status()),
  'bus-send': () => import('../src/bus/cli.js').then(m => m.runBusSendCli(args)),
  'bus-inbox': () => import('../src/bus/cli.js').then(m => m.runBusInboxCli(args)),
  'bus-wait': () => import('../src/bus/cli.js').then(m => m.runBusWaitCli(args)),
  'capture-x': () => import('../src/capture/x-bookmarks.js').then(m => {
    const bookmarksPath = args[0] || (process.env.HOME + '/knowledgebase/x_bookmarks.md');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
    const result = m.captureXBookmarks(bookmarksPath, vaultPath);
    console.log(`X bookmarks: ${result.created} created, ${result.skipped} skipped (${result.total} total)`);
  }),
  classify: () => {
    const dryRun = args.includes('--dry-run');
    return import('../src/classify/processor.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.processNewClippings(vaultPath, { dryRun });
      console.log(`\nClassified: ${result.processed}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  summarize: () => {
    const dryRun = args.includes('--dry-run');
    const limitFlag = args.find(a => a.startsWith('--limit='));
    const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 0;
    return import('../src/classify/summarizer.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.summarizeUnsummarized(vaultPath, { dryRun, limit });
      console.log(`\nSummarized: ${result.summarized}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  setup:    () => import('../src/cli/setup.js').then(m => m.setup(args)),
  'safety-check': () => {
    const action = args.join(' ');
    if (!action) { console.error('Usage: kb safety-check <action description>'); process.exit(1); }
    return import('../src/safety/review.js').then(async m => {
      const result = await m.reviewDestructiveAction(action);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safe) process.exit(1);
    });
  },
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
  register           Register MCP server with Claude/Codex/Gemini (--agents=claude,codex)
  ingest <path>      Ingest a file or directory
  search <query>     Search documents
  token-compare      Compare raw-doc vs KB-summary token cost
  status             Show stats and server status
  bus-send           Send a local message bus message
  bus-inbox          Read messages from a local message bus channel
  bus-wait           Long-poll a local message bus channel
  vault reindex      Reindex Obsidian vault
  classify           Auto-classify new clippings/inbox notes (--dry-run to preview)
  summarize          Add AI summaries to docs without them (--dry-run, --limit=N)
  capture-x [path]   Capture X/Twitter bookmarks to vault
  setup              Interactive setup wizard (--auto for agent mode)
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
