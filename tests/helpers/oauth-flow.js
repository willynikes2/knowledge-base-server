// tests/helpers/oauth-flow.js — drive the real OAuth provider in-process the way
// an MCP client (e.g. the Claude connector) does: discovery -> dynamic client
// registration -> sign in -> authorize -> consent -> token.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

export const REDIRECT_URI = 'https://client.example.test/callback';

export function createOAuthClient(auth, baseUrl) {
  const jsonHeaders = { 'Content-Type': 'application/json', Origin: baseUrl };
  const call = (path, init = {}) => auth.handler(new Request(new URL(path, baseUrl), init));

  async function signIn(email, password) {
    const res = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ email, password }),
    });
    return { res, cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
  }

  async function metadata() {
    const res = await call('/api/auth/.well-known/oauth-authorization-server');
    assert.equal(res.status, 200, 'authorization server metadata unavailable');
    return res.json();
  }

  async function register(meta) {
    const res = await call(meta.registration_endpoint, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        client_name: 'Test MCP Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    assert.equal(res.status, 201, `client registration failed: ${await res.clone().text()}`);
    return (await res.json()).client_id;
  }

  /** Runs the flow up to the consent decision. Returns what the token step needs. */
  async function authorize(cookie, { resource = `${baseUrl}/mcp`, accept = true } = {}) {
    const meta = await metadata();
    const clientId = await register(meta);
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'openid profile email offline_access',
      state: 'state-123',
    });
    if (resource) query.set('resource', resource);

    const authz = await call(`${meta.authorization_endpoint}?${query}`, { headers: { Cookie: cookie } });
    const consentUrl = new URL(authz.headers.get('location') || '', baseUrl);
    assert.equal(consentUrl.pathname, '/consent', `expected the consent page, got ${consentUrl}`);

    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...jsonHeaders, Cookie: cookie },
      body: JSON.stringify({ accept, oauth_query: consentUrl.search.slice(1) }),
    });
    const { url } = await consent.json();
    return { meta, clientId, verifier, resource, redirect: new URL(url) };
  }

  async function exchange({ meta, clientId, verifier, resource, redirect }) {
    const code = redirect.searchParams.get('code');
    assert.ok(code, `no authorization code in ${redirect}`);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (resource) body.set('resource', resource);
    const res = await call(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 200, `token exchange failed: ${await res.clone().text()}`);
    return res.json();
  }

  async function refresh({ meta, clientId, resource }, refreshToken) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    if (resource) body.set('resource', resource);
    const res = await call(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 200, `refresh failed: ${await res.clone().text()}`);
    return res.json();
  }

  return { call, jsonHeaders, signIn, authorize, exchange, refresh };
}
