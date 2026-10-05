// src/auth-oauth.js — Better Auth OAuth 2.1 provider for MCP clients
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { mcp } from '@better-auth/mcp';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import Database from 'better-sqlite3';
import { join } from 'path';
import { KB_DIR } from './paths.js';

const AUTH_DB_PATH = join(KB_DIR, 'auth.db');

export const BASE_URL = (process.env.BETTER_AUTH_URL || `http://localhost:${process.env.KB_PORT || 3838}`).replace(/\/+$/, '');
// MCP clients connect to /mcp (or the bare origin); tokens are audience-bound to either.
export const MCP_RESOURCE = `${BASE_URL}/mcp`;
const ACCEPTED_AUDIENCES = [MCP_RESOURCE, BASE_URL];

const authDb = new Database(AUTH_DB_PATH);

// better-auth stores string[] columns as TEXT on SQLite, then warns about it on
// every schema check; and it reports missing tables before migrateAuthSchema()
// (run at every start) creates them. Drop those two messages, keep the rest.
const IGNORED_AUTH_LOGS = [
  /has a different type in the database\. Expected string\[\] but got TEXT/,
  /^Database schema mismatch/,
];

export const auth = betterAuth({
  logger: {
    log(level, message, ...args) {
      if (IGNORED_AUTH_LOGS.some(pattern => pattern.test(message))) return;
      const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      write(`[Better Auth] ${message}`, ...args);
    },
  },
  database: authDb,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: BASE_URL,
  basePath: '/api/auth',
  emailAndPassword: {
    enabled: true,
    // Any account can mint OAuth tokens with full KB access, so accounts are
    // provisioned by the operator (`kb auth add-user`), never self-registered.
    disableSignUp: true,
  },
  plugins: [
    jwt(),
    mcp({
      loginPage: '/sign-in',
      consentPage: '/consent',
      resource: MCP_RESOURCE,
      resources: [BASE_URL],
      clientRegistrationDefaultResources: [BASE_URL],
      // Claude and other MCP clients register themselves (RFC 7591). A client
      // alone grants nothing: the user still has to sign in and approve it.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ],
});

// Tables from the pre-1.7 better-auth `mcp` plugin. Their names collide with the
// new provider's tables but their columns don't, so they are kept aside, not dropped.
const LEGACY_OAUTH_TABLES = ['oauthApplication', 'oauthAccessToken', 'oauthConsent'];

function archiveLegacyOAuthTables(db) {
  const columns = table => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(c => c.name);
  const isLegacy = columns('oauthApplication').length > 0 || columns('oauthAccessToken').includes('accessToken');
  if (!isLegacy) return [];

  const archived = [];
  db.transaction(() => {
    for (const table of LEGACY_OAUTH_TABLES) {
      if (columns(table).length === 0) continue;
      let target = `legacy_${table}`;
      for (let n = 2; columns(target).length > 0; n += 1) target = `legacy_${table}_${n}`;
      db.prepare(`ALTER TABLE "${table}" RENAME TO "${target}"`).run();
      // Indexes keep their names across a table rename and would block the new
      // tables' indexes; SQLite can't rename an index, so recreate it as legacy_*.
      const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(target);
      for (const { name, sql } of indexes) {
        db.prepare(`DROP INDEX "${name}"`).run();
        db.prepare(sql.replace(`"${name}"`, `"legacy_${name}"`)).run();
      }
      archived.push(target);
    }
  })();
  return archived;
}

/**
 * Create or upgrade the auth schema. Safe to run on every start: it only adds
 * what is missing. Returns the legacy tables it moved aside, if any.
 */
export async function migrateAuthSchema() {
  const archived = archiveLegacyOAuthTables(authDb);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return archived;
}

/** Create an account that can sign in to approve OAuth clients. */
export async function addUser({ email, password, name }) {
  const ctx = await auth.$context;
  const normalized = email.trim().toLowerCase();
  if (await ctx.internalAdapter.findUserByEmail(normalized)) {
    throw new Error(`A user with email ${normalized} already exists`);
  }
  const { minPasswordLength = 8 } = auth.options.emailAndPassword;
  if (password.length < minPasswordLength) {
    throw new Error(`Password must be at least ${minPasswordLength} characters`);
  }
  const user = await ctx.internalAdapter.createUser({ email: normalized, name: name || normalized, emailVerified: true });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  return user;
}

/** Verify an OAuth access token (a JWT signed by this server). Returns its claims or null. */
export async function verifyAccessToken(token) {
  try {
    const ctx = await auth.$context;
    return await verifyJwsAccessToken(token, {
      jwksFetch: async () => auth.api.getJwks(),
      verifyOptions: { issuer: ctx.baseURL, audience: ACCEPTED_AUDIENCES },
    });
  } catch {
    return null;
  }
}
