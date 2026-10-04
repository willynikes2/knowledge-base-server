// src/auth-oauth.js — Better Auth OAuth provider for MCP clients
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';

const KB_DIR = join(homedir(), '.knowledge-base');
const AUTH_DB_PATH = join(KB_DIR, 'auth.db');

export const auth = betterAuth({
  database: new Database(AUTH_DB_PATH),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${process.env.KB_PORT || 3838}`,
  basePath: '/api/auth',
  emailAndPassword: {
    enabled: true,
    // Any account can mint OAuth tokens with full KB access, so accounts are
    // provisioned by the operator, never self-registered.
    disableSignUp: true,
  },
  plugins: [
    mcp({
      loginPage: '/sign-in',
    }),
  ],
});
