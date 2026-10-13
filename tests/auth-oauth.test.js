// tests/auth-oauth.test.js — OAuth provider: who can get a token, and what it grants
// Runs the real better-auth instance against an isolated HOME, in-process.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOAuthClient } from './helpers/oauth-flow.js';

const BASE = 'http://localhost:3838';
const HOME = mkdtempSync(join(tmpdir(), 'kb-auth-test-'));
process.env.HOME = HOME;
process.env.BETTER_AUTH_URL = BASE;
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const OWNER = { email: 'owner@example.test', password: 'correct horse battery staple' };

let auth;
let oauth;
let verifyAccessToken;
let mcpChallenge;
let protectedResourceMetadata;
let MCP_SCOPES;

describe('OAuth provider access', () => {
  before(async () => {
    const mod = await import('../src/auth-oauth.js');
    ({ auth, verifyAccessToken, mcpChallenge, protectedResourceMetadata, MCP_SCOPES } = mod);
    assert.deepEqual(await mod.migrateAuthSchema(), [], 'a fresh database has nothing to archive');
    await mod.addUser(OWNER);
    oauth = createOAuthClient(auth, BASE);
  });

  after(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it('rejects public sign-up, so outsiders cannot create an account', async () => {
    const res = await oauth.call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: oauth.jsonHeaders,
      body: JSON.stringify({ email: 'outsider@evil.test', password: 'Password123!', name: 'outsider' }),
    });

    assert.ok(res.status >= 400, `sign-up should be refused, got ${res.status}`);
    const ctx = await auth.$context;
    assert.equal(await ctx.internalAdapter.findUserByEmail('outsider@evil.test'), null, 'outsider account was created');
  });

  it('rejects a wrong password for the provisioned account', async () => {
    const { res } = await oauth.signIn(OWNER.email, 'wrong password');
    assert.ok(res.status >= 400, `sign-in with a wrong password should fail, got ${res.status}`);
  });

  it('sends unauthenticated users to the sign-in page instead of issuing a code', async () => {
    const meta = await (await oauth.call('/api/auth/.well-known/oauth-authorization-server')).json();
    const res = await oauth.call(`${meta.authorization_endpoint}?response_type=code&client_id=unknown&redirect_uri=https://x.test/cb`);
    assert.ok(!new URL(res.headers.get('location') || 'http://x/', BASE).searchParams.get('code'), 'a code was issued without signing in');
  });

  it('lets the provisioned account authorize a client and use the token', async () => {
    const { res, cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    assert.equal(res.status, 200, 'owner sign-in failed');

    const grant = await oauth.authorize(cookie);
    const tokens = await oauth.exchange(grant);

    const claims = await verifyAccessToken(tokens.access_token);
    assert.ok(claims, 'issued access token was not accepted');
    assert.ok([].concat(claims.aud).includes(`${BASE}/mcp`), 'token is not bound to the MCP resource');

    const refreshed = await oauth.refresh(grant, tokens.refresh_token);
    assert.ok(await verifyAccessToken(refreshed.access_token), 'refreshed access token was not accepted');
  });

  it('accepts tokens for clients that connect at the bare origin', async () => {
    const { cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    const tokens = await oauth.exchange(await oauth.authorize(cookie, { resource: BASE }));
    assert.ok(await verifyAccessToken(tokens.access_token));
  });

  it('issues no code when the user denies consent', async () => {
    const { cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    const { redirect } = await oauth.authorize(cookie, { accept: false });
    assert.equal(redirect.searchParams.get('code'), null);
    assert.equal(redirect.searchParams.get('error'), 'access_denied');
  });

  it('rejects forged, tampered and foreign tokens', async () => {
    const { cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    const tokens = await oauth.exchange(await oauth.authorize(cookie));
    const [header, payload, signature] = tokens.access_token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), sub: 'someone-else' })).toString('base64url');

    assert.equal(await verifyAccessToken('not-a-token'), null);
    assert.equal(await verifyAccessToken(`${header}.${forgedPayload}.${signature}`), null, 'modified claims were accepted');
    assert.equal(await verifyAccessToken(`${header}.${payload}.${signature.slice(0, -4)}AAAA`), null, 'bad signature was accepted');
  });

  it('tells unauthenticated MCP clients where to start and which scopes to ask for', async () => {
    const challenge = mcpChallenge();
    assert.match(challenge, /^Bearer /);
    assert.ok(challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), challenge);
    assert.ok(challenge.includes(`scope="${MCP_SCOPES.join(' ')}"`), challenge);
  });

  it('publishes the MCP resource, its authorization server and the scopes to request', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await protectedResourceMetadata(path);
      assert.equal(res.status, 200, path);
      const metadata = await res.json();
      assert.equal(metadata.resource, `${BASE}/mcp`);
      assert.deepEqual(metadata.authorization_servers, [`${BASE}/api/auth`]);
      assert.deepEqual(metadata.scopes_supported, MCP_SCOPES);
    }
  });

  it('gives a client that asks for exactly the advertised scopes a usable, refreshable token', async () => {
    const { cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    const grant = await oauth.authorize(cookie, { scope: MCP_SCOPES.join(' ') });
    const tokens = await oauth.exchange(grant);

    assert.ok(await verifyAccessToken(tokens.access_token), 'access token was not accepted');
    assert.ok(tokens.refresh_token, 'no refresh token: the client would have to sign in again every hour');
    const refreshed = await oauth.refresh(grant, tokens.refresh_token);
    assert.ok(await verifyAccessToken(refreshed.access_token), 'refreshed access token was not accepted');
  });
});
