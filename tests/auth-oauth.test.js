// tests/auth-oauth.test.js — OAuth provider: who can get a token
// Runs the real better-auth instance against an isolated HOME, in-process.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const BASE = 'http://localhost:3838';
const HOME = mkdtempSync(join(tmpdir(), 'kb-auth-test-'));
process.env.HOME = HOME;
process.env.BETTER_AUTH_URL = BASE;
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: BASE };

let auth;
let discoveryHandler;

function call(path, init = {}) {
  return auth.handler(new Request(new URL(path, BASE), init));
}

async function signIn(email, password) {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  return { res, cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
}

// Dynamic client registration -> authorize with PKCE -> token exchange.
async function obtainAccessToken(cookie) {
  const meta = await (await discoveryHandler(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
  const redirectUri = 'http://localhost:9/callback';

  const reg = await call(meta.registration_endpoint, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_name: 'test-client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  assert.equal(reg.status, 201, 'client registration failed');
  const { client_id } = await reg.json();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authorizeUrl = new URL(meta.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile email offline_access',
    state: 'state-123',
  });
  const authorize = await call(authorizeUrl, { headers: { Cookie: cookie } });
  const location = authorize.headers.get('location') || '';
  const code = new URL(location, BASE).searchParams.get('code');
  assert.ok(code, `authorize did not return a code (status ${authorize.status}, location ${location})`);

  const tokenRes = await call(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id, code_verifier: verifier }),
  });
  assert.equal(tokenRes.status, 200, 'token exchange failed');
  return (await tokenRes.json()).access_token;
}

describe('OAuth provider access', () => {
  before(async () => {
    await import('../src/paths.js');
    ({ auth } = await import('../src/auth-oauth.js'));
    const { getMigrations } = await import('better-auth/db/migration');
    await (await getMigrations(auth.options)).runMigrations();
    const { oAuthDiscoveryMetadata } = await import('better-auth/plugins');
    discoveryHandler = oAuthDiscoveryMetadata(auth);

    // Provision the operator account directly, the way an admin CLI would.
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: 'owner@example.test', name: 'Owner', emailVerified: true });
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await ctx.password.hash('correct horse battery staple'),
    });
  });

  after(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it('rejects public sign-up, so outsiders cannot create an account', async () => {
    const res = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'outsider@evil.test', password: 'Password123!', name: 'outsider' }),
    });

    assert.ok(res.status >= 400, `sign-up should be refused, got ${res.status}`);
    const ctx = await auth.$context;
    assert.equal(await ctx.internalAdapter.findUserByEmail('outsider@evil.test'), null, 'outsider account was created');
  });

  it('rejects a wrong password for the provisioned account', async () => {
    const { res } = await signIn('owner@example.test', 'wrong password');
    assert.ok(res.status >= 400, `sign-in with a wrong password should fail, got ${res.status}`);
  });

  it('lets the provisioned account complete the OAuth flow and use the token', async () => {
    const { res, cookie } = await signIn('owner@example.test', 'correct horse battery staple');
    assert.equal(res.status, 200, 'owner sign-in failed');

    const accessToken = await obtainAccessToken(cookie);
    assert.ok(accessToken, 'no access token issued');

    const session = await auth.api.getMcpSession({ headers: new Headers({ Authorization: `Bearer ${accessToken}` }) });
    assert.ok(session, 'issued token was not accepted');
    assert.equal((await auth.api.getMcpSession({ headers: new Headers({ Authorization: 'Bearer forged' }) })), null);
  });
});
