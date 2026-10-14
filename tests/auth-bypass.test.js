// tests/auth-bypass.test.js
// A key is only valid when it equals a configured key. Names that every JavaScript object inherits
// ("constructor", "toString", "__proto__", …) must never authenticate.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createApiKeyMiddleware, serviceForKey } from '../src/middleware/api-key.js';
import { createBrainAuth } from '../src/middleware/brain-auth.js';

const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__', '__defineGetter__', '__lookupGetter__'];

function call(mw, headers) {
  return new Promise((resolve) => {
    const req = { headers };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { return { json: (body) => resolve({ passed: false, code, body, req, res }) }; } };
    Promise.resolve(mw(req, res, () => resolve({ passed: true, req, res }))).catch((e) => resolve({ passed: false, threw: e }));
  });
}

describe('authentication cannot be bypassed with an inherited property name', () => {
  beforeEach(() => {
    process.env.KB_API_KEY_CLAUDE = 'test-key-claude-1234';
    process.env.KB_API_KEY_OPENAI = 'test-key-openai-5678';
    delete process.env.KB_API_KEY_GEMINI;
  });
  afterEach(() => { delete process.env.KB_API_KEY_CLAUDE; delete process.env.KB_API_KEY_OPENAI; });

  it('serviceForKey knows only the configured keys', () => {
    assert.strictEqual(serviceForKey('test-key-claude-1234'), 'claude');
    assert.strictEqual(serviceForKey('test-key-openai-5678'), 'openai');
    for (const name of [...INHERITED, '', 'test-key-claude-123', 'test-key-claude-12345', 'undefined', 'null']) assert.strictEqual(serviceForKey(name), null, name);
    for (const odd of [undefined, null, 42, {}, ['test-key-claude-1234'], true]) assert.strictEqual(serviceForKey(odd), null, String(odd));
  });

  it('an unset key never matches the empty string or "undefined"', () => {
    delete process.env.KB_API_KEY_CLAUDE; delete process.env.KB_API_KEY_OPENAI;
    for (const name of ['', 'undefined', ...INHERITED]) assert.strictEqual(serviceForKey(name), null, name);
  });

  it('the API-key middleware rejects every inherited name, in both header forms', async () => {
    const mw = createApiKeyMiddleware();
    for (const name of INHERITED) {
      const byHeader = await call(mw, { 'x-api-key': name });
      assert.deepStrictEqual([byHeader.passed, byHeader.code], [false, 403], `X-API-Key: ${name}`);
      assert.strictEqual(byHeader.req.apiService, undefined);
      const byBearer = await call(mw, { authorization: `Bearer ${name}` });
      assert.deepStrictEqual([byBearer.passed, byBearer.code], [false, 403], `Bearer ${name}`);
    }
  });

  it('the API-key middleware still accepts a real key and names its service', async () => {
    const mw = createApiKeyMiddleware();
    const ok = await call(mw, { 'x-api-key': 'test-key-openai-5678' });
    assert.deepStrictEqual([ok.passed, ok.req.apiService], [true, 'openai']);
    const twice = await call(mw, { 'x-api-key': ['test-key-openai-5678', 'test-key-openai-5678'] });
    assert.strictEqual(twice.passed, false, 'a repeated header is not a key');
  });

  describe('the Brain API gate (API key or OAuth token)', () => {
    const gate = (verify = async () => null) => createBrainAuth({ verifyAccessToken: verify, challenge: () => 'Bearer resource_metadata="x"' });

    it('rejects every inherited name as a Bearer token and as an X-API-Key', async () => {
      const seen = [];
      const mw = gate(async (token) => { seen.push(token); return null; });
      for (const name of INHERITED) {
        const bearer = await call(mw, { authorization: `Bearer ${name}` });
        assert.deepStrictEqual([bearer.passed, bearer.code], [false, 401], `Bearer ${name}`);
        assert.strictEqual(bearer.req.apiService, undefined);
        assert.strictEqual(bearer.res.headers['WWW-Authenticate'], 'Bearer resource_metadata="x"');
        const header = await call(mw, { 'x-api-key': name });
        assert.deepStrictEqual([header.passed, header.code], [false, 403], `X-API-Key: ${name}`);
      }
      assert.deepStrictEqual(seen, INHERITED, 'a token that is not an API key is checked as an OAuth token, nothing else');
    });

    it('accepts a real API key in either header, and a valid OAuth token', async () => {
      const key = await call(gate(), { 'x-api-key': 'test-key-claude-1234' });
      assert.deepStrictEqual([key.passed, key.req.apiService], [true, 'claude']);
      const bearerKey = await call(gate(), { authorization: 'Bearer test-key-openai-5678' });
      assert.deepStrictEqual([bearerKey.passed, bearerKey.req.apiService], [true, 'openai']);
      const oauth = await call(gate(async (t) => (t === 'good-token' ? { sub: 'user-1' } : null)), { authorization: 'Bearer good-token' });
      assert.deepStrictEqual([oauth.passed, oauth.req.apiService, oauth.req.oauthClaims], [true, 'oauth', { sub: 'user-1' }]);
    });

    it('answers 401 with the OAuth challenge when nothing valid is sent', async () => {
      for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }, { authorization: 'Bearer wrong' }]) {
        const r = await call(gate(), headers);
        assert.deepStrictEqual([r.passed, r.code], [false, 401], JSON.stringify(headers));
        assert.ok(r.res.headers['WWW-Authenticate']);
      }
    });
  });
});
