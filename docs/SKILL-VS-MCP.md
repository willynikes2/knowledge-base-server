# Skill vs MCP Server — What's the Difference?

This project ships two ways to use it. They solve different problems and work best together.

## The MCP Server (Tools)

**What it is:** A set of 16 tools your AI agent can call on-demand to search, read, write, and manage your knowledge base.

**How it works:** Your agent decides when to call a tool. It sends a request ("search for X"), gets back results, and uses them. No tokens are spent until a tool is called.

**Install:** `kb register` adds it to Claude Code, Codex, and Gemini. You can limit targets with `kb register --agents=claude,codex`.

**Token cost:** ~500 tokens for tool definitions (always in context) + whatever results come back per call.

**Good for:** The actual work — searching, reading docs, capturing sessions, ingesting content. This is the engine.

## The Skill (Instructions)

**What it is:** A set of instructions that teach your agent HOW to use the KB efficiently. It's loaded when invoked (via `/kb-workflow` or when the agent detects it's relevant).

**How it works:** When activated, the skill content (~1500 tokens) is injected into the agent's context. It tells the agent the retrieval strategy, when to search, what to capture, and the self-learning pattern.

**Install:** Copy `skill/SKILL.md` to your Claude Code skills directory.

**Token cost:** ~1500 tokens when loaded. Zero when not loaded.

**Good for:** Teaching the agent the workflow — "search before coding", "use context before read", "capture after debugging". This is the driving manual.

## Why Both?

Without the skill, your agent has 16 tools but no strategy for when to use them. It might:
- Skip searching and miss relevant context
- Read full documents when summaries would suffice (wasting 90% more tokens)
- Forget to capture findings after a session

Without the MCP server, your agent has instructions but no tools. It knows it SHOULD search but can't.

**Together:** The agent knows the efficient workflow AND has the tools to execute it.

## Comparison Table

| | MCP Server | Skill |
|---|---|---|
| **What** | 16 tools (search, read, write, capture...) | Instructions for using those tools efficiently |
| **When loaded** | Always (tool definitions in context) | On-demand (when invoked or relevant) |
| **Token cost** | ~500 base + per-call results | ~1500 when active, 0 when not |
| **Required?** | Yes — this IS the KB | No, but strongly recommended |
| **Works without the other?** | Yes, but agent may use tools inefficiently | No — needs the MCP tools to actually do anything |
| **Analogy** | The car engine | The driving lessons |

## Installation

### MCP Server Only (Minimum)

```bash
git clone https://github.com/willynikes2/knowledge-base-server.git
cd knowledge-base-server
npm install && npm link
kb setup
kb register   # Registers MCP tools with Claude Code, Codex, and Gemini
```

Your agent now has all 16 KB tools.

### MCP Server + Skill (Recommended)

After installing the MCP server:

**Claude Code:**
```bash
# Copy skill to your project or global skills directory
cp -r skill/ ~/.claude/skills/kb-workflow/
# Or symlink it
ln -s $(pwd)/skill ~/.claude/skills/kb-workflow
```

Then invoke with `/kb-workflow` in Claude Code, or the agent will auto-detect it when relevant.

**Other agents:**
The skill is just a markdown file. Include its content in your agent's system prompt or instructions file. For example:
- Codex: Add to `~/.codex/instructions.md`
- Gemini: Add to `~/.gemini/GEMINI.md`
- Custom agents: Include in your system prompt

### What About Other Platforms?

| Platform | MCP Server | Skill |
|----------|-----------|-------|
| Claude Code / Codex / Gemini | `kb register` | Copy to skills dir |
| Claude Web | Connect via remote MCP | Not applicable (use custom instructions) |
| ChatGPT | Import OpenAPI spec | Add to Custom GPT instructions |
| Codex CLI | MCP config in `.codex/mcp.json` | Add to `instructions.md` |
| Gemini CLI | MCP config in `settings.json` | Add to `GEMINI.md` |
| Cursor/Windsurf | MCP config | Include in rules |
| Custom agents | REST API or MCP | Include in system prompt |

## FAQ

**Q: Can I use just the skill without the MCP server?**
A: No. The skill teaches how to use tools — without the MCP server, there are no tools to use.

**Q: Can I use just the MCP server without the skill?**
A: Yes, but your agent won't know the efficient retrieval pattern. It might read full documents when summaries would do, or skip capturing findings after work.

**Q: Does the skill cost tokens even when I'm not using the KB?**
A: Only when loaded/invoked. If you use it as a Claude Code skill, it's loaded on-demand. If you paste it into a system prompt, it's always loaded (~1500 tokens).

**Q: Which saves more tokens?**
A: They serve different purposes, but together they save the most. The skill teaches the agent to use `kb_context` (summaries) before `kb_read` (full docs) — that one pattern saves 90%+ tokens on every KB interaction.
