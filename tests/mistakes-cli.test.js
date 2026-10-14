// tests/mistakes-cli.test.js — `kb mistakes …` and `kb patterns …`.
// HOME is replaced before anything from src/ is loaded, so no test touches the real ~/.knowledge-base.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kb-cli-home-'));
process.env.HOME = HOME;

const { mistakesCmd, patternsCmd, MISTAKES_USAGE, PATTERNS_USAGE } = await import('../src/cli/mistakes-cli.js');
const { currentMistakes, recordMistake } = await import('../src/mistakes/store.js');
const { getPattern, listPatterns } = await import('../src/mistakes/patterns.js');

let ledgerHome; let vault; let work; let lines;
const log = (line) => lines.push(String(line));
const noMirror = () => {};
const noReindex = async () => {};
beforeEach(() => {
  ledgerHome = mkdtempSync(join(tmpdir(), 'kb-cli-ledger-')); process.env.KB_MISTAKES_HOME = ledgerHome;
  vault = mkdtempSync(join(tmpdir(), 'kb-cli-vault-')); process.env.OBSIDIAN_VAULT_PATH = vault;
  work = mkdtempSync(join(tmpdir(), 'kb-cli-work-'));
  lines = [];
});
afterEach(() => {
  delete process.env.KB_MISTAKES_HOME; delete process.env.OBSIDIAN_VAULT_PATH;
  for (const d of [ledgerHome, vault, work]) rmSync(d, { recursive: true, force: true });
});
after(() => rmSync(HOME, { recursive: true, force: true }));

const add = (task, extra = {}) => recordMistake({ source: 'swarm', project: 'demo', task, caught_by: 'review:opus', client_ok: true,
  finding: `unreadable state treated as empty in ${task}`, fix_commit: 'abc1234', fix_diff: '+throw e;', ...extra }).id;

describe('kb mistakes', () => {
  it('prints the usage for no command and for an unknown one', async () => {
    await assert.rejects(mistakesCmd([], { log }), (e) => e.message.includes(MISTAKES_USAGE));
    await assert.rejects(mistakesCmd(['explode'], { log }), /Usage: kb mistakes/);
    await assert.rejects(mistakesCmd(['import-seed'], { log }), /Usage: kb mistakes/);
  });

  it('import-sdd needs --project and --client-ok, then imports and is safe to repeat', async () => {
    const dir = join(work, 'repo', '.superpowers', 'sdd', 'build');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'progress.md'), '# SDD ledger — plan: docs/plan.md\nImplementers: sonnet\n');
    writeFileSync(join(dir, 'task-2-fix1.md'), '## 1. Fails open\nunreadable file counted as empty\n## 2. No test\nadd one');
    await assert.rejects(mistakesCmd(['import-sdd', dir, '--client-ok'], { log, mirror: noMirror }), /project name is required/);
    await assert.rejects(mistakesCmd(['import-sdd', dir, '--project=demo'], { log, mirror: noMirror }), /--client-ok/);
    await mistakesCmd(['import-sdd', dir, '--project=demo', '--client-ok'], { log, mirror: noMirror });
    await mistakesCmd(['import-sdd', dir, '--project=demo', '--client-ok'], { log, mirror: noMirror });
    assert.deepStrictEqual(lines, ['Imported 2 mistakes from 1 ledger(s); 0 were already there; 2 have no fix commit (weak evidence).',
      'Imported 0 mistakes from 1 ledger(s); 2 were already there; 0 have no fix commit (weak evidence).']);
  });

  it('import-seed reports what it added and what it skipped', async () => {
    const file = join(work, 'catalogue.json');
    writeFileSync(file, JSON.stringify([{ kb_id: 1, title: 'First', project: 'p', kind: 'bug-in-code' }, { title: 'no id' }]));
    await mistakesCmd(['import-seed', file], { log, mirror: noMirror });
    assert.strictEqual(lines[0], 'Imported 1 of 2 catalogue rows; 0 were already there; 1 skipped.');
    assert.match(lines[1], /row 1: a seed row needs kb_id and title/);
  });

  it('record and record-run read a JSON file; a bad file says which file', async () => {
    const rec = join(work, 'rec.json');
    writeFileSync(rec, JSON.stringify({ source: 'manual', project: 'demo', task: 'FINAL', caught_by: 'review:opus', finding: 'steps shown twice', client_ok: true, fix_commit: 'a8e839c' }));
    await mistakesCmd(['record', rec], { log, mirror: noMirror });
    assert.strictEqual(JSON.parse(lines[0]).duplicate, false);
    const run = join(work, 'run.json');
    writeFileSync(run, JSON.stringify({ source: 'sdd', project: 'demo', run: 'build-1', model: 'sonnet', attempted: 9, first_pass: 4, fix_rounds: 12 }));
    await mistakesCmd(['record-run', run], { log });
    assert.deepStrictEqual(JSON.parse(lines[1]), { key: '["sdd","demo","build-1","sonnet"]', duplicate: false });
    await assert.rejects(mistakesCmd(['record', join(work, 'missing.json')], { log }), /cannot read JSON from .*missing\.json/);
    writeFileSync(rec, '{"source":"manual"}');
    await assert.rejects(mistakesCmd(['record', rec], { log, mirror: noMirror }), /client_ok is required/);
  });

  it('list shows current mistakes, --unassigned leaves out the ones a pattern uses, --json prints records', async () => {
    const a = add('T2'); const b = add('T4'); add('T9');
    await patternsCmd(['draft'], { log, reindex: noReindex, llm: async () => JSON.stringify([{ name: 'Fail closed', rule: 'Only a missing file is empty.', tags: ['state'], ids: [a, b] }]) });
    lines = [];
    await mistakesCmd(['list'], { log });
    assert.strictEqual(lines.at(-1), '3 mistake(s).');
    assert.match(lines[0], /^mk_\w{26} {2}\d{4}-\d\d-\d\d {2}swarm {2}strong demo \/ T2: unreadable state/);
    lines = [];
    await mistakesCmd(['list', '--unassigned'], { log });
    assert.strictEqual(lines.at(-1), '1 mistake(s).');
    lines = [];
    await mistakesCmd(['list', '--json'], { log });
    assert.strictEqual(JSON.parse(lines[0]).length, 3);
  });

  it('stats prints counts and the one-shot rate in plain words', async () => {
    add('T2'); add('T4', { fix_commit: null, fix_diff: null });
    const run = join(work, 'run.json');
    writeFileSync(run, JSON.stringify({ source: 'swarm', project: 'demo', run: 'live-demo', model: 'claude-sonnet', attempted: 6, first_pass: 4, fix_rounds: 2 }));
    await mistakesCmd(['record-run', run], { log });
    lines = [];
    await mistakesCmd(['stats'], { log });
    assert.deepStrictEqual(lines, ['Mistakes: 2 (swarm 2); strong evidence 1, weak 1.',
      'Patterns: 0 draft, 0 approved (0 taught, 0 held back), 0 rejected, 0 retired.',
      'One-shot rate, claude-sonnet: 67% (4 of 6 tasks passed their first review, 1 run(s)).']);
    lines = [];
    await mistakesCmd(['stats', '--json'], { log });
    assert.strictEqual(JSON.parse(lines[0]).mistakes.total, 2);
  });

  it('stats says so when nothing is recorded yet', async () => {
    await mistakesCmd(['stats'], { log });
    assert.deepStrictEqual(lines, ['Mistakes: 0 (none); strong evidence 0, weak 0.', 'Patterns: 0 draft, 0 approved (0 taught, 0 held back), 0 rejected, 0 retired.', 'One-shot rate: no runs recorded yet.']);
  });
});

describe('kb patterns', () => {
  const llm = (ids) => async () => JSON.stringify([{ name: 'Fail closed on unreadable state', rule: 'Only a missing file is empty; any other read error stops the action.', tags: ['state'], ids }]);

  it('prints the usage for no command', async () => {
    await assert.rejects(patternsCmd([], { log }), (e) => e.message.includes(PATTERNS_USAGE));
    await assert.rejects(patternsCmd(['set-status'], { log }), /Usage: kb patterns/);
  });

  it('draft → page → set-status: the whole approval round', async () => {
    const a = add('T2'); const b = add('T4');
    let reindexed = 0;
    const reindex = async () => { reindexed += 1; };
    await patternsCmd(['draft'], { log, reindex, llm: llm([a, b]) });
    assert.deepStrictEqual(lines, ['Sorted 2 unassigned mistakes: 1 draft(s), 0 suggestion(s) refused.',
      '  draft pt_fail-closed-on-unreadable-state — Fail closed on unreadable state (2 mistakes)', 'Next: kb patterns page']);
    lines = [];
    const out = join(work, 'page.html');
    await patternsCmd(['page', `--out=${out}`], { log });
    assert.strictEqual(lines[0], `Wrote ${out}: 1 new pattern(s), 0 unused, 0 unreadable note(s).`);
    assert.match(readFileSync(out, 'utf8'), /Fail closed on unreadable state/);
    lines = [];
    await patternsCmd(['set-status', 'approve', '1'], { log, reindex });
    assert.match(lines[0], /^1\. pt_fail-closed-on-unreadable-state: approved \((taught to agents|held back for testing)\)$/);
    assert.strictEqual(getPattern(vault, 'pt_fail-closed-on-unreadable-state').status, 'approved');
    assert.strictEqual(reindexed, 2);
  });

  it('draft --dry-run writes nothing; with nothing to sort it calls no model', async () => {
    const a = add('T2'); const b = add('T4');
    await patternsCmd(['draft', '--dry-run'], { log, reindex: noReindex, llm: llm([a, b]) });
    assert.match(lines[0], /1 draft\(s\) \(dry run, nothing written\)/);
    assert.deepStrictEqual(listPatterns(vault).patterns, []);
    rmSync(join(ledgerHome, 'ledger.jsonl'));
    lines = [];
    await patternsCmd(['draft'], { log, reindex: noReindex, llm: async () => { throw new Error('must not be called'); } });
    assert.deepStrictEqual(lines, ['Nothing to sort: fewer than 2 tasks have unassigned mistakes.']);
  });

  it('draft shows why a suggestion was refused', async () => {
    const a = add('T2'); add('T4');
    await patternsCmd(['draft'], { log, reindex: noReindex, llm: llm([a]) });
    assert.deepStrictEqual(lines.slice(0, 2), ['Sorted 2 unassigned mistakes: 0 draft(s), 1 suggestion(s) refused.',
      '  refused "Fail closed on unreadable state": needs mistakes from at least 2 different tasks']);
  });

  it('list filters by status, shows unreadable notes, and refuses an unknown status', async () => {
    const a = add('T2'); const b = add('T4');
    await patternsCmd(['draft'], { log, reindex: noReindex, llm: llm([a, b]) });
    writeFileSync(join(vault, 'patterns', 'broken.md'), '---\nrule: [x\n---\n');
    lines = [];
    await patternsCmd(['list', '--status=draft'], { log });
    assert.match(lines[0], /^pt_fail-closed-on-unreadable-state {2}draft {2}Fail closed on unreadable state — Only a missing file/);
    assert.match(lines[1], /^unreadable broken\.md: /);
    lines = [];
    await patternsCmd(['list', '--status=approved'], { log });
    assert.strictEqual(lines.length, 1);
    await assert.rejects(patternsCmd(['list', '--status=live'], { log }), /--status must be one of/);
  });

  it('set-status takes a quoted reply or separate words, and changes nothing on a bad reply', async () => {
    const a = add('T2'); const b = add('T4');
    await patternsCmd(['draft'], { log, reindex: noReindex, llm: llm([a, b]) });
    await patternsCmd(['page'], { log });
    assert.ok(existsSync(join(ledgerHome, 'approval-latest.json')));
    await assert.rejects(patternsCmd(['set-status', 'approve 7'], { log, reindex: noReindex }), /there is no number 7/);
    assert.strictEqual(getPattern(vault, 'pt_fail-closed-on-unreadable-state').status, 'draft');
    await patternsCmd(['set-status', 'edit 1: Treat only a missing file as empty.'], { log, reindex: noReindex });
    assert.strictEqual(getPattern(vault, 'pt_fail-closed-on-unreadable-state').rule, 'Treat only a missing file as empty.');
    assert.strictEqual(currentMistakes().mistakes.length, 2);
  });
});
