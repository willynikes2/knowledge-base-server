// tests/auth-login.test.js — Test dashboard login → authenticated API flow
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { setPassword, loginHandler, logoutHandler, checkAuthHandler, authMiddleware } from '../src/auth.js';
import { getStats } from '../src/db.js';
import authRoutes from '../src/routes/auth-routes.js';
import apiRoutes from '../src/routes/api.js';
import { CONFIG_PATH } from '../src/paths.js';

// Backup existing config before tests overwrite it
const _configBackup = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null;

// Set a known password for testing
const TEST_PASSWORD = 'testpass123';
setPassword(TEST_PASSWORD);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(authRoutes);
  app.use(apiRoutes);
  return app;
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('Dashboard auth flow', () => {
  // Restore original config after all tests
  after(() => {
    if (_configBackup !== null) {
      writeFileSync(CONFIG_PATH, _configBackup);
    }
  });

  it('GET /api/stats without auth returns 401', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/stats`);
      assert.strictEqual(res.status, 401);
    });
  });

  it('POST /api/login with wrong password returns 401', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrongpass' }),
      });
      assert.strictEqual(res.status, 401);
      // Should NOT set a cookie
      const setCookie = res.headers.get('set-cookie');
      assert.strictEqual(setCookie, null);
    });
  });

  it('POST /api/login with correct password returns 200 and sets cookie', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
      // Should set kb_session cookie
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie, 'login response should set a cookie');
      assert.ok(setCookie.includes('kb_session='), 'cookie should be kb_session');
    });
  });

  it('Login then GET /api/stats succeeds with session cookie', async () => {
    await withServer(async (port) => {
      // Login first
      const loginRes = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert.strictEqual(loginRes.status, 200);

      // Extract cookie from login response
      const setCookie = loginRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0]; // "kb_session=..."

      // Use cookie to access stats
      const statsRes = await fetch(`http://localhost:${port}/api/stats`, {
        headers: { Cookie: cookie },
      });
      assert.strictEqual(statsRes.status, 200);
      const stats = await statsRes.json();
      assert.ok('count' in stats, 'stats should have count');
      assert.ok('totalSize' in stats, 'stats should have totalSize');
    });
  });

  it('GET /api/auth-check reflects authentication state', async () => {
    await withServer(async (port) => {
      // Without cookie — not authenticated
      const noAuthRes = await fetch(`http://localhost:${port}/api/auth-check`);
      const noAuthData = await noAuthRes.json();
      assert.strictEqual(noAuthData.authenticated, false);

      // Login
      const loginRes = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      const setCookie = loginRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0];

      // With cookie — authenticated
      const authRes = await fetch(`http://localhost:${port}/api/auth-check`, {
        headers: { Cookie: cookie },
      });
      const authData = await authRes.json();
      assert.strictEqual(authData.authenticated, true);
    });
  });

  it('POST /api/logout clears session', async () => {
    await withServer(async (port) => {
      // Login
      const loginRes = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      const setCookie = loginRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0];

      // Logout
      const logoutRes = await fetch(`http://localhost:${port}/api/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      assert.strictEqual(logoutRes.status, 200);

      // Session should be invalid now
      const statsRes = await fetch(`http://localhost:${port}/api/stats`, {
        headers: { Cookie: cookie },
      });
      assert.strictEqual(statsRes.status, 401);
    });
  });

  it('PUT /api/password changes password with valid session', async () => {
    await withServer(async (port) => {
      // Login
      const loginRes = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      const setCookie = loginRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0];

      // Change password
      const newPass = 'newpass456';
      const changeRes = await fetch(`http://localhost:${port}/api/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ current: TEST_PASSWORD, newPassword: newPass }),
      });
      assert.strictEqual(changeRes.status, 200);
      const changeData = await changeRes.json();
      assert.strictEqual(changeData.ok, true);

      // Login with new password should work
      const loginRes2 = await fetch(`http://localhost:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPass }),
      });
      assert.strictEqual(loginRes2.status, 200);

      // Restore original password for other tests
      setPassword(TEST_PASSWORD);
    });
  });
});
