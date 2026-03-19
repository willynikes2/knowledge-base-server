## Hybrid Memory Protocol

Two memory systems. Never conflate them.

### System Roles
- `.agent-memory/` = per-project deterministic state. MEMORY.md always loaded. Topic files on-demand. Authoritative for THIS project.
- Knowledge Base (KB) = cross-project searchable layer via MCP tools. Authoritative for reusable knowledge across all projects.
- `.agent-memory/` answers "what is true about THIS project right now."
- KB answers "what have we learned across ALL projects ever."

### Session Start Protocol
Execute in this exact order:
1. Read `.agent-memory/MEMORY.md` in full. Check ## Status for blockers.
2. Load topic files from `.agent-memory/` ONLY if relevant to the current task.
3. Call `kb_context` with the current task/topic to surface cross-project knowledge.
4. Review KB summaries. Call `kb_read` ONLY for docs directly relevant to the task.
5. If the task resembles a past bug or decision, call `kb_search` with the symptom or decision name.
- Never skip step 1. Never do step 4 before step 3.
- If `.agent-memory/` does not exist, skip steps 1-2. Still do steps 3-5.

### Retrieval Decision Tree
Given a question, pick the correct source:

| Question type | Source | Tool/File |
|---|---|---|
| Project status, blockers, next step | `.agent-memory/` | MEMORY.md ## Status |
| Project conventions, code style | `.agent-memory/` | conventions.md |
| Project architecture decisions | `.agent-memory/` | architecture-decisions.md |
| Known project bugs and fixes | `.agent-memory/` | debugging-patterns.md |
| Project environment, setup | `.agent-memory/` | environment.md |
| "How did we solve X before?" (any project) | KB | `kb_search` or `kb_search_smart` |
| "What do we know about X?" (general) | KB | `kb_context` → `kb_read` |
| "Has this bug happened before?" | KB first, then `.agent-memory/` | `kb_search` symptom → debugging-patterns.md |
| Research, external knowledge | KB | `kb_search_smart` |
| Past session learnings | KB | `kb_search` or `kb_context` |

- When both systems might have answers: check `.agent-memory/` first (cheaper, no MCP call), then KB.
- When `.agent-memory/` has project-specific info that contradicts KB general info: project-specific wins.

### Write Decision Tree
After producing knowledge, persist it to the correct system:

| Knowledge type | Destination | How |
|---|---|---|
| Project status change | `.agent-memory/` | Update MEMORY.md ## Status |
| Feature state change | `.agent-memory/` | Update MEMORY.md ## Active Features |
| New project convention | `.agent-memory/` | Add to conventions.md + MEMORY.md ## Critical Conventions |
| New project pitfall | `.agent-memory/` | Add to debugging-patterns.md + MEMORY.md ## Known Pitfalls |
| Bug fix (reusable across projects) | Both | debugging-patterns.md AND `kb_capture_fix` |
| Bug fix (project-specific only) | `.agent-memory/` | debugging-patterns.md only |
| Architecture decision | Both | architecture-decisions.md AND `kb_write` type=decision |
| Session progress | `.agent-memory/` | Append to progress.md |
| Debugging session learnings | KB | `kb_capture_session` |
| Research findings | KB | `kb_write` type=research |
| General lesson learned | KB | `kb_write` type=lesson |

- Rule: if it helps only THIS project → `.agent-memory/`. If it helps FUTURE projects → KB. If both → both.
- Never duplicate full content between systems. `.agent-memory/` gets the project-specific version. KB gets the generalized version.

### Session End Protocol
Execute in this order:
1. Update `.agent-memory/MEMORY.md` — refresh ## Status, ## Active Features. Remove stale entries.
2. Append to `.agent-memory/progress.md` — what was done this session, one entry, newest on top.
3. If a bug was fixed: write to debugging-patterns.md. If reusable, also `kb_capture_fix`.
4. If a significant debugging/implementation session occurred: call `kb_capture_session` with goal, what worked, what failed, root causes, fixes, lessons.
5. If a decision was made: write to architecture-decisions.md. If cross-project relevant, also `kb_write` type=decision.
6. Verify MEMORY.md is under 200 lines. Prune if needed.
- Never skip steps 1-2. Steps 3-5 are conditional.

### Context Crisis Protocol (>40% Context Used)
When context window usage exceeds 40%:
1. Immediately write a handoff note to `.agent-memory/MEMORY.md` ## Status:
   - Current task and exact stopping point.
   - What is done, what remains.
   - Key decisions made this session.
   - Blockers or open questions.
2. Call `kb_capture_session` with full session state — goal, progress, failures, lessons.
3. Update `.agent-memory/progress.md` with session progress so far.
4. If mid-debugging: write current hypotheses and ruled-out causes to debugging-patterns.md.
5. Tell the user: context is high, recommend starting a new session.
6. The new session will recover state via Session Start Protocol — MEMORY.md has the handoff, KB has the session capture.
- Do NOT wait until 80%. At 40%, start preparing. At 60%, execute steps 1-4 immediately.
- The handoff note in MEMORY.md ## Status is the critical recovery path. Make it complete.

### Anti-Patterns
- NEVER store cross-project knowledge only in `.agent-memory/`. It dies with the project.
- NEVER call `kb_read` without `kb_context` first. Summaries before full docs. Always.
- NEVER load all `.agent-memory/` topic files at session start. Only load what the task needs.
- NEVER skip `kb_context` at session start because "this is a simple task." Simple tasks hit known bugs too.
- NEVER duplicate verbose content between systems. `.agent-memory/` gets project-specific. KB gets generalized.
- NEVER let MEMORY.md exceed 200 lines. It loads every session. Every line costs tokens.
- NEVER write secrets, credentials, or env var values to either system.
- NEVER treat KB as a dump. Use `kb_capture_fix`, `kb_capture_session`, `kb_write` with proper types and structure.
- NEVER skip session end protocol. A session without capture is a session wasted.

### KB Tool Quick Reference
| Tool | Use for | Token cost |
|---|---|---|
| `kb_context("topic")` | Summaries only, always start here | ~100/doc |
| `kb_search("query")` | Exact keyword lookup | ~200/result |
| `kb_search_smart("query")` | Fuzzy/conceptual match | ~200/result |
| `kb_read(id)` | Full doc content (after context confirms relevance) | ~500-5000/doc |
| `kb_write(title, type, content)` | Persist decisions, research, lessons | — |
| `kb_capture_session(...)` | Record debugging/implementation sessions | — |
| `kb_capture_fix(...)` | Record bug symptom → cause → fix | — |
| `kb_synthesize(...)` | Cross-cutting insights across sources | — |
