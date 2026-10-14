// tests/mistakes-delivery.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PATTERNS, MIN_SCORE, patternsFor, pitfallsMarkdown, readDeliveries, scorePattern, tokens } from '../src/mistakes/delivery.js';
import { patternsDir, writePattern } from '../src/mistakes/patterns.js';

const pattern = (slug, extra = {}) => ({
  id: `pt_${slug}`, name: `Pattern ${slug}`, status: 'approved', group: 'teach', rule: 'Do the right thing.',
  tags: [], evidence: ['mk_A', 'mk_B'], bad: 'bad', good: 'good', approved_at: '2026-10-14T00:00:00.000Z', ...extra,
});

let vault; let home;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'kb-delivery-vault-'));
  home = mkdtempSync(join(tmpdir(), 'kb-delivery-home-'));
  process.env.KB_MISTAKES_HOME = home;
});
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(vault, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const fallback = () => writePattern(vault, pattern('fallback-on-failure', {
  name: 'Fall back when the browser cannot start', tags: ['fallback', 'error-handling'],
  rule: 'When the browser fails to start, return the recorded fallback instead of an internal error.', good: 'return fallback("browser_down");',
}));

describe('tokens', () => {
  it('lower-cases, drops short and common words, splits paths and drops a plural s', () => {
    assert.deepStrictEqual([...tokens('The Run-Manager handles errors in web/src/runs.ts')].sort(), ['error', 'handle', 'manager', 'run', 'web']);
    assert.deepStrictEqual([...tokens('')], []);
    assert.deepStrictEqual([...tokens(null)], []);
    assert.ok(tokens('process class').has('process') && tokens('process class').has('class'));
  });
});

describe('scorePattern', () => {
  it('counts a tag word 2 and a name or rule word 1, never both', () => {
    const p = pattern('x', { name: 'Fallback handling', tags: ['fallback'], rule: 'Return the recorded run.' });
    assert.strictEqual(scorePattern(p, tokens('fallback')), 2);
    assert.strictEqual(scorePattern(p, tokens('recorded run fallback')), 4);
    assert.strictEqual(scorePattern(p, tokens('unrelated words')), 0);
  });
});

describe('patternsFor', () => {
  it('returns a matching pattern as name, rule and good example only, with the markdown section', () => {
    fallback();
    const r = patternsFor({ task_text: 'T4 Run manager: queue, limits and the recorded fallback when the browser is down', files: ['web/src/runs.ts'] }, { vault });
    assert.deepStrictEqual(r.patterns, [{ id: 'pt_fallback-on-failure', name: 'Fall back when the browser cannot start',
      rule: 'When the browser fails to start, return the recorded fallback instead of an internal error.', good: 'return fallback("browser_down");' }]);
    assert.match(r.markdown, /^## Known pitfalls/);
    assert.match(r.markdown, /\*\*Fall back when the browser cannot start\.\*\*/);
    assert.match(r.markdown, / {6}return fallback\("browser_down"\);/);
  });

  it('returns nothing below the minimum score, and logs nothing', () => {
    fallback();
    const r = patternsFor({ task_text: 'Add a CSV export button to the reports page', files: ['ui/reports.js'] }, { vault });
    assert.deepStrictEqual(r, { patterns: [], markdown: '' });
    assert.deepStrictEqual(readDeliveries(), []);
    assert.ok(MIN_SCORE >= 2);
  });

  it('never returns a draft, rejected, retired or test-group pattern', () => {
    const match = { name: 'Fallback', tags: ['fallback', 'browser'], rule: 'Use the recorded fallback when the browser is down.' };
    writePattern(vault, pattern('a-draft', { ...match, status: 'draft', group: null }));
    writePattern(vault, pattern('a-rejected', { ...match, status: 'rejected', group: null }));
    writePattern(vault, pattern('a-retired', { ...match, status: 'retired' }));
    writePattern(vault, pattern('a-held-back', { ...match, group: 'test' }));
    assert.deepStrictEqual(patternsFor({ task_text: 'recorded fallback when the browser is down' }, { vault }).patterns, []);
  });

  it('returns at most 3, best score first, ties by id', () => {
    const tags = ['fallback', 'browser'];
    writePattern(vault, pattern('d', { tags }));
    writePattern(vault, pattern('b', { tags }));
    writePattern(vault, pattern('c', { tags }));
    writePattern(vault, pattern('a', { tags }));
    writePattern(vault, pattern('best', { tags: [...tags, 'queue'] }));
    const r = patternsFor({ task_text: 'browser fallback queue' }, { vault });
    assert.strictEqual(MAX_PATTERNS, 3);
    assert.deepStrictEqual(r.patterns.map(p => p.id), ['pt_best', 'pt_a', 'pt_b']);
  });

  it('logs each non-empty delivery with the run, the task and the pattern ids', () => {
    fallback();
    patternsFor({ task_text: 'browser fallback error handling', run: 'live-demo', task: 'T4' }, { vault, now: new Date('2026-10-14T01:02:03Z') });
    assert.deepStrictEqual(readDeliveries(), [{ at: '2026-10-14T01:02:03.000Z', run: 'live-demo', task: 'T4', patterns: ['pt_fallback-on-failure'] }]);
  });

  it('still answers when a pattern note is broken', () => {
    fallback();
    writeFileSync(join(patternsDir(vault), 'broken.md'), '---\nrule: [unclosed\n---\n');
    assert.strictEqual(patternsFor({ task_text: 'browser fallback error handling' }, { vault }).patterns.length, 1);
  });

  it('treats a missing or odd files value as no files', () => {
    fallback();
    assert.strictEqual(patternsFor({ task_text: 'browser fallback error handling', files: 'web/src/runs.ts' }, { vault }).patterns.length, 1);
    assert.deepStrictEqual(patternsFor({ task_text: '' }, { vault }).patterns, []);
  });
});

describe('pitfallsMarkdown', () => {
  it('is empty for no patterns and indents a multi-line example as code', () => {
    assert.strictEqual(pitfallsMarkdown([]), '');
    const md = pitfallsMarkdown([{ id: 'pt_x', name: 'X', rule: 'R.', good: 'a();\nb();' }]);
    assert.ok(md.includes('      a();\n      b();'));
    assert.ok(!md.endsWith('\n'));
  });
});
