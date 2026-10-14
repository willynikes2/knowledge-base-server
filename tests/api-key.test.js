// tests/api-key.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createApiKeyMiddleware } from '../src/middleware/api-key.js';

describe('API key middleware', () => {
  beforeEach(() => {
    process.env.KB_API_KEY_CLAUDE = 'test-key-claude-1234';
    process.env.KB_API_KEY_OPENAI = 'test-key-openai-5678';
    process.env.KB_API_KEY_GEMINI = 'test-key-gemini-9012';
  });

  it('allows valid X-API-Key header', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { 'x-api-key': 'test-key-claude-1234' } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called);
    assert.strictEqual(req.apiService, 'claude');
  });

  it('allows valid Bearer token', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { authorization: 'Bearer test-key-openai-5678' } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called);
    assert.strictEqual(req.apiService, 'openai');
  });

  it('accepts the swarm key as service "swarm"', () => {
    process.env.KB_API_KEY_SWARM = 'test-key-swarm-9012';
    try {
      const mw = createApiKeyMiddleware();
      const req = { headers: { 'x-api-key': 'test-key-swarm-9012' } };
      const res = { status: () => res, json: () => {} };
      let called = false;
      mw(req, res, () => { called = true; });
      assert.ok(called);
      assert.strictEqual(req.apiService, 'swarm');
    } finally {
      delete process.env.KB_API_KEY_SWARM;
    }
  });

  it('rejects missing key with 401', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: {} };
    let statusCode;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: () => {},
    };
    mw(req, res, () => {});
    assert.strictEqual(statusCode, 401);
  });

  it('rejects invalid key with 403', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { 'x-api-key': 'wrong-key' } };
    let statusCode;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: () => {},
    };
    mw(req, res, () => {});
    assert.strictEqual(statusCode, 403);
  });
});
