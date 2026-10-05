#!/usr/bin/env node
// End-to-end smoke test of the *published package*, run from a project where
// the packed tarball was installed (`npm install ./knowledge-base-server-*.tgz`).
// Exercises the installed `kb`, `bus-send` and `bus-inbox` bins against an
// isolated HOME, so it catches missing files in package.json "files", broken
// bin entries and native-module install problems that unit tests can't see.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const BIN = join(process.cwd(), 'node_modules', '.bin');
const HOME = mkdtempSync(join(tmpdir(), 'kb-smoke-home-'));
const PORT = 38000 + Math.floor(Math.random() * 1000);
const API_KEY = 'ci-smoke-key';
const OWNER = { email: 'owner@ci.test', password: 'ci smoke owner password' };
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

function addOwner() {
  step('kb auth add-user: provision the account that approves OAuth clients');
  const add = spawnSync(join(BIN, 'kb'), ['auth', 'add-user', OWNER.email, '--password-stdin'], { env, input: `${OWNER.password}\n`, encoding: 'utf8', timeout: 30000 });
  assert.equal(add.status, 0, add.stderr);
}

// A top-level browser navigation. fetch() always sends `sec-fetch-mode: cors`,
// which makes better-auth answer with JSON instead of the 302 a browser gets.
function navigate(url, headers = {}) {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...headers } }, res => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
  });
}

// What the Claude web connector does: get challenged, discover, register,
// send the user through sign-in and consent, exchange the code, call MCP.
async function connectorOAuthFlow() {
  const origin = `http://localhost:${PORT}`;
  const mcpUrl = `${origin}/mcp`;
  const json = { 'Content-Type': 'application/json', Origin: origin };
  const initialize = rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1.0.0' } });
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

  const challenge = await fetch(mcpUrl, { method: 'POST', headers: mcpHeaders, body: initialize });
  assert.equal(challenge.status, 401, 'unauthenticated MCP request was not rejected');
  const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') || '')?.[1];
  assert.ok(resourceMetadataUrl, '401 from /mcp has no RFC 9728 resource_metadata challenge');

  const resourceMeta = await (await fetch(resourceMetadataUrl)).json();
  assert.equal(resourceMeta.resource, mcpUrl, 'protected resource metadata names the wrong resource');
  const issuer = resourceMeta.authorization_servers[0];
  const asMetaRes = await fetch(`${origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`);
  assert.equal(asMetaRes.status, 200, 'RFC 8414 authorization server metadata not served');
  const meta = await asMetaRes.json();
  assert.equal(meta.issuer, issuer);

  const reg = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_name: 'CI Connector', redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(reg.status, 201, `dynamic client registration failed: ${await reg.clone().text()}`);
  const { client_id } = await reg.json();

  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'outsider@ci.test', password: 'Password123!', name: 'x' }) });
  assert.ok(signUp.status >= 400, `public sign-up is open (${signUp.status})`);

  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: json, body: JSON.stringify(OWNER) });
  assert.equal(signIn.status, 200, 'owner could not sign in');
  const cookie = signIn.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: 'https://client.example.test/callback', scope: 'openid profile email offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'ci', resource: mcpUrl,
  });
  const authz = await navigate(`${meta.authorization_endpoint}?${query}`, { Cookie: cookie });
  assert.equal(authz.status, 302, `authorize did not redirect the browser (${authz.status})`);
  const consentUrl = new URL(authz.location || '', origin);
  assert.equal(consentUrl.pathname, '/consent', `authorize did not lead to consent: ${consentUrl}`);
  assert.equal((await fetch(consentUrl)).status, 200, 'consent page not served');

  const consent = await fetch(`${origin}/api/auth/oauth2/consent`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }) });
  const code = new URL((await consent.json()).url).searchParams.get('code');
  assert.ok(code, 'consent did not return an authorization code');

  const tokenRes = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://client.example.test/callback', client_id, code_verifier: verifier, resource: mcpUrl }),
  });
  assert.equal(tokenRes.status, 200, `token exchange failed: ${await tokenRes.clone().text()}`);
  const { access_token } = await tokenRes.json();
  const bearer = { Authorization: `Bearer ${access_token}` };

  const mcp = await fetch(mcpUrl, { method: 'POST', headers: { ...mcpHeaders, ...bearer }, body: initialize });
  assert.equal(mcp.status, 200, `MCP initialize with the OAuth token failed (${mcp.status})`);
  const body = await mcp.text();
  assert.match(body, /"serverInfo"/, 'MCP initialize returned no serverInfo');
  assert.equal((await fetch(`${origin}/api/v1/stats`, { headers: bearer })).status, 200, 'OAuth token rejected by the REST API');
  console.log('  connector flow: challenge -> discovery -> register -> sign-in -> consent -> token -> MCP initialize ok');
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
  step('kb start: health, API key auth, MCP connector OAuth flow, ingest + search round trip');
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

    await connectorOAuthFlow();

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
  addOwner();
  await httpServer();
  console.log('\n✔ package smoke test passed');
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
