#!/usr/bin/env node
// End-to-end smoke test of the *published package*, run from a project where
// the packed tarball was installed (`npm install ./knowledge-base-server-*.tgz`).
// Exercises the installed `kb`, `bus-send` and `bus-inbox` bins against an
// isolated HOME, so it catches missing files in package.json "files", broken
// bin entries and native-module install problems that unit tests can't see.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const BIN = join(process.cwd(), 'node_modules', '.bin');
const HOME = mkdtempSync(join(tmpdir(), 'kb-smoke-home-'));
const PORT = 38000 + Math.floor(Math.random() * 1000);
const API_KEY = 'ci-smoke-key';
const env = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  KB_BUS_HOME: join(HOME, 'bus'),
  KB_PORT: String(PORT),
  KB_PASSWORD: 'ci-smoke-password',
  KB_API_KEY_CLAUDE: API_KEY,
  BETTER_AUTH_SECRET: 'ci-smoke-secret-0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: `http://localhost:${PORT}`,
};

function step(name) {
  console.log(`\n▶ ${name}`);
}

function rpc(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function mcpHandshake() {
  step('kb mcp: initialize, list tools and resource templates, exit on stdin close');
  const input = [
    rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1.0.0' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    rpc(2, 'tools/list'),
    rpc(3, 'resources/templates/list'),
    rpc(4, 'tools/call', { name: 'kb_search', arguments: { query: 'smoke' } }),
    '',
  ].join('\n');

  const result = spawnSync(join(BIN, 'kb'), ['mcp'], { input, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error?.code, undefined, `kb mcp did not exit after stdin closed (${result.error?.code})`);
  assert.equal(result.status, 0, `kb mcp exited ${result.status}\n${result.stderr}`);

  const replies = new Map(result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const msg = JSON.parse(line);
    return [msg.id, msg];
  }));
  for (const id of [1, 2, 3, 4]) {
    assert.ok(replies.has(id), `no reply to request ${id}`);
    assert.equal(replies.get(id).error, undefined, `request ${id} failed: ${JSON.stringify(replies.get(id).error)}`);
  }

  const tools = replies.get(2).result.tools.map(t => t.name);
  for (const name of ['kb_search', 'kb_read', 'kb_ingest', 'kb_export', 'kb_restore', 'kb_ingest_image', 'bus_send', 'bus_inbox']) {
    assert.ok(tools.includes(name), `tool ${name} missing from tools/list`);
  }
  const templates = replies.get(3).result.resourceTemplates.map(t => t.uriTemplate);
  assert.ok(templates.includes('bus://{channel}'), 'bus://{channel} resource template missing');
  console.log(`  ${tools.length} tools, templates: ${templates.join(', ')}`);
}

function busRoundTrip() {
  step('bus-send / bus-inbox CLI round trip');
  const send = spawnSync(join(BIN, 'bus-send'), ['ci:smoke', 'hello from ci', '--sender', 'ci'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(send.status, 0, send.stderr);
  const inbox = spawnSync(join(BIN, 'bus-inbox'), ['ci:smoke'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(inbox.status, 0, inbox.stderr);
  const { messages } = JSON.parse(inbox.stdout);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'hello from ci');
  assert.equal(messages[0].sender, 'ci');
}

async function waitForHealth(server, getLog) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`kb start exited early (${server.exitCode})\n${getLog()}`);
    try {
      const res = await fetch(`http://localhost:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`kb start never became healthy\n${getLog()}`);
}

async function httpServer() {
  step('kb start: health, API key + OAuth enforcement, OAuth discovery, ingest + search round trip');
  const server = spawn(join(BIN, 'kb'), ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${PORT}/api/v1`;
  const auth = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };

  try {
    await waitForHealth(server, () => log);

    assert.equal((await fetch(`${base}/stats`)).status, 401, 'unauthenticated request was not rejected');
    assert.equal((await fetch(`${base}/stats`, { headers: { 'X-API-Key': 'wrong' } })).status, 403, 'bad API key was not rejected');
    assert.equal((await fetch(`${base}/stats`, { headers: { Authorization: 'Bearer not-a-real-token' } })).status, 401, 'bogus OAuth token was not rejected');

    const discovery = await fetch(`http://localhost:${PORT}/.well-known/oauth-authorization-server`);
    assert.equal(discovery.status, 200, 'OAuth discovery endpoint failed');
    const metadata = await discovery.json();
    assert.ok(metadata.token_endpoint && metadata.authorization_endpoint, 'OAuth discovery metadata incomplete');

    const ingest = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'CI smoke note', content: 'zebrafish telemetry checksum', tags: ['ci'] }),
    });
    assert.equal(ingest.status, 201, await ingest.text());

    const search = await fetch(`${base}/search?q=zebrafish`, { headers: auth });
    assert.equal(search.status, 200);
    const { results } = await search.json();
    assert.ok(results.some(r => r.title === 'CI smoke note'), 'ingested note not found by search');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 10000);
      server.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

try {
  await mcpHandshake();
  busRoundTrip();
  await httpServer();
  console.log('\n✔ package smoke test passed');
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
