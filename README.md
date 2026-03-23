# knowledge-base-server

**Make every AI agent you use smarter.**

A persistent memory system that captures, classifies, synthesizes, and retrieves knowledge for AI agents. One brain, multiple agents, compounding intelligence. Production-proven with 200+ documents, three agents (Claude, Codex, Gemini), and daily use.

This is not just a search engine. It is an intelligence pipeline that turns raw information into refined, retrievable knowledge -- and gets smarter every session.

---

## The Problem

AI agents are stateless. Every session starts from zero. You end up:

- Copy-pasting context between sessions
- Re-explaining your codebase, architecture, and preferences
- Watching agents hallucinate because they lack YOUR information
- Losing debugging insights that took hours to discover
- Running multiple agents that can't share what they know

The smarter the model, the more painful the amnesia. Context is the bottleneck, not intelligence.

## The Solution

knowledge-base-server sits between your knowledge and your AI agents. It ingests everything -- your Obsidian vault, code, documents, YouTube transcripts, X bookmarks, terminal sessions -- and serves it through MCP and REST APIs. Every agent you use reads from and writes to the same brain.

**Your AI gets smarter every day. Every session builds on the last.**

```
Obsidian Vault ------+
Code Repos ----------+
YouTube Transcripts --+---> [ KB Server ] ---> SQLite + FTS5 ---> [ MCP ] ---> Claude Code
X/Twitter Bookmarks -+         |                   |                          Codex CLI
Web Clippings -------+     Port 3838          Embeddings          [ REST ] --> Gemini CLI
Terminal Sessions ----+    Web Dashboard      Semantic Search                  ChatGPT
Bug Fix Captures -----+                                                       Any MCP Client
```

**Obsidian is the source of truth** -- the human layer where you organize, link, and curate knowledge. The KB server is the optimized retrieval layer that makes it AI-ready with minimal token usage.

---

## How It Works: The Intelligence Pipeline

This is the core differentiator. Raw information flows through seven layers to become actionable intelligence:

### 1. Capture Layer

Ingest from everywhere:

- **Obsidian vault** -- bidirectional sync, auto-indexes on changes
- **YouTube transcripts** -- via yt-dlp or `kb_capture_youtube`
- **X/Twitter bookmarks** -- browser export to markdown, auto-ingest
- **Web articles** -- Obsidian Web Clipper or `kb_capture_web`
- **Terminal sessions** -- `kb_capture_session` records what worked, failed, and why
- **Bug fixes** -- `kb_capture_fix` records symptom, cause, and resolution
- **Code, PDFs, text** -- 20+ file types with automatic type detection

Every source enters the system as a raw capture, ready for processing.

### 2. Classification Layer

The `kb_classify` tool runs AI classification on unprocessed content:

- Assigns document type (research, idea, workflow, lesson, fix, decision, session)
- Auto-generates tags and project routing
- Writes structured summaries and key topics
- Adds confidence scoring
- Enforces frontmatter discipline on every note

Raw clippings become structured, searchable knowledge automatically.

### 3. Promotion Pipeline

Raw captures get refined into higher-value knowledge artifacts:

- **Captures** in inbox get normalized into **sources**
- Sources get promoted to **insights**, **lessons**, **decisions**, **runbooks**
- The `kb_promote` tool extracts structured knowledge from raw material
- Higher-value knowledge ranks higher in retrieval
- The system distinguishes signal from noise automatically

### 4. Synthesis Layer

The `kb_synthesize` tool connects dots across sources:

- Reads recent notes across all types and projects
- Identifies recurring themes, patterns, and bottlenecks
- Surfaces opportunities and workflow improvements
- Generates cross-cutting insights that no single source contains
- This is where raw information becomes actionable intelligence

### 5. Three-Tier Memory (Cold / Warm / Hot)

Not all knowledge is equal. The system uses three tiers to prevent context pollution:

| Tier | What Lives Here | When Retrieved | Example |
|------|----------------|----------------|---------|
| **Hot** | Active project context, recent sessions, current decisions | First, always | "How did we fix auth yesterday?" |
| **Warm** | Accumulated lessons, research, validated workflows | When relevant to query | "What's our Docker networking pattern?" |
| **Cold** | Raw captures, archived sources, old terminal logs | Only when deep-diving | "What did that YouTube video say about caching?" |

**Why three tiers?** Without tiering, a search for "authentication" returns every raw article you ever clipped alongside your actual auth architecture decision. The tiers ensure agents get signal, not noise. Hot knowledge is always fresh and relevant. Cold knowledge is preserved but doesn't pollute active context.

### 6. Token-Optimized Retrieval

Every token costs money and context window space. The retrieval system minimizes waste:

- `kb_context` returns summaries and metadata WITHOUT full content -- **90%+ token savings**
- `kb_search` uses FTS5 with BM25 ranking, title boosting, and AND-first precision
- `kb_search_smart` combines keyword and semantic search for conceptual queries
- `kb_read` loads full content only when needed, after context identifies relevant docs
- Agents get the right information in the fewest possible tokens

### 7. The Self-Learning Loop

This is the core innovation. The system compounds intelligence over time:

```
Sessions 1-10:    AI makes mistakes. You correct. Fixes get captured.
Sessions 10-50:   AI recognizes patterns. Starts getting things right more often.
Sessions 50-100:  AI knows your codebase, preferences, architecture patterns.
Sessions 100+:    One-shot clean code. Accumulated context covers everything.
```

The loop in detail:

1. AI agent attempts a task
2. Output gets evaluated (human judgment -- the irreplaceable element)
3. Corrections and findings get captured (`kb_capture_session`, `kb_capture_fix`)
4. KB server ingests the session data
5. `kb_synthesize` organizes and connects to existing knowledge
6. Agent instructions auto-update with lessons learned
7. Next session starts with better context
8. Repeat -- compounding improvement

**This is NOT fine-tuning. NOT RLHF.** It is self-modifying instructions through operational history. The model doesn't change. The context it receives does. And context is everything.

---

## Features

**Core**
- SQLite FTS5 full-text search with BM25 ranking and highlighted snippets
- Semantic/vector search via local HuggingFace embeddings (Xenova/all-MiniLM-L6-v2) — no API keys needed
- Hybrid search mode (`kb_search_smart`) combining keyword + semantic for conceptual queries
- Web dashboard for browsing, searching, and managing documents
- CLI for all operations (`kb start`, `kb search`, `kb ingest`, `kb setup`)
- One-command MCP registration (`kb register`)
- Interactive setup wizard (`kb setup`) with agent-compatible auto mode

**Ingestion**
- 20+ file types: Markdown, text, code, PDFs, JSON, YAML, XML, CSV
- Auto-ingest on first run (~/knowledgebase + Claude memory directories)
- Duplicate detection via content hashing
- Obsidian vault bidirectional sync with incremental indexing
- YouTube transcript capture
- X/Twitter bookmark ingestion
- Web article capture with metadata

**Intelligence**
- AI auto-classification (type, tags, summary, key topics, confidence)
- Knowledge promotion pipeline (raw -> structured)
- Cross-source synthesis (themes, patterns, opportunities)
- Three-tier memory (cold/warm/hot) with tier-aware retrieval
- Token-optimized context briefings (90%+ savings over full reads)
- Session and fix capture for operational learning
- Safety review for destructive actions (multi-model consensus)

**Integration**
- MCP server (stdio for local, StreamableHTTP for remote)
- REST API with OpenAPI 3.1 specification
- ChatGPT Custom GPT Actions via OpenAPI import
- OAuth 2.1 with OIDC discovery for remote access
- API key authentication for scripts and automation
- systemd service with auto-restart for production deployment

**Security**
- bcrypt password hashing with HttpOnly session cookies
- Dual auth: API keys (fast path) + OAuth Bearer tokens
- Three separate API keys for Claude, OpenAI, and Gemini
- Safety review tool checks KB history before destructive actions
- No external dependencies for core functionality

---

## Quickstart

### Prerequisites

- Node.js >= 18.0.0
- That's it. No external databases, no Docker required, no cloud dependencies.

### Install

```bash
git clone https://github.com/willynikes2/knowledge-base-server.git
cd knowledge-base-server
npm install
npm link
```

### First Run (Interactive Setup Wizard)

```bash
kb setup
```

The wizard detects your environment, asks which AI agents you use, configures everything, and runs your first ingest. Takes about 60 seconds.

For agent-driven installation (no prompts):

```bash
kb setup --auto --password=yourpass --vault=~/obsidian-vault --agents=claude,codex --deploy=systemd
```

### Manual Setup

```bash
KB_PASSWORD=yourpassword kb start    # Start server on port 3838
kb register                          # Register MCP with Claude Code
kb ingest ~/obsidian-vault           # Ingest your knowledge
kb search "docker networking"        # Search from terminal
kb status                            # Check stats
```

### Connect to Claude Code

After `kb register`, Claude Code automatically has access to all KB tools. Test it:

```
> Search the knowledge base for recent bug fixes
```

Claude will use `kb_search` and return results from your accumulated knowledge.

---

## Don't Want to Self-Host? Use Memstalker

**[Memstalker](https://memstalker.com)** is the hosted version of knowledge-base-server. Same engine, zero infrastructure.

| | Self-Hosted (Free) | Memstalker Hosted |
|---|---|---|
| **Cost** | Free forever | From $12/mo |
| **Setup** | Clone, install, configure | Sign up, connect your agents |
| **Infrastructure** | You run the VPS | We handle everything |
| **Updates** | `git pull` | Automatic |
| **Multi-device sync** | You configure | Built-in |
| **Backups** | You manage | Automatic |
| **All 16 MCP tools** | Yes | Yes |
| **Obsidian integration** | Yes | Yes |
| **REST API + ChatGPT** | Yes | Yes |

**Self-host if:** You want full control, have a VPS, and enjoy running your own infrastructure.

**Use Memstalker if:** You want persistent AI memory without managing servers. Connect your agents in minutes.

First 500 early adopters get Pro at $12/mo forever (normally $25): [memstalker.com](https://memstalker.com)

---

## MCP Tools

All 16 tools available via MCP (stdio and HTTP):

| Tool | Description |
|------|-------------|
| `kb_search` | Full-text search with BM25 ranking and highlighted snippets |
| `kb_search_smart` | Hybrid keyword + semantic search for conceptual queries |
| `kb_context` | Token-efficient briefing -- summaries only, 90%+ savings. Use BEFORE kb_read |
| `kb_read` | Read full document content by ID |
| `kb_list` | List documents filtered by type or tag |
| `kb_write` | Write a new note to the Obsidian vault |
| `kb_ingest` | Ingest raw text directly into the database |
| `kb_classify` | Auto-classify unprocessed notes (type, tags, summary) |
| `kb_promote` | Promote raw source into structured knowledge |
| `kb_synthesize` | Generate cross-source synthesis connecting recent knowledge |
| `kb_capture_session` | Record a debugging/coding session with findings |
| `kb_capture_fix` | Record a bug fix with symptom, cause, resolution |
| `kb_capture_web` | Capture a web article with content and metadata |
| `kb_capture_youtube` | Capture a YouTube transcript with metadata |
| `kb_vault_status` | Show vault indexing stats by type and project |
| `kb_safety_check` | Review a destructive action against KB history |

---

## CLI Commands

```
kb setup              Interactive setup wizard (--auto for agent mode)
kb start              Start the dashboard + API server (default :3838)
kb stop               Stop the running server
kb mcp                Start MCP stdio server (used by AI tools)
kb register           Register MCP server with Claude Code
kb ingest <path>      Ingest a file or directory
kb search <query>     Search documents from terminal
kb status             Show stats and server status
kb classify           Auto-classify unprocessed vault notes
kb summarize          Generate AI summaries for unsummarized notes
kb capture-x          Ingest X/Twitter bookmarks from export
kb safety-check       Review a planned action against KB history
```

---

## Architecture

```
                         +------------------+
                         |   AI Agents      |
                         | Claude | Codex   |
                         | Gemini | ChatGPT |
                         +--------+---------+
                                  |
                    MCP (stdio)   |   REST API (/api/v1/)
                    MCP (HTTP)    |   OpenAPI 3.1
                                  |
                         +--------+---------+
                         |    KB Server     |
                         |   Express :3838  |
                         +--------+---------+
                                  |
              +-------------------+-------------------+
              |                   |                   |
     +--------+-------+  +-------+--------+  +-------+--------+
     | SQLite + FTS5   |  |  Embeddings    |  |  Obsidian      |
     | documents       |  |  all-MiniLM    |  |  Vault Sync    |
     | vault_files     |  |  L6-v2 local   |  |  (bidirectional)|
     | embeddings      |  |  cosine sim    |  |  source of truth|
     +----------------+  +----------------+  +----------------+
```

Data directory: `~/.knowledge-base/`
- `kb.db` -- SQLite database with FTS5 index
- `files/` -- Ingested file copies
- `config.json` -- Password hash and settings

---

## Supported File Types

| Category | Extensions |
|----------|-----------|
| Markdown | .md |
| Text | .txt, .log, .json, .yaml, .yml, .xml, .csv |
| Code | .js, .ts, .jsx, .tsx, .py, .go, .rs, .java, .rb, .sh, .bash, .c, .cpp, .h, .hpp, .html, .css, .sql, .toml |
| PDF | .pdf (with text extraction) |
| Config | .env, .ini, .cfg, .conf |

---

## Content Ingestion Examples

### Obsidian Vault

```bash
# Set vault path in .env
OBSIDIAN_VAULT_PATH=~/obsidian-vault

# Or ingest manually
kb ingest ~/obsidian-vault
```

The vault indexer tracks file hashes for incremental updates -- only changed files get re-indexed.

### YouTube Transcripts

```bash
# Download transcript
yt-dlp --write-auto-sub --skip-download -o transcript https://youtube.com/watch?v=VIDEO_ID

# Or use the MCP tool directly from your AI agent:
# kb_capture_youtube with URL and transcript text
```

### X/Twitter Bookmarks

```bash
# Export bookmarks to markdown using twitter-web-exporter (browser extension)
# Then ingest:
kb ingest ~/bookmarks/x_bookmarks.md

# Or use the built-in capture command:
kb capture-x ~/path/to/x_bookmarks.md
```

### Terminal Sessions

From your AI agent after a debugging session:

```
Use kb_capture_session to record:
- goal: "Fix authentication flow for email users"
- commands_worked: "docker exec postgres psql query"
- commands_failed: "curl returned 401 - missing jellyfin_user_id"
- root_causes: "Email login path didn't propagate jellyfin_user_id to frontend"
- fixes: "Added jellyfin_user_id to auth response schema"
- lessons: "Always check all auth paths when adding fields to user response"
```

### Bug Fixes

```
Use kb_capture_fix to record:
- title: "Library page blank for email login users"
- symptom: "Library page shows empty, no media items loaded"
- cause: "jellyfin_user_id not included in email auth response"
- resolution: "Added field to shared auth schema, redeployed"
```

---

## Multi-Agent Setup

### Claude Code (MCP -- Native)

```bash
kb register    # Writes to ~/.claude.json automatically
```

All 16 MCP tools become available in Claude Code immediately.

### Codex / Other MCP Agents

Point your MCP client at the stdio transport:

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["/path/to/knowledge-base-server/bin/kb.js", "mcp"]
    }
  }
}
```

### ChatGPT Custom GPTs (REST API)

1. Import the OpenAPI spec from `https://your-domain.com/openapi.json`
2. Set authentication to API Key with header `X-API-Key`
3. ChatGPT can now search, read, and write to your knowledge base

REST API endpoints at `/api/v1/`:
- `GET /api/v1/search?q=query` -- Full-text search
- `GET /api/v1/search/smart?q=query` -- Semantic search
- `GET /api/v1/context?q=query` -- Token-efficient briefing
- `GET /api/v1/documents` -- List documents
- `GET /api/v1/documents/:id` -- Read document
- `POST /api/v1/ingest` -- Ingest content
- `POST /api/v1/capture/session` -- Capture session
- `POST /api/v1/capture/fix` -- Capture fix
- `POST /api/v1/capture/web` -- Capture web content

### Running Multiple Agents Simultaneously

All agents connect to the same KB server. What Claude learns in one session, Codex and Gemini can access in the next. The KB is the shared brain.

For remote agents, set up API keys in `.env`:

```bash
KB_API_KEY_CLAUDE=your-unique-key-for-claude
KB_API_KEY_OPENAI=your-unique-key-for-openai
KB_API_KEY_GEMINI=your-unique-key-for-gemini
```

---

## Agentic Installation

This repo is designed to be set up BY AI agents, not just for them.

1. User clones the repo
2. User tells their AI: "Read llms.txt and EXTENDING.md, then set this up for me"
3. Agent reads `llms.txt` (30 seconds to understand the full system)
4. Agent reads `EXTENDING.md` (deep customization guide written FOR agents)
5. Agent runs `kb setup --auto` with appropriate flags for the user's environment
6. Done. Every deployment is unique -- security by customization.

The wizard detects your OS, available AI tools, Obsidian vault location, and preferred deployment method. It generates a custom `.env`, registers MCP, installs the service, and runs the first ingest.

**For the non-technical user:** `kb setup` and answer 5 questions.
**For the programmer:** Everything is in `.env` and composable. Override anything.
**For the AI agent:** `kb setup --auto` with flags. Zero prompts.

---

## The Self-Learning Workflow

This repo includes templates for the self-learning development methodology:

```
docs/workflow/
  CLAUDE.md.template     -- Operating contract for Claude Code
  AGENTS.md.template     -- Cross-agent rules (Claude, Codex, Gemini)
  SELF-LEARNING.md       -- The full methodology: three-tier memory,
                            intelligence pipeline, compounding loop,
                            multi-agent self-learning, Obsidian integration
```

Copy these templates to your project root and customize them. They define:

- How agents should search the KB before starting work
- When and how to capture session findings
- The self-learning loop that compounds intelligence
- Multi-agent coordination rules
- Verification standards

These are the actual development patterns used to build this system. Open sourced so you can adopt the same workflow.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KB_PASSWORD` | Yes (first run) | -- | Dashboard login password |
| `KB_PORT` | No | 3838 | HTTP server port |
| `OBSIDIAN_VAULT_PATH` | No | -- | Obsidian vault path for sync |
| `KB_API_KEY_CLAUDE` | No | -- | API key for Claude remote access |
| `KB_API_KEY_OPENAI` | No | -- | API key for OpenAI/ChatGPT access |
| `KB_API_KEY_GEMINI` | No | -- | API key for Gemini access |
| `BETTER_AUTH_SECRET` | No | -- | OAuth token signing secret |
| `BETTER_AUTH_URL` | No | -- | OAuth issuer URL for remote access |
| `CLASSIFY_MODEL` | No | claude-haiku-4-5-20251001 | Model for AI classification |

---

## systemd Service

For production deployment with auto-restart:

```bash
sudo cp kb-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable kb-server
sudo systemctl start kb-server
```

Or use the setup wizard: `kb setup` and select "systemd" as the deployment mode.

The service restarts automatically on failure with a 5-second delay. Logs via `journalctl -u kb-server -f`.

---

## Why This Exists

I built this because I run three AI agents (Claude, Codex, Gemini) across multiple projects. Without shared context, each agent starts from zero every session. I was copy-pasting context, re-explaining architecture, and losing debugging insights that took hours to discover.

With the KB server, all three agents share the same brain. Claude captures a bug fix at 2am, Codex finds it the next morning. Gemini reviews code with full project history. The system gets smarter every day -- not because the models improve, but because the context they receive compounds.

The cost model: $60/month total for three agents via CLI subscription wrapping (not per-token API billing). The KB server runs on a $5/month VPS alongside everything else. The ROI is measured in hours of context re-discovery that never need to happen again.

AI is only as good as its context. This is the context layer.

---

## Roadmap

- [ ] Watch mode for auto-ingesting new vault files in real-time
- [ ] Multi-user support with role-based access
- [x] Hosted SaaS version -- **[memstalker.com](https://memstalker.com)** (self-hosted remains free and full-featured)
- [ ] Plugin system for custom ingestion sources
- [ ] Ollama integration for fully local AI classification
- [ ] WebSocket real-time updates on the dashboard
- [ ] Export/import for knowledge base migration

---

## License

MIT -- see [LICENSE](LICENSE)

---

## Author

Built by [Shawn Daniel](https://github.com/willynikes2) with significant contributions from Claude, Codex, and Gemini -- the first three users of the system they helped build.

"You gotta 100-shot 10 apps before you can 1-shot 10 apps."
