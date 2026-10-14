// tests/mistakes-patterns.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignGroup, countWords, getPattern, listPatterns, patternsDir, setStatus, slugify, stalePatterns, uniqueSlug, validatePattern, writePattern,
} from '../src/mistakes/patterns.js';

const draft = (slug, extra = {}) => ({
  id: `pt_${slug}`, name: `Pattern ${slug}`, status: 'draft', group: null, rule: 'Check the return value before using it.',
  tags: ['error-handling'], evidence: ['mk_A', 'mk_B'], bad_from: 'mk_A', bad: 'used the value unchecked', good_from: 'mk_B', good: 'if (!v) return fallback;',
  created: '2026-10-14T00:00:00.000Z', ...extra,
});

let vault;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'kb-patterns-')); });
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('pattern notes', () => {
  it('round-trips every field, including a multi-line example', () => {
    const good = 'try {\n  run();\n} catch (e) {\n  return fallback("browser_down");\n}';
    writePattern(vault, draft('check-returns', { good }));
    const { patterns, skipped } = listPatterns(vault);
    assert.deepStrictEqual(skipped, []);
    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].good, good);
    assert.deepStrictEqual(patterns[0].evidence, ['mk_A', 'mk_B']);
    const text = readFileSync(join(patternsDir(vault), 'check-returns.md'), 'utf8');
    assert.match(text, /type: pattern/);
    assert.match(text, /# Pattern check-returns/);
  });

  it('refuses a rule over 60 words and names the count', () => {
    const rule = Array.from({ length: 61 }, (_, i) => `w${i}`).join(' ');
    assert.strictEqual(countWords(rule), 61);
    assert.throws(() => validatePattern(draft('long', { rule })), /61 words; the limit is 60/);
    assert.doesNotThrow(() => validatePattern(draft('ok', { rule: rule.split(' ').slice(0, 60).join(' ') })));
  });

  it('refuses an approved pattern with no group, a bad status and a missing example', () => {
    assert.throws(() => validatePattern(draft('a', { status: 'approved' })), /needs a group/);
    assert.throws(() => validatePattern(draft('a', { status: 'live' })), /status must be one of/);
    assert.throws(() => validatePattern(draft('a', { good: ' ' })), /good example is required/);
    assert.throws(() => validatePattern(draft('a', { id: 'check' })), /id must look like/);
  });

  it('skips a hand-edited note that is broken, says why, and still lists the rest', () => {
    writePattern(vault, draft('fine'));
    writeFileSync(join(patternsDir(vault), 'broken-yaml.md'), '---\ntitle: "unclosed\nrule: [\n---\nbody\n');
    writeFileSync(join(patternsDir(vault), 'no-rule.md'), '---\nid: pt_no-rule\nname: X\nstatus: draft\nevidence: []\nbad: b\ngood: g\n---\n');
    const long = Array.from({ length: 70 }, () => 'word').join(' ');
    writeFileSync(join(patternsDir(vault), 'too-long.md'), `---\nid: pt_too-long\nname: X\nstatus: draft\nrule: ${long}\nevidence: []\nbad: b\ngood: g\n---\n`);
    writeFileSync(join(patternsDir(vault), 'renamed.md'), readFileSync(join(patternsDir(vault), 'fine.md'), 'utf8'));
    const { patterns, skipped } = listPatterns(vault);
    assert.deepStrictEqual(patterns.map(p => p.id), ['pt_fine']);
    assert.deepStrictEqual(skipped.map(s => s.file).sort(), ['broken-yaml.md', 'no-rule.md', 'renamed.md', 'too-long.md']);
    assert.match(skipped.find(s => s.file === 'too-long.md').reason, /70 words/);
    assert.match(skipped.find(s => s.file === 'renamed.md').reason, /does not match the file name/);
  });

  it('lists nothing when the folder does not exist', () => {
    assert.deepStrictEqual(listPatterns(join(vault, 'missing')), { patterns: [], skipped: [] });
  });
});

describe('slugs', () => {
  it('makes a short lower-case slug and avoids a taken one', () => {
    assert.strictEqual(slugify('  Fail CLOSED on unreadable state!  '), 'fail-closed-on-unreadable-state');
    writePattern(vault, draft('fail-closed'));
    assert.strictEqual(uniqueSlug(vault, 'Fail closed'), 'fail-closed-2');
    assert.strictEqual(uniqueSlug(vault, '???'), 'pattern');
  });
});

describe('status changes', () => {
  it('approve assigns a group once and it never changes', () => {
    writePattern(vault, draft('one'));
    const now = new Date('2026-10-14T12:00:00Z');
    const approved = setStatus(vault, 'pt_one', 'approve', { now });
    assert.strictEqual(approved.status, 'approved');
    assert.ok(['teach', 'test'].includes(approved.group));
    assert.strictEqual(approved.approved_at, '2026-10-14T12:00:00.000Z');
    const retired = setStatus(vault, 'pt_one', 'retire');
    assert.strictEqual(retired.group, approved.group);
    assert.strictEqual(getPattern(vault, 'pt_one').status, 'retired');
  });

  it('keeps the two groups within one of each other', () => {
    for (let i = 0; i < 9; i += 1) { writePattern(vault, draft(`p${i}`)); setStatus(vault, `pt_p${i}`, 'approve'); }
    const groups = listPatterns(vault).patterns.map(p => p.group);
    const teach = groups.filter(g => g === 'teach').length;
    assert.ok(Math.abs(teach - (9 - teach)) <= 1, `teach ${teach} of 9`);
  });

  it('gives the same group for the same slug on a tie', () => {
    assert.strictEqual(assignGroup([], 'check-returns'), assignGroup([], 'check-returns'));
    assert.strictEqual(assignGroup([{ group: 'teach' }], 'x'), 'test');
    assert.strictEqual(assignGroup([{ group: 'test' }, { group: 'test' }, { group: 'teach' }], 'x'), 'teach');
  });

  it('edit replaces the rule and approves; an over-long rule changes nothing', () => {
    writePattern(vault, draft('two'));
    assert.throws(() => setStatus(vault, 'pt_two', 'edit', { rule: Array.from({ length: 61 }, () => 'w').join(' ') }), /61 words/);
    assert.strictEqual(getPattern(vault, 'pt_two').status, 'draft');
    const p = setStatus(vault, 'pt_two', 'edit', { rule: 'Return the fallback when the browser cannot start.' });
    assert.deepStrictEqual([p.status, p.rule], ['approved', 'Return the fallback when the browser cannot start.']);
    assert.throws(() => setStatus(vault, 'pt_two', 'edit', { rule: '' }), /it is approved, not draft/);
  });

  it('refuses moves that make no sense', () => {
    writePattern(vault, draft('three'));
    assert.throws(() => setStatus(vault, 'pt_three', 'retire'), /it is draft, not approved/);
    setStatus(vault, 'pt_three', 'reject');
    assert.throws(() => setStatus(vault, 'pt_three', 'approve'), /it is rejected, not draft/);
    assert.throws(() => setStatus(vault, 'pt_nope', 'approve'), /no readable pattern pt_nope/);
    assert.throws(() => setStatus(vault, 'pt_three', 'publish'), /it is rejected|unknown action/);
  });
});

describe('stalePatterns', () => {
  const approved = (slug, group, approvedAt) => draft(slug, { status: 'approved', group, approved_at: approvedAt });
  const now = new Date('2026-10-14T00:00:00Z');

  it('flags an approved teach pattern unused for 90 days, measured from its last delivery', () => {
    const patterns = [
      approved('old-unused', 'teach', '2026-06-01T00:00:00Z'),
      approved('old-but-used', 'teach', '2026-06-01T00:00:00Z'),
      approved('new', 'teach', '2026-10-01T00:00:00Z'),
      approved('held-back', 'test', '2026-01-01T00:00:00Z'),
      draft('still-draft'),
    ];
    const deliveries = [
      { at: '2026-06-02T00:00:00Z', patterns: ['pt_old-but-used'] },
      { at: '2026-10-01T00:00:00Z', patterns: ['pt_old-but-used'] },
    ];
    assert.deepStrictEqual(stalePatterns(patterns, deliveries, now).map(p => p.id), ['pt_old-unused']);
  });

  it('never flags a pattern whose dates cannot be read', () => {
    assert.deepStrictEqual(stalePatterns([approved('odd', 'teach', null)], [], now), []);
  });
});

describe('mkdir', () => {
  it('writePattern creates the patterns folder', () => {
    const fresh = join(vault, 'new-vault');
    mkdirSync(fresh);
    writePattern(fresh, draft('first'));
    assert.strictEqual(listPatterns(fresh).patterns.length, 1);
  });
});
