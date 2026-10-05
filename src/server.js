import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, writeFileSync, unlinkSync, globSync } from 'fs';
import { homedir } from 'os';

import { PID_PATH } from './paths.js';
import { hasPassword, setPassword, promptPassword, authMiddleware } from './auth.js';
import { getDocumentCount } from './db.js';
import { ingestDirectory } from './ingest.js';
import cors from 'cors';
import authRoutes from './routes/session-routes.js';
import apiRoutes from './routes/api.js';
import { toNodeHandler } from 'better-auth/node';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { auth, migrateAuthSchema, verifyAccessToken, BASE_URL } from './auth-oauth.js';
import { createApiKeyMiddleware } from './middleware/api-key.js';
import v1Router from './routes/v1.js';
import openapiRoute from './routes/openapi.js';
import { mcpHttpHandler, mcpGetHandler } from './mcp-http.js';

export async function start() {
  const port = parseInt(process.env.KB_PORT || '3838', 10);

  // --- Global error handlers: prevent silent crashes ---
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[KB] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit — log and survive. Systemd will restart if truly fatal.
  });
  process.on('uncaughtException', (error) => {
    console.error('[KB] Uncaught Exception:', error);
    // Give time to flush logs, then exit (systemd restarts)
    setTimeout(() => process.exit(1), 1000);
  });

  // 1. Password setup
  if (process.env.KB_PASSWORD && !hasPassword()) {
    setPassword(process.env.KB_PASSWORD);
    console.log('Password set from KB_PASSWORD env var');
  } else if (!hasPassword()) {
    await promptPassword();
  }

  // 2. OAuth schema: create it on first run, upgrade it after better-auth updates
  const archivedAuthTables = await migrateAuthSchema();
  if (archivedAuthTables.length) {
    console.log(`OAuth schema upgraded; previous OAuth clients/tokens kept in ${archivedAuthTables.join(', ')}. Reconnect MCP clients.`);
  }

  // 3. Auto-ingest on first run
  if (getDocumentCount() === 0) {
    console.log('First run — auto-ingesting existing knowledge base...');
    const home = homedir();
    const dirs = [join(home, 'knowledgebase')];
    // Add Claude memory dirs
    try {
      const memoryDirs = globSync(join(home, '.claude/projects/*/memory'));
      dirs.push(...memoryDirs);
    } catch {}
    for (const dir of dirs) {
      if (existsSync(dir)) {
        console.log(`  Ingesting ${dir}...`);
        const result = await ingestDirectory(dir);
        console.log(`    ${result.ingested} ingested, ${result.skipped} skipped`);
      }
    }
  }

  // 4. Express setup
  const app = express();

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // --- CORS for external API/MCP access ---
  // Merge hardcoded AI platform origins with any custom origins from env
  const aiPlatformOrigins = [
    'https://claude.ai',
    'https://claude.com',
    'https://chat.openai.com',
    'https://chatgpt.com',
    'https://gemini.google.com',
  ];
  const envOrigins = process.env.KB_CORS_ORIGINS
    ? process.env.KB_CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : [];
  const corsMiddleware = cors({
    origin: [...aiPlatformOrigins, ...envOrigins],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'Mcp-Session-Id'],
    credentials: true,
  });

  // --- Better Auth OAuth handler (MUST be BEFORE express.json) ---
  app.all('/api/auth/*', corsMiddleware, toNodeHandler(auth));

  // --- Well-known OAuth discovery endpoints ---
  // The issuer is ${BASE_URL}/api/auth, so RFC 8414 clients look for metadata at
  // /.well-known/<type>/api/auth; older clients use the bare /.well-known/<type>.
  const sendWebResponse = async (webRes, res) => {
    res.status(webRes.status);
    webRes.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(Buffer.from(await webRes.arrayBuffer()));
  };
  const authServerMetadata = oauthProviderAuthServerMetadata(auth);
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);
  const metadataRoute = handler => async (req, res) => {
    await sendWebResponse(await handler(new Request(`${BASE_URL}${req.originalUrl}`)), res);
  };
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/auth'],
    corsMiddleware, metadataRoute(authServerMetadata));
  app.get(['/.well-known/openid-configuration', '/.well-known/openid-configuration/api/auth'],
    corsMiddleware, metadataRoute(openIdMetadata));
  // RFC 9728 protected resource metadata, served by the mcp plugin itself.
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    corsMiddleware, toNodeHandler(auth));

  // --- Sign-in page for OAuth consent flow ---
  app.get('/sign-in', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'sign-in.html'));
  });
  app.get('/consent', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'consent.html'));
  });

  // Request logging for debugging
  app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.path} origin=${req.headers.origin || 'none'}`);
    next();
  });

  // Now enable JSON body parsing for remaining routes
  // 20mb limit to support base64 image ingestion via MCP tools
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(join(__dirname, 'public')));

  // --- Dashboard routes (existing, cookie auth) ---
  app.use(authRoutes);
  app.use(apiRoutes);

  // --- Brain API (external access via remote domain or localhost) ---
  const apiKeyAuth = createApiKeyMiddleware();

  // Auth middleware: accepts EITHER API key OR OAuth Bearer token
  const brainAuth = async (req, res, next) => {
    // Try API key first (fast path)
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      return apiKeyAuth(req, res, next);
    }

    // Try OAuth Bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Check if it's an API key in Bearer format
      const token = authHeader.slice(7);
      const keyMap = {};
      if (process.env.KB_API_KEY_CLAUDE) keyMap[process.env.KB_API_KEY_CLAUDE] = 'claude';
      if (process.env.KB_API_KEY_OPENAI) keyMap[process.env.KB_API_KEY_OPENAI] = 'openai';
      if (process.env.KB_API_KEY_GEMINI) keyMap[process.env.KB_API_KEY_GEMINI] = 'gemini';
      if (keyMap[token]) {
        req.apiService = keyMap[token];
        return next();
      }

      // Otherwise validate as an OAuth access token issued by this server
      const claims = await verifyAccessToken(token);
      if (claims) {
        req.apiService = 'oauth';
        req.oauthClaims = claims;
        return next();
      }
    }

    // RFC 9728: point MCP clients at the metadata that starts the OAuth flow.
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
    return res.status(401).json({ error: 'Missing or invalid authentication. Provide X-API-Key header or OAuth Bearer token.' });
  };

  // Public (no auth): OpenAPI spec + health
  app.get('/openapi.json', corsMiddleware, openapiRoute);
  app.get('/api/v1/health', corsMiddleware, (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  // Authenticated: v1 API (API key or OAuth)
  app.use('/api/v1', corsMiddleware, brainAuth, v1Router);

  // Authenticated: MCP HTTP (API key or OAuth)
  app.post('/mcp', (req, res, next) => {
    console.log(`[MCP POST] session=${req.headers['mcp-session-id'] || 'new'} auth=${req.headers.authorization ? 'Bearer...' : req.headers['x-api-key'] ? 'APIKey' : 'NONE'} origin=${req.headers.origin || 'none'}`);
    next();
  }, corsMiddleware, brainAuth, mcpHttpHandler);
  app.get('/mcp', (req, res, next) => {
    console.log(`[MCP GET] session=${req.headers['mcp-session-id'] || 'none'} auth=${req.headers.authorization ? 'Bearer...' : 'NONE'}`);
    next();
  }, corsMiddleware, brainAuth, mcpGetHandler);
  app.delete('/mcp', corsMiddleware, brainAuth, (req, res) => {
    // Session termination endpoint (MCP spec)
    res.status(200).json({ ok: true });
  });

  // Also handle MCP at root — Claude web POSTs to / when server URL has no path
  app.post('/', (req, res, next) => {
    // Only treat as MCP if it looks like a JSON-RPC request
    if (req.body && (req.body.jsonrpc || req.body.method)) {
      console.log(`[MCP POST /] routing to MCP handler`);
      return brainAuth(req, res, () => mcpHttpHandler(req, res));
    }
    next();
  });

  // Fallback to index.html for SPA (MUST remain LAST route)
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // --- Express error middleware: catch async route errors ---
  app.use((err, req, res, _next) => {
    console.error('[KB] Express error:', err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 4. Start — save server ref for graceful shutdown
  const server = app.listen(port, () => {
    console.log(`Knowledge Base server running at http://localhost:${port}`);
    writeFileSync(PID_PATH, process.pid.toString());
  });

  // Graceful shutdown: close HTTP server, wait for in-flight requests, then exit
  const shutdown = (signal) => {
    console.log(`[KB] ${signal} received — shutting down gracefully...`);
    server.close(() => {
      console.log('[KB] HTTP server closed');
      try { unlinkSync(PID_PATH); } catch {}
      process.exit(0);
    });
    // Force exit after 10s if connections hang
    setTimeout(() => {
      console.error('[KB] Forced shutdown after 10s timeout');
      try { unlinkSync(PID_PATH); } catch {}
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
