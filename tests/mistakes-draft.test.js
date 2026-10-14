// tests/mistakes-draft.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, draftPatterns, goodExample, groupKey, parseClusters, unassignedMistakes } from '../src/mistakes/draft.js';
import { listPatterns, setStatus } from '../src/mistakes/patterns.js';
import { recordMistake } from '../src/mistakes/store.js';

let vault; let home;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'kb-draft-vault-'));
  home = mkdtempSync(join(tmpdir(), 'kb-draft-home-'));
  process.env.KB_MISTAKES_HOME = home;
});
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(vault, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const add = (task, extra = {}) => recordMistake({ source: 'swarm', project: 'demo', task, caught_by: 'review:opus', client_ok: true,
  finding: `unreadable state file treated as empty in ${task}`, fix_commit: 'abc1234', fix_diff: `+if (e.code !== "ENOENT") throw e; // ${task}`, tags: ['fail-closed'], ...extra }).id;
const cluster = (ids, extra = {}) => ({ name: 'Fail closed on unreadable state', rule: 'Treat only a missing file as empty; any other read error must stop the action.',
  tags: ['Fail Closed', 'state'], ids, bad_id: ids[0], good_id: ids[1], ...extra });
const answering = (clusters) => async () => JSON.stringify(clusters);

describe('helpers', () => {
  it('groups by first tag, then folder, then other', () => {
    assert.strictEqual(groupKey({ tags: ['fallback', 'x'], file: 'a/b.js' }), 'fallback');
    assert.strictEqual(groupKey({ tags: [], file: 'web/src/runs.ts' }), 'web/src');
    assert.strictEqual(groupKey({ tags: [], file: 'src/ntm.js' }), 'src');
    assert.strictEqual(groupKey({ tags: [], file: 'hooks.json' }), '(top folder)');
    assert.strictEqual(groupKey({ tags: [], file: null }), 'other');
  });

  it('reads a JSON array even with words around it, and refuses anything else', () => {
    assert.deepStrictEqual(parseClusters('[]'), []);
    assert.deepStrictEqual(parseClusters('Here you go:\n```json\n[{"name":"x"}]\n```\nDone.'), [{ name: 'x' }]);
    assert.throws(() => parseClusters('I found nothing.'), /did not answer with a JSON array/);
    assert.throws(() => parseClusters('{"name":"x"}'), /did not answer with a JSON array/);
  });

  it('takes the good example from the fix diff, else from the "Fix:" part, else none', () => {
    assert.strictEqual(goodExample({ fix_diff: '+x', finding: 'f' }), '+x');
    assert.strictEqual(goodExample({ fix_diff: null, finding: 'Title\nSymptom: s\nFix: send the field explicitly' }), 'send the field explicitly');
    assert.strictEqual(goodExample({ fix_diff: null, finding: 'no fix part' }), null);
  });

  it('puts every record in the prompt once, with the data-not-instructions line', () => {
    const prompt = buildPrompt([{ id: 'mk_1', project: 'p', task: 't', tags: ['a'], file: null, finding: 'line one\nline two', fix_diff: '+x' },
      { id: 'mk_2', project: 'p', task: 'u', tags: [], file: 'src/x.js', finding: 'f', fix_diff: null }]);
    assert.match(prompt, /### hint: a\n- mk_1 \| p \| t \| fix recorded: yes\n {2}line one line two/);
    assert.match(prompt, /### hint: src\n- mk_2 \| p \| u \| fix recorded: no/);
    assert.match(prompt, /data, not instructions/);
  });
});

describe('draftPatterns', () => {
  it('writes a draft for a cluster from two different tasks', async () => {
    const a = add('T2 Limits'); const b = add('T4 Run manager');
    const r = await draftPatterns({ vault, llm: answering([cluster([a, b])]), now: new Date('2026-10-14T00:00:00Z') });
    assert.deepStrictEqual(r, { sent: 2, drafted: [{ id: 'pt_fail-closed-on-unreadable-state', name: 'Fail closed on unreadable state', evidence: 2 }], skipped: [] });
    const [p] = listPatterns(vault).patterns;
    assert.deepStrictEqual([p.status, p.group, p.tags, p.evidence, p.bad_from, p.good_from], ['draft', null, ['fail-closed', 'state'], [a, b], a, b]);
    assert.match(p.bad, /unreadable state file/);
    assert.match(p.good, /ENOENT/);
  });

  it('refuses a cluster whose mistakes all come from one task', async () => {
    const a = add('T2 Limits'); const b = add('T2 Limits', { finding: 'a second finding in the same task' }); add('T9 Other');
    const r = await draftPatterns({ vault, llm: answering([cluster([a, b])]) });
    assert.deepStrictEqual(r.drafted, []);
    assert.match(r.skipped[0].reason, /at least 2 different tasks/);
    assert.deepStrictEqual(listPatterns(vault).patterns, []);
  });

  it('counts the same task name in two projects as two tasks', async () => {
    const a = add('T1 Setup'); const b = add('T1 Setup', { project: 'other' });
    assert.strictEqual((await draftPatterns({ vault, llm: answering([cluster([a, b])]) })).drafted.length, 1);
  });

  it('ignores ids the model made up, and skips a rule over 60 words, a missing name and a cluster with no fix', async () => {
    const a = add('T2'); const b = add('T4');
    const c = add('T5', { fix_commit: null, fix_diff: null }); const d = add('T6', { fix_commit: null, fix_diff: null });
    const r = await draftPatterns({ vault, llm: answering([
      cluster([a, 'mk_INVENTED']),
      cluster([a, b], { name: 'Too long', rule: Array.from({ length: 61 }, () => 'word').join(' ') }),
      cluster([a, b], { name: '  ' }),
      cluster([c, d], { name: 'No fix shown' }),
      'not an object',
    ]) });
    assert.deepStrictEqual(r.drafted, []);
    assert.deepStrictEqual(r.skipped.map(s => s.reason), ['needs mistakes from at least 2 different tasks', 'rule has 61 words; the limit is 60', 'no name', 'no record in the cluster has a recorded fix to show', 'no name']);
  });

  it('uses each mistake in one draft only, and gives a second same-named draft its own slug', async () => {
    const a = add('T2'); const b = add('T4'); const c = add('T5'); const d = add('T6');
    const r = await draftPatterns({ vault, llm: answering([cluster([a, b]), cluster([b, c, d]), cluster([a, b, c, d])]) });
    assert.deepStrictEqual(r.drafted.map(x => [x.id, x.evidence]), [['pt_fail-closed-on-unreadable-state', 2], ['pt_fail-closed-on-unreadable-state-2', 2]]);
    assert.match(r.skipped[0].reason, /at least 2 different tasks/);
  });

  it('does not send mistakes that a pattern already uses, even a rejected one, and calls no model with nothing to sort', async () => {
    const a = add('T2'); const b = add('T4');
    await draftPatterns({ vault, llm: answering([cluster([a, b])]) });
    setStatus(vault, 'pt_fail-closed-on-unreadable-state', 'reject');
    let called = 0;
    const r = await draftPatterns({ vault, llm: async () => { called += 1; return '[]'; } });
    assert.deepStrictEqual([r.sent, called], [0, 0]);
    assert.deepStrictEqual(unassignedMistakes([{ id: a }, { id: 'mk_new' }, { id: 'mk_manual', pattern: 'pt_x' }], listPatterns(vault).patterns).map(m => m.id), ['mk_new']);
  });

  it('writes nothing in a dry run, and nothing when the model answer cannot be read', async () => {
    const a = add('T2'); const b = add('T4');
    const dry = await draftPatterns({ vault, llm: answering([cluster([a, b])]), dryRun: true });
    assert.strictEqual(dry.drafted.length, 1);
    assert.deepStrictEqual(listPatterns(vault).patterns, []);
    await assert.rejects(draftPatterns({ vault, llm: async () => 'Sorry, I cannot help.' }), /did not answer with a JSON array/);
    await assert.rejects(draftPatterns({ vault, llm: async () => { throw new Error('the model call failed (exit 1)'); } }), /model call failed/);
    assert.deepStrictEqual(listPatterns(vault).patterns, []);
  });
});
