import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getHttpToolDefinitions } from './tools.js';

/**
 * Create a fresh MCP server instance with all HTTP-safe tools registered.
 * A new instance is created per session to keep state isolated.
 */
function createMcpServer() {
  const server = new McpServer({
    name: 'knowledge-base-brain',
    version: '1.0.0',
  });

  for (const tool of getHttpToolDefinitions()) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  return server;
}

/**
 * Session store: maps session ID -> { server, transport }
 * Sessions are cleaned up when the transport closes OR after TTL expiry.
 */
const sessions = new Map();
const sessionTimers = new Map();
const SESSION_TTL = 60 * 60 * 1000; // 1 hour max idle per session

function scheduleSessionCleanup(sid) {
  // Clear any existing timer for this session
  const existing = sessionTimers.get(sid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    const session = sessions.get(sid);
    if (session) {
      console.log(`[KB] Session ${sid} expired after TTL — cleaning up`);
      try { session.transport.close?.(); } catch {}
      sessions.delete(sid);
    }
    sessionTimers.delete(sid);
  }, SESSION_TTL);
  timer.unref(); // Don't keep process alive just for cleanup
  sessionTimers.set(sid, timer);
}

function clearSessionTimer(sid) {
  const timer = sessionTimers.get(sid);
  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sid);
  }
}

/**
 * Handle POST /mcp — all MCP protocol operations (initialize, tools/list, tools/call, etc.)
 *
 * Session lifecycle:
 * - First request (no Mcp-Session-Id header): creates a new server+transport pair,
 *   the transport auto-generates a session ID and includes it in the response header.
 * - Subsequent requests: looks up the existing transport by session ID and reuses it.
 */
export async function mcpHttpHandler(req, res) {
  const sessionId = req.headers['mcp-session-id'];

  let transport;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session — reuse transport, refresh TTL
    transport = sessions.get(sessionId).transport;
    scheduleSessionCleanup(sessionId);
  } else if (!sessionId) {
    // New session — create server + transport
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createMcpServer();

    // Store session once the transport assigns a session ID (happens during handleRequest)
    transport._webStandardTransport._onsessioninitialized = (sid) => {
      sessions.set(sid, { server, transport });
      scheduleSessionCleanup(sid);
    };

    // Clean up when transport closes
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        clearSessionTimer(sid);
        sessions.delete(sid);
      }
    };

    // Connect server to transport
    await server.connect(transport);
  } else {
    // Unknown session ID
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Session not found: ${sessionId}` },
      id: null,
    });
    return;
  }

  // Delegate to the transport — it handles parsing, routing, and response writing.
  // Pass req.body (already parsed by express.json()) as parsedBody.
  await transport.handleRequest(req, res, req.body);
}

/**
 * Handle GET /mcp — server metadata / discovery endpoint.
 * Also delegates to the transport for SSE stream support (server-initiated messages).
 * For plain GET without an existing session this returns metadata as JSON.
 */
export async function mcpGetHandler(req, res) {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions.has(sessionId)) {
    // Existing session GET — let transport handle it (SSE stream, etc.)
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // No session — return discovery metadata
  res.json({
    name: 'knowledge-base-brain',
    version: '1.0.0',
    capabilities: { tools: {} },
    toolCount: getHttpToolDefinitions().length,
  });
}
