// tests/auth-full-server.test.js — Test auth with full server middleware stack
// This simulates the actual server.js setup including Better Auth catch-all
import { describe, it } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { setPassword } from '../src/auth.js';
import authRoutes from '../src/routes/auth-routes.js';
import apiRoutes from '../src/routes/api.js';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../src/auth-oauth.js';

const TEST_PASSWORD = 'testpass123';
setPassword(TEST_PASSWORD);

function createFullApp() {
  const app = express();

  // Replicate server.js middleware order
  const corsMiddleware = cors({ origin: '*', credentials: true });

  // Better Auth catch-all (line 87 in server.js) — BEFORE express.json()
  app.all('/api/auth/*', corsMiddleware, toNodeHandler(auth));

  // JSON body parsing (line 116 in server.js)
  app.use(express.json({ limit: '1mb' }));

  // Dashboard routes (line 120-121 in server.js)
  app.use(authRoutes);
  app.use(apiRoutes);

  return app;
}

async function withServer(fn) {
  const app = createFullApp();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('Full server auth flow (with Better Auth)', () => {
  it('POST /api/login still works', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
    });
  });

  it('Login → GET /api/stats works', async () => {
    await withServer(async (port) => {
      const loginRes = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert.strictEqual(loginRes.status, 200);
      const setCookie = loginRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0];

      const statsRes = await fetch(`http://localhost:${port}/api/stats`, {
        headers: { Cookie: cookie },
      });
      assert.strictEqual(statsRes.status, 200);
    });
  });

  it('GET /api/auth-check is NOT intercepted by Better Auth', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/auth-check`);
      const data = await res.json();
      // Should return our dashboard response, not Better Auth's
      assert.ok('authenticated' in data, 'Should return dashboard auth-check response with authenticated field');
    });
  });

  it('PUT /api/password is NOT intercepted by Better Auth (returns 401 not 404)', async () => {
    await withServer(async (port) => {
      // Without a valid session, our authMiddleware returns 401.
      // Better Auth would return 404 for routes it doesn't know about.
      // So 401 here proves the route is handled by our router, not Better Auth.
      const res = await fetch(`http://localhost:${port}/api/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: TEST_PASSWORD, newPassword: 'newpass456' }),
      });
      assert.strictEqual(res.status, 401, 'Should be 401 from authMiddleware (not 404 from Better Auth)');
      const data = await res.json();
      assert.strictEqual(data.error, 'Unauthorized', 'Should return our authMiddleware error, not a Better Auth error');
    });
  });
});
