// tests/mistakes-import.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitEvidence, findingsInBrief, fixCommit, importSdd, ledgerDirs, parseSddLedger } from '../src/mistakes/import-sdd.js';
import { importSeed, seedRecord } from '../src/mistakes/import-seed.js';
import { currentMistakes, recordMistake } from '../src/mistakes/store.js';

const PROGRESS = [
  '# SDD ledger — plan: docs/plans/demo.md',
  '',
  'Spec: docs/specs/demo.md. Implementers: sonnet; reviewers: opus.',
  'Task 5: fix round 1/5 dispatched (findings in task-5-fix1.md)',
  'Task 5: fix round 1/5 implemented e878bb3 (one combined commit; 47/47)',
  'Task 5: fix round 2/5 implemented 909edd4 (52/52)',
  '- Task 4: fix round 1/5 (1 addressed, 0 open; commits a8d94ae..a2184ac)',
  'Final fix: implementer resumed. Implemented 3feb981..a6701dc (13 commits)',
  'Final-fix2 implemented fddb2c4 (A) f269d71 (E)',
].join('\n');

const BRIEF_HEADED = [
  '# Task 5, fix round 1',
  '',
  'Preamble that is not a finding.',
  '',
  '## 1. Gate full permissions on the launch commands (Important)',
  '- In `src/ntm.js`, add `codexLaunchCommand(run)`.',
  '',
  '## 2. Ready means positively ready (Important)',
  'Details.',
  '',
  '## Parked (ledger)',
  '- not a finding',
  '',
  '## Tests (each must fail first)',
  '- not a finding either',
].join('\n');

const BRIEF_ITEMS = [
  '# Final-review fix wave',
  '',
  '## Critical',
  'C1. **Empty `--job` starts a job in the wrong checkout.** `parseArgs` (src/factory/cli.ts) accepts it.',
  '   - **Fix:** refuse an empty `--job`.',
  '',
  '## Important',
  'I3. **The printed path does not resolve.** scripts/brief.ts prints a relative path.',
  '',
  '## Rules',
  'Plain text, no item.',
].join('\n');

let home; let work;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kb-import-home-')); process.env.KB_MISTAKES_HOME = home;
  work = mkdtempSync(join(tmpdir(), 'kb-import-work-'));
});
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

function ledger(name = '2026-10-12-demo', files = {}) {
  const dir = join(work, 'repo', '.superpowers', 'sdd', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'progress.md'), PROGRESS);
  writeFileSync(join(dir, 'plan-path'), 'docs/plans/demo.md\n');
  for (const [file, text] of Object.entries({ 'task-5-fix1.md': BRIEF_HEADED, ...files })) writeFileSync(join(dir, file), text);
  return dir;
}
const noGit = () => ({ diff: null, guardTest: null });

describe('findingsInBrief', () => {
  it('takes numbered, lettered and ruling headings, and skips the others', () => {
    assert.deepStrictEqual(findingsInBrief(BRIEF_HEADED).map(f => f.title), [
      '1. Gate full permissions on the launch commands (Important)', '2. Ready means positively ready (Important)']);
    assert.deepStrictEqual(findingsInBrief('## A. First\nx\n## R2. Second\ny\n## Ruling: third\nz\n## Done when\nq').map(f => f.title), ['A. First', 'R2. Second', 'Ruling: third']);
  });

  it('falls back to "C1. **Title**" paragraphs when no heading is a finding', () => {
    const items = findingsInBrief(BRIEF_ITEMS);
    assert.deepStrictEqual(items.map(f => f.title), ['C1. Empty `--job` starts a job in the wrong checkout', 'I3. The printed path does not resolve']);
    assert.match(items[0].text, /refuse an empty/);
    assert.ok(!items[1].text.includes('Plain text'));
  });

  it('returns nothing for a brief with no findings and cuts a very long one', () => {
    assert.deepStrictEqual(findingsInBrief('# Title\n\njust words'), []);
    const [long] = findingsInBrief(`## 1. Long\n${'x'.repeat(5000)}`);
    assert.strictEqual(long.text.length, 1500);
  });
});

describe('fixCommit', () => {
  it('reads the commit of a task round, a commit range, and the final rounds', () => {
    assert.deepStrictEqual(fixCommit(PROGRESS, 5, 1), { sha: 'e878bb3', range: false });
    assert.deepStrictEqual(fixCommit(PROGRESS, 5, 2), { sha: '909edd4', range: false });
    assert.deepStrictEqual(fixCommit(PROGRESS, 4, 1), { sha: 'a2184ac', range: true });
    assert.deepStrictEqual(fixCommit(PROGRESS, null, 1), { sha: 'a6701dc', range: true });
    assert.deepStrictEqual(fixCommit(PROGRESS, null, 2), { sha: 'fddb2c4', range: false });
    assert.deepStrictEqual(fixCommit('- Fix wave committed 9e0b161..1a5d80b (10 commits)', null, 1), { sha: '1a5d80b', range: true });
  });

  it('is null when the ledger does not name a commit, and does not confuse task 5 with task 15', () => {
    assert.strictEqual(fixCommit(PROGRESS, 5, 3), null);
    assert.strictEqual(fixCommit(PROGRESS, 9, 1), null);
    assert.strictEqual(fixCommit('Task 15: fix round 1/5 implemented abcdef1', 5, 1), null);
  });
});

describe('parseSddLedger and ledgerDirs', () => {
  it('reads the plan, the model and every finding with its task, round, file and commit', () => {
    const dir = ledger('2026-10-12-demo', { 'final-fix2.md': '## A. Stale pass\nSee `src/decide.js`.', 'task-5-report.md': '## 1. Not a brief\nx', 'notes.md': '## 1. Nor this\nx' });
    const r = parseSddLedger(dir);
    assert.deepStrictEqual([r.plan, r.model], ['docs/plans/demo.md', 'sonnet']);
    assert.deepStrictEqual(r.findings.map(f => [f.task, f.round, f.fixCommit, f.fixRange, f.file]), [
      ['FINAL', 2, 'fddb2c4', false, 'src/decide.js'], ['T5', 1, 'e878bb3', false, 'src/ntm.js'], ['T5', 1, 'e878bb3', false, null]]);
  });

  it('accepts one ledger folder or a folder of them, and refuses a path that is not a folder', () => {
    const a = ledger('a'); const b = ledger('b');
    assert.deepStrictEqual(ledgerDirs(a), [a]);
    assert.deepStrictEqual(ledgerDirs(join(work, 'repo', '.superpowers', 'sdd')), [a, b]);
    assert.throws(() => ledgerDirs(join(work, 'nope')), /not a folder/);
  });
});

describe('importSdd', () => {
  it('writes one record per finding with its evidence, and nothing on a second run', () => {
    const dir = ledger();
    const calls = [];
    const evidence = (repo, sha) => { calls.push([repo, sha]); return { diff: '+fixed', guardTest: 'test/launch.test.js' }; };
    const first = importSdd(dir, { project: 'demo', clientOk: true, evidence });
    assert.deepStrictEqual(first, { ledgers: 1, added: 2, duplicates: 0, weak: 0 });
    assert.deepStrictEqual(calls, [[join(work, 'repo'), 'e878bb3']]);
    const [m] = currentMistakes().mistakes;
    assert.deepStrictEqual([m.source, m.project, m.task, m.model, m.caught_by, m.fix_commit, m.fix_diff, m.guard_test, m.evidence, m.task_text_ref],
      ['sdd', 'demo', 'T5', 'sonnet', 'review', 'e878bb3', '+fixed', 'test/launch.test.js', 'strong', 'docs/plans/demo.md#task-5']);
    assert.deepStrictEqual(importSdd(dir, { project: 'demo', clientOk: true, evidence }), { ledgers: 1, added: 0, duplicates: 2, weak: 0 });
    assert.strictEqual(currentMistakes().mistakes.length, 2);
  });

  it('imports only the new findings after another fix round is added', () => {
    const dir = ledger();
    importSdd(dir, { project: 'demo', clientOk: true, evidence: noGit });
    writeFileSync(join(dir, 'task-5-fix2.md'), '## A. Exact agent count\nstill open');
    assert.deepStrictEqual(importSdd(dir, { project: 'demo', clientOk: true, evidence: noGit }), { ledgers: 1, added: 1, duplicates: 2, weak: 0 });
  });

  it('keeps no diff for a commit range, and marks a finding with no commit as weak', () => {
    const dir = ledger('x', { 'final-fix.md': '## 1. Crashed shell\nx', 'task-9-fix1.md': '## A. No commit recorded\nx' });
    let asked = 0;
    const r = importSdd(dir, { project: 'demo', clientOk: true, evidence: () => { asked += 1; return { diff: '+d', guardTest: null }; } });
    assert.deepStrictEqual([r.added, r.weak], [4, 1]);
    const byTask = Object.fromEntries(currentMistakes().mistakes.map(m => [`${m.task}:${m.finding.slice(0, 2)}`, m]));
    assert.deepStrictEqual([byTask['FINAL:1.'].fix_commit, byTask['FINAL:1.'].fix_diff, byTask['FINAL:1.'].task_text_ref], ['a6701dc', null, 'docs/plans/demo.md']);
    assert.deepStrictEqual([byTask['T9:A.'].fix_commit, byTask['T9:A.'].evidence], [null, 'weak']);
    assert.strictEqual(asked, 1);
  });

  it('refuses without a project name or without the owner\'s permission, and writes nothing', () => {
    const dir = ledger();
    assert.throws(() => importSdd(dir, { clientOk: true }), /project name is required/);
    assert.throws(() => importSdd(dir, { project: 'demo' }), /--client-ok/);
    assert.strictEqual(currentMistakes().mistakes.length, 0);
  });
});

describe('commitEvidence', () => {
  it('returns the diff and the first test file, and nulls when git fails', () => {
    const run = (cmd, args) => (args.includes('--name-only') ? 'src/a.js\ntest/a.test.js\n' : 'diff --git a/src/a.js b/src/a.js\n+x\n');
    assert.deepStrictEqual(commitEvidence('/repo', 'abc1234', { run }), { diff: 'diff --git a/src/a.js b/src/a.js\n+x\n', guardTest: 'test/a.test.js' });
    assert.deepStrictEqual(commitEvidence('/repo', 'abc1234', { run: () => { throw new Error('bad object'); } }), { diff: null, guardTest: null });
    assert.deepStrictEqual(commitEvidence('/repo', 'abc1234', { run: (c, a) => (a.includes('--name-only') ? 'README.md\n' : '') }), { diff: null, guardTest: null });
  });
});

describe('the seed catalogue', () => {
  const row = { kb_id: 1510, title: "GTC orders were really FOK", project: 'cod3x/kalshi', kind: 'bug-in-code', symptom: 'every order got 409',
    wrong_first_guess: 'maintenance noise', root_cause: 'omitted field defaults to fill_or_kill', fix: '7f2634b: send good_till_canceled',
    pattern: 'assumed server default differs from reality', date: '2026-05-28' };

  it('maps a row to a weak record keyed by its KB id', () => {
    const r = seedRecord(row);
    assert.deepStrictEqual([r.source, r.project, r.caught_by, r.task_text_ref, r.client_ok], ['seed', 'cod3x/kalshi', 'operator', 'kb:1510', true]);
    assert.match(r.key, /^seed:1510:[0-9a-f]{12}$/);
    assert.match(r.finding, /^GTC orders were really FOK\nSymptom: every order got 409\nWrong first guess: maintenance noise\nRoot cause: .*\nFix: 7f2634b/);
    assert.strictEqual(r.fix_commit, undefined);
    assert.deepStrictEqual(r.tags, ['bug-in-code', 'assumed server default differs from reality']);
  });

  it('imports once, skips a bad row with its reason, and is safe to run again', () => {
    const file = join(work, 'catalogue.json');
    writeFileSync(file, JSON.stringify([row, { title: 'no id' }, { ...row, kb_id: 1511, title: 'Second' }]));
    const first = importSeed(file);
    assert.deepStrictEqual([first.rows, first.added, first.duplicates, first.skipped.length], [3, 2, 0, 1]);
    assert.match(first.skipped[0].reason, /needs kb_id and title/);
    assert.deepStrictEqual(currentMistakes().mistakes.map(m => m.evidence), ['weak', 'weak']);
    assert.deepStrictEqual([importSeed(file).added, importSeed(file).duplicates], [0, 2]);
  });

  it('says so when the file is missing or is not a list', () => {
    assert.throws(() => importSeed(join(work, 'missing.json')), /cannot read the catalogue/);
    writeFileSync(join(work, 'obj.json'), '{"a":1}');
    assert.throws(() => importSeed(join(work, 'obj.json')), /must be a JSON array/);
  });
});

describe('several catalogue rows from the same KB document', () => {
  const base = { kb_id: 1510, project: 'p', kind: 'bug-in-code' };

  it('are all imported, once each', () => {
    const file = join(work, 'shared.json');
    writeFileSync(file, JSON.stringify([{ ...base, title: 'First mistake' }, { ...base, title: 'Second mistake' }, { ...base, kb_id: 7, title: 'Other doc' }]));
    assert.deepStrictEqual([importSeed(file).added, importSeed(file).added], [3, 0]);
    assert.strictEqual(currentMistakes().mistakes.length, 3);
  });

  it('a ledger imported with the old one-key-per-document rule is completed, not doubled', () => {
    recordMistake({ ...seedRecord({ ...base, title: 'First mistake' }), key: 'seed:1510' }); // what the old importer wrote
    const file = join(work, 'shared.json');
    writeFileSync(file, JSON.stringify([{ ...base, title: 'First mistake' }, { ...base, title: 'Second mistake' }]));
    const r = importSeed(file);
    assert.deepStrictEqual([r.added, r.duplicates], [1, 1]);
    assert.deepStrictEqual(currentMistakes().mistakes.map(m => m.task).sort(), ['First mistake', 'Second mistake']);
  });
});
