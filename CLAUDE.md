# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the web dashboard + REST API (port 3838)
KB_PASSWORD=yourpass kb start

# Start MCP stdio server (used by AI tools)
kb mcp

# Register MCP with Claude Code (~/.claude.json)
kb register

# Ingest a file or directory
kb ingest ~/obsidian-vault

# Search from terminal
kb search "docker networking"

# Delete a document by ID
kb delete 42

# Delete multiple documents
kb delete 1 2 3 4 5 6

# Show stats and server status
kb status

# Auto-classify vault notes (--dry-run to preview)
kb classify --dry-run

# Add AI summaries to unsummarized docs (--limit=N to cap)
kb summarize --limit=10

# Reindex Obsidian vault
kb vault reindex

# Interactive setup wizard
kb setup
# Agent-driven (no prompts):
kb setup --auto --password=yourpass --vault=~/obsidian-vault --agents=claude --deploy=systemd

# Capture X/Twitter bookmarks
kb capture-x ~/path/to/x_bookmarks.md

# Safety check before a destructive action
kb safety-check "drop the documents table"
```

No build step — the codebase runs directly from source (pure ESM). No test runner is configured.

## Architecture

### Data directory: `~/.knowledge-base/`
All runtime state lives outside the repo:
- `kb.db` — SQLite database (documents, FTS5 index, embeddings, vault_files, sessions)
- `files/` — Copies of ingested files with timestamp prefix
- `config.json` — Bcrypt password hash and settings
- `kb.pid` — PID file for `kb stop`

### Entry points
- `bin/kb.js` — CLI dispatcher; loads `.env` from repo root, routes to command modules
- `src/server.js` — Express web server (dashboard + REST API + MCP HTTP)
- `src/mcp.js` — MCP stdio server for AI agent integration

### Request paths

**Dashboard (browser):** Cookie auth via `src/auth.js` → `src/routes/auth-routes.js` + `src/routes/api.js`

**External REST API:** `X-API-Key` header or OAuth Bearer → `src/middleware/api-key.js` + `src/auth-oauth.js` → `src/routes/v1.js`

**MCP stdio:** `kb mcp` → `src/mcp.js` → `src/tools.js` (no auth — local process)

**MCP HTTP:** `POST /mcp` → same `brainAuth` as REST → `src/mcp-http.js` → `src/tools.js`

`src/tools.js` is the single source of truth for all MCP tool definitions — shared by both stdio and HTTP transports.

### Database layer (`src/db.js`)
- Singleton `getDb()` — initializes lazily, runs schema migrations inline on first call
- FTS5 virtual table `documents_fts` with BM25 ranking; title weight 10×, tags 5×, content 1×
- Search strategy: AND-first for precision, OR fallback for recall
- `vault_files` table tracks content hashes for incremental vault re-indexing
- Embeddings stored as Float32Array binary blobs (3× smaller than JSON)
- WAL mode with 5-minute periodic checkpoint

### Key modules
| Module | Responsibility |
|--------|---------------|
| `src/ingest.js` | File → DB; duplicate detection by filename (`source` field) |
| `src/vault/indexer.js` | Obsidian vault incremental indexer (hash-based) |
| `src/embeddings/embed.js` | Local HuggingFace `Xenova/all-MiniLM-L6-v2` embeddings |
| `src/embeddings/search.js` | Hybrid FTS5 + cosine similarity search |
| `src/classify/` | AI auto-classification of vault notes (type, tags, summary) |
| `src/capture/` | Structured capture: YouTube, web, terminal sessions, bug fixes, X bookmarks |
| `src/promotion/` | Promotes raw captures → structured knowledge artifacts |
| `src/synthesis/` | Cross-source synthesis / weekly review |
| `src/safety/review.js` | Multi-model consensus check before destructive actions |
| `src/paths.js` | Centralized path constants — always import paths from here |

### Auth model
- **Dashboard**: bcrypt password stored in `config.json`; 24h session tokens in SQLite `sessions` table; HttpOnly cookie `kb_session`
- **External API**: Three named API keys (`KB_API_KEY_CLAUDE`, `KB_API_KEY_OPENAI`, `KB_API_KEY_GEMINI`) or OAuth 2.1 Bearer via `better-auth`
- **ADMIN_ONLY_TOOLS**: `kb_classify`, `kb_promote`, `kb_synthesize`, `kb_safety_check`, `kb_capture_youtube` — gated in the MCP HTTP handler

### Environment variables (`.env` in repo root)
| Variable | Purpose |
|----------|---------|
| `KB_PASSWORD` | Dashboard password (first-run auto-provision) |
| `KB_PORT` | HTTP port (default 3838) |
| `OBSIDIAN_VAULT_PATH` | Vault path for sync and classify commands |
| `KB_API_KEY_CLAUDE` | API key for Claude remote access |
| `KB_API_KEY_OPENAI` | API key for OpenAI/ChatGPT access |
| `KB_API_KEY_GEMINI` | API key for Gemini access |
| `BETTER_AUTH_SECRET` | OAuth token signing secret |
| `BETTER_AUTH_URL` | OAuth issuer URL (for remote deployment) |
| `CLASSIFY_MODEL` | Claude model for AI classification (default: claude-haiku-4-5-20251001) |
| `KB_CORS_ORIGINS` | Comma-separated extra CORS origins |

### Important constraints
- **Pure ESM** (`"type": "module"` in package.json) — all imports must use `.js` extensions
- **No build step** — source runs directly via Node.js ≥18
- **Duplicate detection is by filename** — two different files with the same name will collide in ingestion
- The embedding model (`all-MiniLM-L6-v2`) loads lazily with a 60s timeout and a mutex to prevent concurrent loads
- `src/server.js` registers the Better Auth handler **before** `express.json()` — order matters
- The SPA fallback route (`app.get('*', ...)`) must remain the last route in `server.js`
