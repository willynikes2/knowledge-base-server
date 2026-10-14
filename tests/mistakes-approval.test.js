// tests/mistakes-approval.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReply, approvalMapPath, buildApprovalPage, parseReply, writeApprovalPage } from '../src/mistakes/approval.js';
import { getPattern, writePattern } from '../src/mistakes/patterns.js';
import { recordMistake } from '../src/mistakes/store.js';

let vault; let home;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'kb-approval-vault-'));
  home = mkdtempSync(join(tmpdir(), 'kb-approval-home-'));
  process.env.KB_MISTAKES_HOME = home;
});
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(vault, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const pattern = (slug, extra = {}) => writePattern(vault, { id: `pt_${slug}`, name: `Pattern ${slug}`, status: 'draft', group: null,
  rule: 'Check the result before using it.', tags: ['checks'], evidence: [], bad: 'bad', good: 'good', created: '2026-10-01T00:00:00.000Z', ...extra });
const NOW = new Date('2026-10-14T00:00:00Z');

describe('parseReply', () => {
  it('reads the documented example', () => {
    assert.deepStrictEqual(parseReply('approve 1 and 3, edit 2: Check the result, then use it., reject 4'), [
      { action: 'approve', n: 1 }, { action: 'approve', n: 3 }, { action: 'edit', n: 2, rule: 'Check the result, then use it.' }, { action: 'reject', n: 4 }]);
  });

  it('accepts other spellings of a list', () => {
    assert.deepStrictEqual(parseReply('Approve 1,2 & 3; retire 7.').map(d => `${d.action}${d.n}`), ['approve1', 'approve2', 'approve3', 'retire7']);
    assert.deepStrictEqual(parseReply('reject 2\napprove 1'), [{ action: 'reject', n: 2 }, { action: 'approve', n: 1 }]);
  });

  it('lets a rule contain commas and the action words', () => {
    assert.deepStrictEqual(parseReply('edit 2: Never approve a review that did not run, and reject empty diffs. and approve 1'), [
      { action: 'edit', n: 2, rule: 'Never approve a review that did not run, and reject empty diffs.' }, { action: 'approve', n: 1 }]);
  });

  it('refuses what it cannot read, with a reason', () => {
    assert.throws(() => parseReply('looks good'), /no decision found/);
    assert.throws(() => parseReply(''), /no decision found/);
    assert.throws(() => parseReply('yes approve 1'), /cannot read "yes" before the first decision/);
    assert.throws(() => parseReply('approve 1 maybe 2'), /cannot read "1 maybe 2" after approve/);
    assert.throws(() => parseReply('edit 2 Check it'), /edit needs one number, a colon and the new rule/);
    assert.throws(() => parseReply('edit 2:   '), /edit needs one number/);
    assert.throws(() => parseReply('approve 1, reject 1'), /number 1 is used twice/);
  });
});

describe('the page', () => {
  it('numbers drafts first, then unused patterns, and escapes everything from the records', () => {
    const id = recordMistake({ source: 'manual', project: '<b>proj</b>', task: 'T1', caught_by: 'test', finding: 'used <script>alert(1)</script>', client_ok: true, fix_commit: 'abcdef1234' }).id;
    pattern('one', { name: 'One <img src=x>', evidence: [id, 'mk_GONE'], bad: '<script>x</script>', good: 'a && b' });
    pattern('two');
    pattern('old', { status: 'approved', group: 'teach', approved_at: '2026-06-01T00:00:00.000Z' });
    pattern('held', { status: 'approved', group: 'test', approved_at: '2026-01-01T00:00:00.000Z' });
    const r = writeApprovalPage({ vault, now: NOW });
    assert.deepStrictEqual([r.drafts, r.stale, r.skipped], [2, 1, 0]);
    assert.strictEqual(r.file, join(home, 'approval-2026-10-14.html'));
    const html = readFileSync(r.file, 'utf8');
    assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<b>proj'));
    assert.ok(html.includes('One &lt;img src=x&gt;') && html.includes('a &amp;&amp; b') && html.includes('abcdef1'));
    assert.ok(html.includes('mk_GONE is no longer in the ledger'));
    assert.match(html, /<title>Pattern approvals<\/title>/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.deepStrictEqual(JSON.parse(readFileSync(approvalMapPath(), 'utf8')).items, [
      { n: 1, id: 'pt_one', kind: 'draft' }, { n: 2, id: 'pt_two', kind: 'draft' }, { n: 3, id: 'pt_old', kind: 'stale' }]);
  });

  it('says so when there is nothing to review', () => {
    const { html, mapping } = buildApprovalPage({ drafts: [], stale: [], mistakes: [], now: NOW });
    assert.match(html, /No new patterns to review/);
    assert.deepStrictEqual(mapping.items, []);
    assert.ok(!html.includes('Not used for'));
  });

  it('lists notes it could not read', () => {
    const { html } = buildApprovalPage({ drafts: [], stale: [], mistakes: [], skipped: [{ file: 'x.md', reason: 'rule has 70 words; the limit is 60' }], now: NOW });
    assert.match(html, /x\.md<\/code>: rule has 70 words/);
  });
});

describe('applyReply', () => {
  const setup = () => {
    pattern('p1'); pattern('p2'); pattern('p3');
    pattern('old', { status: 'approved', group: 'teach', approved_at: '2026-06-01T00:00:00.000Z' });
    writeApprovalPage({ vault, now: NOW });
  };

  it('applies approve, edit, reject and retire by number', () => {
    setup();
    const out = applyReply('approve 1, edit 2: Return the fallback when the browser is down., reject 3, retire 4', { vault, now: NOW });
    assert.deepStrictEqual(out.map(o => [o.n, o.id, o.action, o.status]), [[1, 'pt_p1', 'approve', 'approved'], [2, 'pt_p2', 'edit', 'approved'], [3, 'pt_p3', 'reject', 'rejected'], [4, 'pt_old', 'retire', 'retired']]);
    assert.strictEqual(getPattern(vault, 'pt_p2').rule, 'Return the fallback when the browser is down.');
    assert.ok(['teach', 'test'].includes(getPattern(vault, 'pt_p1').group));
  });

  it('changes nothing when any part of the reply is wrong', () => {
    setup();
    const untouched = () => assert.deepStrictEqual(['p1', 'p2', 'p3', 'old'].map(s => getPattern(vault, `pt_${s}`).status), ['draft', 'draft', 'draft', 'approved']);
    assert.throws(() => applyReply('approve 1, approve 9', { vault }), /there is no number 9 on the latest page/); untouched();
    assert.throws(() => applyReply('approve 1, retire 2', { vault }), /cannot retire number 2 \(Pattern p2\): it is draft, not approved/); untouched();
    assert.throws(() => applyReply('approve 1, approve 4', { vault }), /cannot approve number 4 .*it is approved, not draft/); untouched();
    assert.throws(() => applyReply(`approve 1, edit 2: ${Array.from({ length: 61 }, () => 'w').join(' ')}`, { vault }), /number 2 has 61 words/); untouched();
    assert.throws(() => applyReply('approve 1, please', { vault }), /cannot read/); untouched();
  });

  it('refuses a second approval of the same number, and a reply before any page exists', () => {
    setup();
    applyReply('approve 1', { vault });
    assert.throws(() => applyReply('approve 1', { vault }), /it is approved, not draft/);
    rmSync(approvalMapPath());
    assert.ok(!existsSync(approvalMapPath()));
    assert.throws(() => applyReply('approve 2', { vault }), /no approval page has been made yet/);
  });
});
