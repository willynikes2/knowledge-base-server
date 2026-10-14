# Mistake ledger

The knowledge base keeps every mistake a reviewer or test catches in an agent's work, together with its fix. Mistakes that repeat become short rules ("patterns"). You approve the rules, and agents are given the matching ones before they start a task.

## Where things live

| What | Where |
|---|---|
| Mistake records (append-only) | `~/.knowledge-base/mistakes/ledger.jsonl` |
| Which patterns were given to which task | `~/.knowledge-base/mistakes/deliveries.jsonl` |
| First-review numbers per run | `~/.knowledge-base/mistakes/runs.jsonl` |
| Patterns | vault notes `patterns/<slug>.md` |

Records are never edited. To correct one, record a new one with `supersedes` set to the old id. Every record is also copied into the KB as a document of type `mistake`, so `kb search` finds it.

Set `KB_MISTAKES_HOME` to keep the three files somewhere else.

## Recording mistakes

- **Swarm builds** send their review findings by themselves when a fix passes review (agent-swarm, `KB_API_KEY_SWARM`).
- **Subagent builds:** `kb mistakes import-sdd <repo>/.superpowers/sdd --project=<name> --client-ok`. Run it as often as you like; nothing is imported twice.
- **By hand:** the MCP tool `kb_mistake_record`, or `kb mistakes record <record.json>`.
- **The October catalogue:** `kb mistakes import-seed ~/autoresearch/kb-mistakes/catalogue.json`.

`--client-ok` (or `"client_ok": true`) says the owner of the code allows keeping the record. For your own projects that is always true. For a client's code, only with their permission.

A record with a fix commit is **strong** evidence; one without is **weak**.

## From mistakes to patterns

1. `kb patterns draft` asks a model to group the unassigned mistakes. A draft is only written when its mistakes come from at least 2 different tasks, its rule has at most 60 words, and it has a real bad example and a real good example.
2. `kb patterns page` writes the approval page and remembers its numbering.
3. Reply with the numbers on the page: `kb patterns set-status "approve 1 and 3, edit 2: <your wording>, reject 4"`.
   - **approve** — agents may be given the rule;
   - **edit** — approve it with your wording;
   - **reject** — never propose it again from the same mistakes;
   - **retire** — stop using an approved pattern.
   If any part of the reply is wrong, nothing changes.

Half of the approved patterns go to the `teach` group and are given to agents. The other half go to the `test` group and are held back, so a later experiment can measure whether patterns help on agents that never saw them.

An approved pattern that no task has received for 90 days is listed on the next approval page. Nothing is retired automatically.

## Giving patterns to agents

`kb_patterns_for({ task_text, files })` returns at most 3 approved `teach` patterns that match the task, as a ready "Known pitfalls" section. It returns nothing when no pattern matches well enough.

- **Swarm builds:** `swarm init` adds that section to each task.
- **Subagent builds:** the controller calls `kb_patterns_for` for each task, puts the section in the implementer's brief, and gives the same section to the task's reviewer as extra things to check.

## Seeing whether it works

`kb mistakes stats`, or the **Learning** page of the dashboard, shows how many tasks passed their first review, per model and per run.

A swarm sends its numbers by itself at the final review. After a subagent build, the controller records them with `kb mistakes record-run <run.json>`:

```json
{ "source": "sdd", "project": "my-project", "run": "2026-10-14-feature", "model": "sonnet", "attempted": 9, "first_pass": 6, "fix_rounds": 4, "patterns_delivered": ["pt_fail-closed"] }
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `KB_MISTAKES_HOME` | `~/.knowledge-base/mistakes` | Folder for the ledger files |
| `KB_API_KEY_SWARM` | none | API key the swarm uses to write records |
| `KB_PATTERN_MODEL` | `claude-sonnet-5-5` | Model used by `kb patterns draft` |
