# EXTENDING.md -- Deep Customization Guide for AI Agents

This document is written for AI agents, not humans. When a user says "make this work for me" or "add a feature to the KB," read this file to understand how to extend the system without breaking it.

---

## Architecture Overview

### Core Stack

- **Runtime:** Node.js (>=18) with ES modules (`"type": "module"` in package.json)
- **Database:** SQLite via better-sqlite3 with FTS5 virtual tables for full-text search
- **Server:** Express 4 serving a web dashboard, REST API, and MCP endpoints
- **MCP:** Model Context Protocol server with two transports -- stdio (local) and StreamableHTTP (remote)
- **Embeddings:** Local HuggingFace model (`Xenova/all-MiniLM-L6-v2`) for semantic search, no external API needed
- **Auth:** Three layers -- cookie sessions (dashboard), API keys (external agents), OAuth via better-auth (MCP remote)

### Data Storage

All data lives in `~/.knowledge-base/`:
- `kb.db` -- SQLite database (documents, vault_files, embeddings tables)
- `files/` -- Ingested file copies
- `config.json` -- Password hash and settings
- `auth.db` -- OAuth session/token storage (separate SQLite DB)

### Three-Tier Memory Model

1. **Hot (active context):** `kb_context` returns summaries and metadata without full content. Agents use this first to decide what to read. Costs ~2% of the tokens compared to reading everything.
2. **Warm (accumulated knowledge):** Classified, summarized, and tagged documents in the `vault_files` table. Searchable via FTS5 and semantic embeddings. This is the main retrieval layer.
3. **Cold (raw captures):** Unprocessed inbox notes, clippings, and raw ingested content. Lives in the Obsidian vault `inbox/` folder until classified.

### Source of Truth Architecture

- **Obsidian vault** is the human-facing source of truth. Humans read and write notes there.
- **KB SQLite database** is the AI retrieval layer. Agents search and query here.
- **Sync flow:** Obsidian vault -> `scanVault()` -> `parseVaultNote()` -> `upsertVaultFile()` -> SQLite. Changes in the vault are indexed into the DB. The `kb-to-vault.js` sync exports KB documents back to the vault.

### Self-Learning Loop

```
capture -> classify -> synthesize -> promote -> retrieve -> improve
```

1. **Capture:** Agent records a session, fix, web article, or YouTube transcript via `kb_capture_*` tools
2. **Classify:** `kb_classify` runs AI classification on new/unprocessed notes (type, tags, summary)
3. **Synthesize:** `kb_synthesize` generates cross-source synthesis connecting dots across recent knowledge
4. **Promote:** `kb_promote` extracts structured knowledge from raw sources into research/idea/lesson/workflow notes
5. **Retrieve:** `kb_context` and `kb_search_smart` find relevant knowledge for active tasks
6. **Improve:** Each retrieval that leads to a fix or lesson feeds back into capture

---

## Extension Points

### src/tools.js -- Adding MCP Tools

This is the central tool registry. Every MCP tool (both stdio and HTTP) is defined here.

**Pattern for adding a new tool:**

```javascript
// Inside getToolDefinitions() return array, add:
{
  name: 'kb_your_tool',
  description: 'What this tool does. Be specific -- agents read this to decide when to use it.',
  schema: {
    param1: z.string().describe('What this parameter is for'),
    param2: z.number().optional().default(10).describe('Optional with default'),
  },
  handler: async ({ param1, param2 }) => {
    try {
      // Your logic here
      const result = doSomething(param1, param2);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
},
```

**Key details:**
- Schema uses Zod (`z`) for validation. The MCP SDK converts these to JSON Schema automatically.
- Handlers must return `{ content: [{ type: 'text', text: '...' }] }` -- this is the MCP tool result format.
- Set `isError: true` in the return to signal failure to the calling agent.
- Tools appear in both stdio and HTTP transports by default.
- To restrict a tool to stdio-only (admin/local access), add its name to the `ADMIN_ONLY_TOOLS` Set at the top of the file. The `getHttpToolDefinitions()` function filters these out for remote access.

### src/ingest.js -- Adding Content Source Types

The `TYPE_MAP` object at the top maps file extensions to document types. To add a new file type:

```javascript
// Add to TYPE_MAP:
'.epub': 'ebook',

// Then handle extraction in extractContent() or add a dedicated extractor:
async function extractEpubContent(filePath, filename) {
  // Parse the epub and return plain text
}
```

**Exported functions:**
- `ingestFile(filePath)` -- Ingest a single file. Detects type from extension, extracts content, copies to FILES_DIR, inserts into DB.
- `ingestDirectory(dirPath)` -- Recursively ingest all supported files. Deduplicates by source filename.
- `ingestText(title, content, { tags, doc_type, source })` -- Direct text ingestion without a file. Used by MCP tools and API.

### src/db.js -- Database Schema and Queries

**Tables:**

1. `documents` -- Core content store
   - `id`, `title`, `content`, `source`, `doc_type`, `tags`, `file_path`, `file_size`, `created_at`, `updated_at`

2. `documents_fts` -- FTS5 virtual table (auto-synced via triggers)
   - Columns: `title` (weight 10x), `content` (weight 1x), `tags` (weight 5x)
   - BM25 ranking with title-boosted scoring
   - Triggers: `documents_ai` (insert), `documents_ad` (delete), `documents_au` (update) keep FTS in sync

3. `vault_files` -- Obsidian vault file tracking for incremental indexing
   - `vault_path` (unique), `content_hash`, `document_id` (FK to documents), `title`, `note_type`, `tags`, `project`, `status`, `source`, `confidence`, `summary`, `key_topics`

4. `embeddings` -- Semantic search vectors
   - `document_id` (FK), `vault_path`, `chunk_index`, `chunk_text`, `embedding` (BLOB), `dimensions`

**To add a new query type:**
- Export a new function from `db.js`
- Use `getDb()` to get the singleton database connection
- Use prepared statements: `getDb().prepare('SELECT ...').all(params)`
- WAL mode is enabled by default for concurrent read performance

**FTS5 search configuration:**
- Stop words are filtered before querying (see `STOP_WORDS` Set)
- AND-first strategy with OR fallback for recall
- Term boosting: title matches get +20, tag matches get +10

### src/server.js -- Adding API Routes and Middleware

The Express app is configured in `start()`. Route registration order matters:

1. OAuth handler (`/api/auth/*`) -- BEFORE `express.json()`
2. Well-known OAuth discovery endpoints (`/.well-known/*`)
3. Static files and dashboard routes
4. Brain API (`/api/v1/*`) -- behind `brainAuth` middleware
5. MCP HTTP endpoints (`/mcp`) -- behind `brainAuth` middleware
6. SPA fallback (`*`) -- MUST be last

**To add a new authenticated API route:**
Add it to `src/routes/v1.js`. It automatically inherits `brainAuth` middleware from the parent mount at `/api/v1`.

**To add a new public route:**
Add it in `server.js` before the `brainAuth` middleware, like the `/api/v1/health` endpoint.

**Auth middleware chain (`brainAuth`):**
1. Check `X-API-Key` header against env vars (`KB_API_KEY_CLAUDE`, `KB_API_KEY_OPENAI`, `KB_API_KEY_GEMINI`)
2. Check `Authorization: Bearer <token>` against same API keys
3. Validate as OAuth token via better-auth
4. Reject with 401

### src/mcp-http.js -- HTTP MCP Transport

Implements the StreamableHTTP MCP transport for remote agent access. Key concepts:

- **Session management:** Each MCP client gets a session (UUID). Sessions map to isolated `McpServer` + `StreamableHTTPServerTransport` pairs.
- **Session lifecycle:** First POST to `/mcp` (no `Mcp-Session-Id` header) creates a session. Subsequent requests include the header. Sessions expire after 1 hour idle.
- **GET /mcp:** Returns server metadata for new clients, or handles SSE streams for existing sessions.
- **DELETE /mcp:** Session termination.

### src/mcp.js -- Stdio MCP Transport

Simple stdio transport for local AI tool integration (Claude Code, etc.). Registers ALL tools (including admin-only ones) since local access is trusted.

**To start:** `node bin/kb.js mcp` or `node src/mcp.js`

### bin/kb.js -- Adding CLI Commands

The CLI dispatcher uses a simple command map. To add a new command:

```javascript
// In the commands object:
'my-command': () => import('../src/my-module.js').then(m => m.myFunction(args)),
```

Then add a line to the help text in the usage block at the bottom.

**Existing commands:** `start`, `stop`, `mcp`, `register`, `ingest`, `search`, `status`, `vault reindex`, `classify`, `summarize`, `capture-x`, `safety-check`

### src/classify/ -- Auto-Classification Pipeline

The classification pipeline has three parts:

1. **classifier.js** -- Calls the Claude CLI (`claude -p`) with a classification prompt. Returns structured JSON: `{ type, tags, project, summary, confidence, key_topics }`. Uses `claude-haiku-4-5-20251001` by default (override with `CLASSIFY_MODEL` env var).

2. **processor.js** -- `processNewClippings(vaultPath, { dryRun })` scans the vault for unclassified notes (no `note_type` in frontmatter), runs `classifyNote()` on each, and updates the frontmatter.

3. **summarizer.js** -- `summarizeUnsummarized(vaultPath, { dryRun, limit })` finds notes without summaries and generates AI summaries.

**To use a different model for classification:**
Set `CLASSIFY_MODEL` env var. The classifier spawns the `claude` CLI binary, so any model accessible via Claude Code works. To use a completely different backend (Ollama, OpenAI), replace the `runClaude()` function in `classifier.js`.

### src/embeddings/ -- Semantic Search

1. **embed.js** -- Loads `Xenova/all-MiniLM-L6-v2` (quantized, ~23MB) via HuggingFace Transformers.js. Runs locally, no API key needed. Produces 384-dimensional vectors stored as BLOB in SQLite.

2. **search.js** -- `hybridSearch(query, { limit, project, type })` combines FTS5 keyword results with brute-force cosine similarity over embeddings. Merges and re-ranks. Works well for <2000 notes; for larger collections, consider adding an ANN index.

**To swap embedding models:**
Change the model name in `getEmbedder()` in `embed.js`. Any HuggingFace `feature-extraction` pipeline model works. Update the `dimensions` value in the embeddings table accordingly.

### Using Search -- Quick Reference

The KB has three search modes. Use the right one for the job:

**1. Keyword search (`kb_search`)** -- fast, exact matching
```
# MCP tool
kb_search({ query: "docker networking" })

# REST API
GET /api/v1/search?q=docker+networking

# CLI
kb search "docker networking"
```
Best for: exact terms, error messages, specific names. Uses FTS5 with BM25 ranking and title boosting.

**2. Semantic/hybrid search (`kb_search_smart`)** -- finds conceptually related docs
```
# MCP tool
kb_search_smart({ query: "how do containers talk to each other" })

# REST API
GET /api/v1/search/smart?q=how+do+containers+talk+to+each+other
```
Best for: natural language questions, paraphrases, "I know it's in here but I can't remember the exact words." Combines FTS5 keyword results with cosine similarity over local embeddings (Xenova/all-MiniLM-L6-v2, 384 dimensions). No API keys or external calls -- runs entirely on your machine.

**3. Context briefing (`kb_context`)** -- token-efficient summaries
```
# MCP tool
kb_context({ query: "authentication architecture" })

# REST API
GET /api/v1/context?q=authentication+architecture
```
Best for: getting up to speed on a topic without burning tokens on full documents. Returns a synthesized briefing with source citations. Use this first, then `kb_read` for docs that need deeper reading.

**When to use which:**

| Situation | Use |
|-----------|-----|
| Know the exact term or error message | `kb_search` |
| Searching by concept, not exact words | `kb_search_smart` |
| Need a quick overview before diving in | `kb_context` |
| Need full document content | `kb_context` first, then `kb_read` by ID |

### src/auth.js -- Swapping Auth Providers

Dashboard auth uses bcrypt password hashing with session cookies. The session store is in-memory (Map).

**To add persistent sessions:** Replace the `sessions` Map with a SQLite-backed store using the same `getDb()` connection.

**To swap to a different auth provider:** The `authMiddleware` function is the gate. Replace `checkPassword()` with your provider's verification (LDAP, SSO, etc.) and update `loginHandler` accordingly.

**OAuth (remote access):** Configured in `src/auth-oauth.js` using better-auth with the MCP plugin. The OAuth database is separate (`auth.db`) from the main KB database.

---

## Customization Recipes

### Recipe 1: Add Ollama / Local Model Support

Replace the Claude CLI classifier with a local Ollama model.

**Step 1:** Edit `src/classify/classifier.js`. Replace the `runClaude()` function:

```javascript
async function runOllama(prompt) {
  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CLASSIFY_MODEL || 'llama3',
      prompt,
      stream: false,
      format: 'json',
    }),
  });
  const data = await response.json();
  return JSON.stringify({ result: data.response });
}
```

**Step 2:** Update `classifyNote()` to call `runOllama()` instead of `runClaude()`.

**Step 3:** Set `CLASSIFY_MODEL=llama3` (or your preferred model) in `.env`.

### Recipe 2: Add a New MCP Tool

**Step 1:** Define the tool in `src/tools.js` inside the `getToolDefinitions()` return array. Follow the pattern shown in the Extension Points section above.

**Step 2:** If the tool should be available remotely, leave it out of `ADMIN_ONLY_TOOLS`. If it should be local-only (destructive or admin operations), add its name to the Set.

**Step 3:** Restart the MCP server. For stdio: the next Claude Code session will pick it up. For HTTP: restart the Express server (`kb stop && kb start`).

**Step 4:** If you want the tool accessible via REST API too, add a corresponding route in `src/routes/v1.js`.

### Recipe 3: Deploy with Docker

Create a `Dockerfile` in the project root:

```dockerfile
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

# Data directory
VOLUME /data

ENV KB_DIR=/data
ENV KB_PORT=3838
ENV NODE_ENV=production

EXPOSE 3838

CMD ["node", "bin/kb.js", "start"]
```

Build and run:

```bash
docker build -t knowledge-base-server .
docker run -d \
  --name kb-server \
  -p 3838:3838 \
  -v kb-data:/data \
  -e KB_PASSWORD=your-password \
  -e OBSIDIAN_VAULT_PATH=/vault \
  -v /path/to/vault:/vault:ro \
  knowledge-base-server
```

Note: The `KB_DIR` env var is not currently wired in `src/paths.js` -- it uses `~/.knowledge-base` hardcoded via `homedir()`. For Docker, either set `HOME=/data` or patch `paths.js` to read `process.env.KB_DIR`.

### Recipe 4: Deploy with systemd

A service file is included in the repo at `kb-server.service`.

```bash
# Copy and enable
sudo cp kb-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kb-server

# Check status
sudo systemctl status kb-server
journalctl -u kb-server -f
```

**Key config in the service file:**
- `User=shawn` -- change to your user
- `WorkingDirectory` -- path to the repo
- `ReadWritePaths` -- must include `~/.knowledge-base`, the repo dir, the vault path, and `/tmp`
- `ProtectSystem=strict` and `NoNewPrivileges=true` for security hardening
- `Restart=on-failure` with 5 attempts per 60 seconds

Environment variables should be set in `~/.knowledge-base/.env` (loaded automatically on startup). Run `kb setup` to generate this file.

### Recipe 5: Add New Ingestion Source Type

**Example: Ingest Notion exports.**

**Step 1:** Add a capture module at `src/capture/notion.js`:

```javascript
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export function captureNotion({ title, url, content, tags, project }, vaultPath) {
  const folder = 'sources/notion';
  const destDir = join(vaultPath, folder);
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const filename = `${date}-${slug}.md`;

  const fm = [
    '---',
    `title: "${title}"`,
    `type: source`,
    `source: notion`,
    `url: "${url}"`,
    `created: "${date}"`,
    `tags: [${(tags || '').split(',').map(t => t.trim()).filter(Boolean).join(', ')}]`,
    project ? `project: ${project}` : null,
    `status: active`,
    '---',
  ].filter(Boolean).join('\n');

  writeFileSync(join(destDir, filename), fm + '\n\n' + content);
  return { path: `${folder}/${filename}`, title };
}
```

**Step 2:** Add a tool in `src/tools.js` that calls `captureNotion()`.

**Step 3:** (Optional) Add a CLI command in `bin/kb.js`.

### Recipe 6: Configure for Team / Multi-User

The current system is single-user. To support multiple users:

1. **API keys:** Add per-user keys in `.env` (e.g., `KB_API_KEY_USER_ALICE`, `KB_API_KEY_USER_BOB`). Update `src/middleware/api-key.js` to dynamically read all `KB_API_KEY_*` vars.

2. **OAuth:** The better-auth setup in `src/auth-oauth.js` already supports multiple users. Enable email+password registration or add social providers.

3. **Data isolation:** Currently all users share one database. For per-user isolation, partition by `source` or add a `user_id` column to the `documents` table.

### Recipe 7: Connect to ChatGPT via Custom GPT Actions

The OpenAPI spec at `/openapi.json` is already configured for Custom GPT Actions.

**Step 1:** In ChatGPT, create a Custom GPT. Go to "Configure" -> "Actions" -> "Import from URL".

**Step 2:** Enter `https://your-domain.com/openapi.json`.

**Step 3:** Set authentication to "API Key" with header name `X-API-Key` and value `KB_API_KEY_OPENAI` from your `.env`.

**Step 4:** The GPT can now search, read, and ingest documents into your KB.

### Recipe 8: Set Up OAuth for Remote MCP Access

OAuth is required for remote MCP clients (like Claude.ai connecting to your KB).

**Step 1:** Set environment variables:
```bash
BETTER_AUTH_SECRET=<random-64-char-string>
BETTER_AUTH_URL=https://your-domain.com
```

**Step 2:** The OAuth discovery endpoints are auto-configured:
- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/.well-known/oauth-protected-resource`

**Step 3:** The sign-in page at `/sign-in` handles the consent flow. Users authenticate with email+password.

**Step 4:** MCP clients discover auth via the well-known endpoints, redirect users to `/sign-in`, and receive tokens via the OAuth flow.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `KB_PASSWORD` | Yes (first run) | -- | Dashboard password. Set on first start, hashed with bcrypt. |
| `KB_PORT` | No | `3838` | HTTP server port. |
| `OBSIDIAN_VAULT_PATH` | No | -- | Absolute path to Obsidian vault for indexing and writing notes. Required for `kb_write`, `kb_capture_*`, `kb_classify`, and `kb_synthesize`. |
| `KB_API_KEY_CLAUDE` | No | -- | API key for Claude agent access via HTTP. |
| `KB_API_KEY_OPENAI` | No | -- | API key for OpenAI/ChatGPT access via HTTP. |
| `KB_API_KEY_GEMINI` | No | -- | API key for Gemini agent access via HTTP. |
| `BETTER_AUTH_SECRET` | No | -- | Secret for OAuth token signing. Required for remote MCP OAuth. |
| `BETTER_AUTH_URL` | No | `https://brain.yourdomain.com` | Base URL for OAuth issuer. Set to your public domain. |
| `CLASSIFY_MODEL` | No | `claude-haiku-4-5-20251001` | Model name for AI classification. Passed to `claude -p --model`. |
| `CLAUDE_PATH` | No | `claude` | Path to the Claude CLI binary. Override if not in PATH. |

---

## The Intelligence Pipeline

This section explains how to USE the KB effectively as an agent. Follow this order for maximum efficiency.

### Step 1: Retrieve Before Reading

```
kb_context("docker networking") -> returns summaries of 15 matching docs
```

This costs ~2% of the tokens compared to reading all 15 documents. Use it to decide WHICH documents are worth reading in full.

### Step 2: Read Selectively

```
kb_read(42) -> returns full content of document 42
```

Only read documents that `kb_context` flagged as relevant. Never read all documents "just to understand."

### Step 3: Search Conceptually

```
kb_search_smart("how do we handle authentication") -> hybrid keyword + semantic
```

Use `kb_search_smart` when exact keywords do not match. It combines FTS5 with embedding similarity to find conceptually related documents even when terminology differs.

### Step 4: Capture After Working

After every significant session, capture what you learned:

```
kb_capture_session({
  goal: "Fix Docker networking between containers",
  commands_worked: "- docker network create ...\n- docker compose up",
  commands_failed: "- ping from container A to B (DNS not resolving)",
  root_causes: "Containers were on different Docker networks",
  fixes: "Added shared network in docker-compose.yml",
  lessons: "Always verify containers share a network before debugging DNS",
  project: "infrastructure"
})
```

After fixing a bug:

```
kb_capture_fix({
  title: "SQLite WAL file growing unbounded",
  symptom: "Disk usage increasing 10MB/day",
  cause: "No WAL checkpoint configured",
  resolution: "Added wal_autocheckpoint pragma and periodic TRUNCATE",
  project: "kb-system",
  stack: "node, sqlite"
})
```

### Step 5: Classify and Synthesize Periodically

```
kb_classify({ dry_run: false })    // Classify new unprocessed notes
kb_synthesize({ days: 7 })         // Generate weekly synthesis
```

Classification adds type, tags, summary, and key_topics to notes. Synthesis connects dots across sources to find themes and opportunities.

### Step 6: Safety Check Before Destructive Actions

```
kb_safety_check({
  action: "destroy cloud instance xyz-123",
  context: "Re-encoding job complete, files transferred to NAS"
})
```

The safety checker searches KB for past incidents related to the action, evaluates risk, and returns a verdict. It uses multi-model review (Claude + Gemini + OpenAI) for high-risk actions.

---

## Contributing New Tools

When writing a new MCP tool for this system, follow these conventions:

1. **Naming:** Prefix with `kb_`. Use snake_case. Examples: `kb_search`, `kb_capture_fix`.

2. **Description:** Write for agents, not humans. Be specific about when to use the tool and what it returns. Include token-efficiency guidance if relevant.

3. **Schema:** Use Zod types. Add `.describe()` to every parameter. Use `.optional().default()` for parameters with sensible defaults.

4. **Error handling:** Always wrap handler logic in try/catch. Return `{ isError: true }` on failure with a descriptive message.

5. **Vault awareness:** If the tool writes to the vault, call `indexVault(vaultPath)` after writing so the note is immediately searchable. Wrap in try/catch -- indexing failure should not block the tool response.

6. **Admin gating:** If the tool is destructive or expensive (calls external APIs, modifies files), add it to `ADMIN_ONLY_TOOLS` to restrict HTTP access.

7. **Idempotency:** Prefer idempotent operations. If a tool creates a file, check if it already exists. If it updates a record, use upsert.

8. **Testing:** Add a test in `tests/` using the existing pattern (import the function, call with test data, assert the result).
