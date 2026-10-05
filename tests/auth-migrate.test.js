// tests/auth-migrate.test.js — upgrading an auth.db created by the pre-1.7
// better-auth `mcp` plugin (schema fixture taken from a production database).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hashPassword } from 'better-auth/crypto';
import { createOAuthClient } from './helpers/oauth-flow.js';

const BASE = 'http://localhost:3838';
const HOME = mkdtempSync(join(tmpdir(), 'kb-auth-migrate-test-'));
process.env.HOME = HOME;
process.env.BETTER_AUTH_URL = BASE;
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const DB_PATH = join(HOME, '.knowledge-base', 'auth.db');
const OWNER = { email: 'owner@example.test', password: 'correct horse battery staple' };
const now = new Date().toISOString();

async function seedLegacyDatabase() {
  mkdirSync(join(HOME, '.knowledge-base'), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(readFileSync(join(import.meta.dirname, 'fixtures', 'auth-schema-better-auth-1.5.sql'), 'utf8'));
  db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .run('u1', 'Owner', OWNER.email, now, now);
  db.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('a1', 'u1', 'credential', 'u1', await hashPassword(OWNER.password), now, now);
  db.prepare(`INSERT INTO oauthApplication (id, name, clientId, redirectUrls, type, disabled, userId, createdAt, updatedAt)
              VALUES ('app1', 'Claude', 'legacy-client', 'https://claude.ai/api/mcp/auth_callback', 'public', 0, 'u1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt)
              VALUES ('t1', 'legacy-access', 'legacy-refresh', ?, ?, 'legacy-client', 'u1', 'openid', ?, ?)`).run(now, now, now, now);
  db.prepare(`INSERT INTO oauthConsent (id, clientId, userId, scopes, consentGiven, createdAt, updatedAt)
              VALUES ('c1', 'legacy-client', 'u1', 'openid', 1, ?, ?)`).run(now, now);
  db.close();
}

describe('auth schema upgrade from the pre-1.7 mcp plugin', () => {
  let mod;
  let archived;

  before(async () => {
    await seedLegacyDatabase();
    mod = await import('../src/auth-oauth.js');
    archived = await mod.migrateAuthSchema();
  });

  after(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it('moves the legacy OAuth tables aside with their rows intact', () => {
    assert.deepEqual(archived.sort(), ['legacy_oauthAccessToken', 'legacy_oauthApplication', 'legacy_oauthConsent']);
    const db = new Database(DB_PATH, { readonly: true });
    try {
      for (const table of archived) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n, 1, `${table} lost rows`);
      }
      const columns = db.prepare(`SELECT name FROM pragma_table_info('oauthAccessToken')`).all().map(c => c.name);
      assert.ok(columns.includes('token') && !columns.includes('accessToken'), 'oauthAccessToken was not recreated with the new schema');
    } finally {
      db.close();
    }
  });

  it('gives the new tables their own indexes instead of colliding with the legacy ones', () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const indexes = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`).all();
      const onTable = table => indexes.filter(i => i.tbl_name === table).map(i => i.name);
      assert.ok(onTable('legacy_oauthAccessToken').every(name => name.startsWith('legacy_')), 'legacy indexes kept their old names');
      assert.ok(onTable('oauthAccessToken').length > 0, 'new oauthAccessToken table has no indexes');
    } finally {
      db.close();
    }
  });

  it('is a no-op when run again', async () => {
    assert.deepEqual(await mod.migrateAuthSchema(), []);
  });

  it('keeps existing accounts: the owner signs in and authorizes a new client', async () => {
    const oauth = createOAuthClient(mod.auth, BASE);
    const { res, cookie } = await oauth.signIn(OWNER.email, OWNER.password);
    assert.equal(res.status, 200, 'existing account could not sign in after the upgrade');

    const tokens = await oauth.exchange(await oauth.authorize(cookie));
    assert.ok(await mod.verifyAccessToken(tokens.access_token));
  });

  it('does not accept tokens issued by the old plugin', async () => {
    assert.equal(await mod.verifyAccessToken('legacy-access'), null);
  });
});
