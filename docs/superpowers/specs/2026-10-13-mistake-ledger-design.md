# Mistake ledger: never make the same mistake twice

**Status:** the operator approved the design on 2026-10-13. The answers were:
- sources B: swarm and subagent-build reviews;
- approval B: patterns are drafted automatically and the operator approves them;
- home A: inside the knowledge-base server;
- sections 1–5.

**Grounding (KB):**
- #3370 (WikiSkill: three layers of immutable traces, a compiled wiki and lean skills; SkillOpt: validation-gated edits);
- #3177 (capture the fix, not just the trace; instruction files that only grow);
- #3557 (87 mined agent mistakes and the leakage rule);
- #43 via #3177 (self-improvement gains can be measurement artifacts).

## Why

Agents keep making the same kinds of mistakes, and every reviewer catch is currently lost once the fix merges. The goal is that any mistake one agent makes and a reviewer or test catches is never made again by another agent. With enough practice, builds should pass review first time.

The design has to work for cheap models as well as Claude, and it has to prove its effect with numbers rather than claim it.

## Scope

**Phase 1 (this spec):**
- the mistake ledger;
- capture from swarm runs, subagent-build review ledgers, a manual tool and the October seed;
- pattern drafting with operator approval;
- delivering the matching patterns to agents;
- the live one-shot metric.

**Phase 2 (a later spec):**
- a pre-registered replay proof on cheap models;
- capturing operator corrections (`tasks/lessons.md`, feedback memories).

**Out of scope:**
- fine-tuning;
- changing any reviewer;
- collecting client code without the client's permission. Ledger entries from client jobs are only recorded when the job's config allows it.

## Layers

| Layer | What | Where | Changes? |
|---|---|---|---|
| Raw | Mistake records | `~/.knowledge-base/mistakes/ledger.jsonl` (append-only) | Never edited. A correction is a new record that supersedes an old one. |
| Wiki | Patterns | Vault notes `patterns/<slug>.md`, indexed by the KB | Drafted, then approved, retired or edited by the operator |
| Use | Delivery and metrics | `~/.knowledge-base/mistakes/deliveries.jsonl`, `runs.jsonl` | Append-only |

The ledger is also mirrored as KB documents (`doc_type: mistake`), so search finds it. Records are about 1–2 KB each, so 10,000 is about 20 MB. Existing KB backups cover `~/.knowledge-base/`.

## Mistake record

```json
{
  "id": "mk_<ulid>",
  "at": "2026-10-13T20:11:35Z",
  "source": "swarm | sdd | factory | manual | seed",
  "project": "browser-agent-demo",
  "task": "T4 Run manager",
  "task_text_ref": "docs/superpowers/plans/2026-10-13-live-demo.md#task-4",
  "model": "claude-sonnet-5-5",
  "caught_by": "review:opus | test | operator",
  "finding": "the reviewer's own words",
  "file": "web/src/runs.ts",
  "line": 154,
  "fix_commit": "abc1234",
  "fix_diff": "≤ 4 KB, secrets redacted",
  "guard_test": "tests/web-runs.test.ts › …",
  "tags": ["error-handling", "fallback"],
  "pattern": "pt_<slug> | null",
  "supersedes": "mk_<ulid> | null",
  "client_ok": true
}
```

- Secrets are redacted with the same patterns `src/capture/terminal.js` already uses.
- A record without `fix_commit` is allowed (seed and manual records), and is marked `"evidence": "weak"`.

## Capture

- **Swarm** (agent-swarm):
  - when a fix bead created from a failed review passes its own review, the watcher writes one record per finding;
  - the fix commit is the fix bead's commit;
  - the guard test is the test file the fix changed;
  - written through the KB's HTTP API with the swarm's API key.
- **Subagent builds:**
  - `kb mistakes import-sdd <ledger-dir>` reads `.superpowers/sdd/*/` review files and fix-round reports;
  - it is safe to re-run, keyed by project, task, round and finding hash;
  - a one-time backfill covers CareOps, agent-swarm, Factory and live-demo.
- **Manual:** an MCP tool `kb_mistake_record` with the fields above.
- **Seed:** `kb mistakes import-seed ~/autoresearch/kb-mistakes/catalogue.json`, marked `source: seed`, `evidence: weak`.

## Patterns

**Drafting.** `kb patterns draft`, weekly or on demand:
1. Groups the unassigned mistakes by tags and file area. Then a model clusters them by meaning.
2. Proposes a pattern only for a cluster with mistakes from at least 2 different tasks.
3. Each draft has:
   - a name;
   - a rule of at most 60 words;
   - one bad and one good example, taken from real records;
   - tags;
   - the evidence (record ids);
   - `status: draft`.

**Approval:**
- I publish a page listing the drafts with their evidence. The operator replies "approve 1 and 3, edit 2: …, reject 4".
- `kb patterns set-status` applies the reply.
- Only `approved` patterns are delivered.

**Retirement:** an approved pattern delivered to no task for 90 days is flagged on the next approval page. It is never removed automatically.

**Leakage rule:** each approved pattern is assigned to `teach` or `test` (50/50, fixed at approval). `test` patterns are never delivered, so they stay usable for the phase-2 replay proof.

## Delivery

- **MCP tool `kb_patterns_for({ task_text, files })`:**
  - returns at most 3 approved `teach` patterns;
  - ranks them by search match on task text, files and tags;
  - applies a minimum score, below which it returns none;
  - each pattern comes as its name, rule and good example only.
- **Swarm:** `swarm init` adds a "Known pitfalls" section to each bead's description with the patterns for that task's text and owned files.
- **Subagent builds:** the controller adds the same section to each implementer brief and gives it to the task reviewer as extra checks.
- **Logging:** every delivery is logged to `deliveries.jsonl`, with the run, the task and the pattern ids.

## Metric

Per run and per model:
- tasks attempted;
- tasks that passed their first review (the **one-shot rate**);
- fix rounds;
- the patterns delivered.

These are written to `runs.jsonl` by the swarm at the final review, and by the controller for subagent builds. A KB dashboard panel shows the one-shot rate over time, by model.

## Phase 2 (named, not built here)

**Replay proof:**
- re-run a fixed set of past tasks on a cheap model (Qwen first), with and without their `test`-group patterns' sibling `teach` patterns;
- the sample size and stopping rule are pre-registered;
- the endpoint is the first-review pass rate.

Phase 2 also adds the operator-corrections capture.

## Testing

- Unit tests:
  - record validation and redaction;
  - append-only writes;
  - the supersede rule;
  - SDD import idempotency;
  - the drafting threshold (at least 2 distinct tasks);
  - `kb_patterns_for` limits (at most 3, approved and `teach` only, the score floor);
  - teach/test assignment stability.
- A swarm integration test: a failed review followed by a passed fix writes exactly one record per finding.
- The existing KB suite must pass, with tests run in an isolated HOME.

## Done when

- The live-demo run's caught mistakes are in the ledger.
- The backfill has imported the existing review ledgers and the seed.
- The first approval page has been published.
- An approved pattern appears in the next swarm task it matches.
- The one-shot rate is recorded for that run.
