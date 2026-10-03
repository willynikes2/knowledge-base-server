# Codebase Map
> Auto-generated. Do NOT edit manually. Regenerate with: `node bin/generate-codemap.js`
> Generated: 2026-03-17

## Quick Stats
- **Files:** 52
- **Total lines:** 5,504

## Architecture Overview
```
src/
  mcp.js          ← MCP server (16 tools: search, write, capture, classify, safety)
  db.js            ← SQLite + FTS5 (documents, vault_files, embeddings tables)
  server.js        ← Express dashboard server
  vault/           ← Obsidian vault indexer + parser
  capture/         ← YouTube, web, X bookmarks, terminal session capture
  classify/        ← AI auto-classification + summarization (uses claude CLI)
  embeddings/      ← Local embeddings (HuggingFace) + hybrid search
  promotion/       ← Knowledge promotion pipeline (prompts + promoter)
  synthesis/       ← Weekly review / cross-source synthesis
  safety/          ← Destructive action review (KB-aware)
  sync/            ← KB ↔ vault bidirectional sync
bin/
  kb.js            ← CLI entry point (start, search, classify, summarize, etc.)
  cron-capture.sh  ← Daily automated capture + classify
  post-sync.sh     ← Post-sync reindex trigger
```

## Root/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| kb-server-install.sh | 72 | - | !/bin/bash |

## bin/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| cron-capture.sh | 30 | - | !/bin/bash |
| generate-codemap.js | 155 | - | Generates a token-efficient codebase map for AI agents |
| init-vault.sh | 36 | - | !/bin/bash |
| kb.js | 91 | - | bin/kb.js — CLI entry point |
| post-sync.sh | 31 | - | !/bin/bash |
| weekly-synthesis.js | 22 | - | Weekly synthesis job — run via cron or manually |
| weekly-synthesis.sh | 9 | - | !/bin/bash |

## src/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| auth-oauth.js | 25 | auth | src/auth-oauth.js — Better Auth OAuth provider for MCP clients |
| auth.js | 149 | hasPassword, setPassword, checkPassword, promptPassword, createSession... | - |
| db.js | 323 | insertDocument, updateDocument, deleteDocument, searchDocuments, listDocuments... | Common English stop words to filter from search queries |
| ingest.js | 140 | ingestFile, ingestDirectory, ingestText | - |
| mcp-http.js | 137 | mcpHttpHandler, mcpGetHandler | - |
| mcp.js | 28 | start | Allow direct execution |
| paths.js | 13 | KB_DIR, FILES_DIR, DB_PATH, CONFIG_PATH, PID_PATH | - |
| server.js | 219 | start | - |
| tools.js | 423 | getToolDefinitions, getHttpToolDefinitions | - |

## src/capture/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| terminal.js | 90 | captureSession, captureFix | - |
| web.js | 37 | captureWeb | - |
| x-bookmarks.js | 65 | parseXBookmarks, captureXBookmarks | - |
| youtube.js | 39 | captureYouTube | - |

## src/classify/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| classifier.js | 104 | classifyNote, classifyBatch | - |
| processor.js | 100 | processNewClippings | - |
| summarizer.js | 118 | summarizeNote, summarizeUnsummarized | - |

## src/cli/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| ingest-cli.js | 36 | ingest | - |
| register.js | 25 | register | - |
| search-cli.js | 26 | search | - |
| setup.js | 577 | setup | --------------------------------------------------------------------------- |
| status.js | 38 | status | - |
| stop.js | 25 | stop | - |
| vault-cli.js | 18 | vaultReindex | - |

## src/embeddings/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| embed.js | 57 | generateEmbedding, embeddingToBuffer, bufferToEmbedding, cosineSimilarity | Convert Float32Array to Buffer for SQLite BLOB storage (3x smaller than JSON) |
| search.js | 88 | semanticSearch, hybridSearch | Brute-force cosine similarity — works for <2000 notes. |

## src/middleware/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.js | 38 | createApiKeyMiddleware | src/middleware/api-key.js |

## src/promotion/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| promoter.js | 92 | promoteNote | Promotion destinations by classification |
| prompts.js | 30 | CLASSIFY_PROMPT, PROMOTE_PROMPT | - |

## src/public/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| app.js | 341 | - | State |

## src/routes/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api.js | 175 | default | All API routes require auth |
| auth-routes.js | 23 | default | - |
| openapi.js | 11 | default | - |
| v1.js | 276 | default | src/routes/v1.js |

## src/safety/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| review.js | 136 | reviewDestructiveAction, multiModelReview | Multi-model review: ask all 3, take the most conservative answer |

## src/sync/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| kb-to-vault.js | 280 | - | KB-to-Vault Sync  Exports all KB documents that don't have corresponding vault f |

## src/synthesis/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| weekly-review.js | 81 | getRecentNotes, generateSynthesisPrompt, writeSynthesisNote | - |

## src/vault/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| indexer.js | 170 | scanVault, indexVault | - |
| parser.js | 81 | parseVaultNote | Map folder prefixes to note types |

## tests/

| File | Lines | Exports | Purpose |
|------|-------|---------|---------|
| api-key.test.js | 57 | - | tests/api-key.test.js |
| db.test.js | 35 | - | - |
| tools.test.js | 51 | - | - |
| v1.test.js | 187 | - | tests/v1.test.js |
| vault-indexer.test.js | 39 | - | Test Research |
| vault-parser.test.js | 55 | - | Test Note |

## Key Data Flows

1. **Intake:** Obsidian clip → sync → vault → `scanVault()` → `parseVaultNote()` → `upsertVaultFile()` → SQLite
2. **Classify:** `processNewClippings()` → `classifyNote()` (claude CLI) → update frontmatter → reindex
3. **Search:** `kb_context` (summaries) → `kb_search` (FTS5) → `kb_search_smart` (FTS5 + embeddings)
4. **Safety:** Hook intercepts Bash → pattern match → `reviewDestructiveAction()` → KB search → block/allow
5. **Capture:** `captureSession()` / `captureFix()` → write to vault → `indexVault()` → searchable

## MCP Tools (16 total)
| Tool | Purpose |
|------|---------|
| kb_search | FTS5 keyword search |
| kb_context | Token-efficient summary briefing (98% savings) |
| kb_search_smart | Hybrid keyword + semantic search |
| kb_read | Read full document by ID |
| kb_list | List docs by type/tag |
| kb_write | Write new note to vault |
| kb_ingest | Ingest text into KB |
| kb_classify | Auto-classify new clippings |
| kb_capture_youtube | Capture YouTube transcript |
| kb_capture_web | Capture web article |
| kb_capture_session | Record debugging session |
| kb_capture_fix | Record bug fix |
| kb_vault_status | Vault indexing stats |
| kb_promote | Promote source to structured knowledge |
| kb_synthesize | Generate cross-source synthesis |
| kb_safety_check | Review destructive action before executing |
