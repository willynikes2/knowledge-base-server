// tests/mcp-http.test.js — what the HTTP MCP server tells clients about its tools
// Runs the real server over an in-memory transport, against an isolated HOME.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const HOME = mkdtempSync(join(tmpdir(), 'kb-mcp-http-test-'));
process.env.HOME = HOME;
process.env.BETTER_AUTH_URL = 'http://localhost:3838';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

let createMcpServer;
let MCP_SCOPES;

/** Send one JSON-RPC request and return the raw result, exactly as it goes over the wire. */
async function listToolsRaw() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const replies = new Map();
  const waiters = new Map();
  clientSide.onmessage = (message) => {
    if (waiters.has(message.id)) waiters.get(message.id)(message);
    else replies.set(message.id, message);
  };
  await clientSide.start();
  const request = (id, method, params) => new Promise((resolve) => {
    waiters.set(id, resolve);
    clientSide.send({ jsonrpc: '2.0', id, method, params });
  });
  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { result } = await request(2, 'tools/list', {});
  await clientSide.close();
  return result.tools;
}

describe('HTTP MCP tool list', () => {
  before(async () => {
    ({ createMcpServer } = await import('../src/mcp-http.js'));
    ({ MCP_SCOPES } = await import('../src/auth-oauth.js'));
  });

  after(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it('declares OAuth on every tool, so ChatGPT offers sign-in instead of calling anonymously', async () => {
    const tools = await listToolsRaw();
    assert.ok(tools.some(t => t.name === 'kb_search'), 'kb_search is missing from the tool list');
    const expected = [{ type: 'oauth2', scopes: MCP_SCOPES }];
    for (const tool of tools) {
      assert.deepEqual(tool.securitySchemes, expected, `${tool.name} has no top-level securitySchemes`);
      assert.deepEqual(tool._meta?.securitySchemes, expected, `${tool.name} has no _meta.securitySchemes`);
    }
  });

  it('never marks a tool as callable without authentication', async () => {
    for (const tool of await listToolsRaw()) {
      const schemes = [...(tool.securitySchemes ?? []), ...(tool._meta?.securitySchemes ?? [])];
      assert.ok(!schemes.some(s => s.type === 'noauth'), `${tool.name} is marked noauth`);
    }
  });

  it('keeps each tool\'s name, description and input schema', async () => {
    const search = (await listToolsRaw()).find(t => t.name === 'kb_search');
    assert.ok(search.description.length > 0);
    assert.equal(search.inputSchema.type, 'object');
    assert.ok('query' in search.inputSchema.properties);
  });
});
