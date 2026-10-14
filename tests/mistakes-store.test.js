// tests/mistakes-store.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  appendJsonl, currentMistakes, ledgerPath, readJsonl, recordMistake, ulid, validateMistake, MAX_DIFF_BYTES,
} from '../src/mistakes/store.js';

const execFileAsync = promisify(execFile);
const STORE = fileURLToPath(new URL('../src/mistakes/store.js', import.meta.url));
const base = (extra = {}) => ({
  source: 'manual', project: 'demo', task: 'T1 Parser', caught_by: 'review:opus',
  finding: 'returns null for an empty file', client_ok: true, ...extra,
});

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'kb-mistakes-')); process.env.KB_MISTAKES_HOME = home; });
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(home, { recursive: true, force: true }); });

describe('validateMistake', () => {
  it('fills id, time, evidence and defaults', () => {
    const r = validateMistake(base(), { now: new Date('2026-10-14T00:00:00Z') });
    assert.match(r.id, /^mk_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(r.at, '2026-10-14T00:00:00.000Z');
    assert.strictEqual(r.evidence, 'weak');
    assert.deepStrictEqual([r.model, r.file, r.line, r.fix_commit, r.fix_diff, r.pattern, r.supersedes, r.key], [null, null, null, null, null, null, null, null]);
    assert.deepStrictEqual(r.tags, []);
  });

  it('marks a record with a fix commit as strong evidence', () => {
    assert.strictEqual(validateMistake(base({ fix_commit: 'abc1234' })).evidence, 'strong');
  });

  it('refuses a record without the code owner\'s permission', () => {
    assert.throws(() => validateMistake(base({ client_ok: false })), /client_ok is false/);
    const { client_ok: _omit, ...missing } = base();
    assert.throws(() => validateMistake(missing), /client_ok is required/);
  });

  it('names the field that is wrong', () => {
    assert.throws(() => validateMistake(base({ source: 'email' })), /source must be one of/);
    assert.throws(() => validateMistake(base({ caught_by: 'luck' })), /caught_by must be/);
    assert.throws(() => validateMistake(base({ finding: '   ' })), /finding is required/);
    assert.throws(() => validateMistake(base({ project: '' })), /project is required/);
    assert.throws(() => validateMistake(base({ fix_commit: 'not-a-sha' })), /fix_commit must be/);
    assert.throws(() => validateMistake(base({ line: -1 })), /line must be/);
    assert.throws(() => validateMistake(base({ pattern: 'Bad Slug' })), /pattern must look like/);
    assert.throws(() => validateMistake(base({ supersedes: 'mk_short' })), /supersedes must be/);
    assert.throws(() => validateMistake(base({ tags: 'a,b' })), /tags must be an array/);
    assert.throws(() => validateMistake(null), /must be an object/);
  });

  it('redacts secrets in the finding and the diff', () => {
    const r = validateMistake(base({
      finding: 'logged api_key=abcd1234efgh5678 to stdout',
      fix_diff: '-const k = "sk-abcdefghijklmnopqrstuvwxyz";\n+const k = process.env.K;',
    }));
    assert.ok(!r.finding.includes('abcd1234efgh5678'));
    assert.ok(!r.fix_diff.includes('sk-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(r.fix_diff.includes('[REDACTED]'));
  });

  it('redacts before it truncates, so a secret on the 4 KB boundary leaves no fragment', () => {
    const secret = 'sk-' + 'a'.repeat(40);
    const diff = 'x'.repeat(MAX_DIFF_BYTES - 20) + secret + '\n' + 'y'.repeat(400);
    const r = validateMistake(base({ fix_diff: diff }));
    assert.ok(Buffer.byteLength(r.fix_diff) <= MAX_DIFF_BYTES);
    assert.ok(!r.fix_diff.includes('sk-aaaa'));
    assert.ok(r.fix_diff.endsWith('[truncated]'));
  });

  it('normalises tags: lower-case, dashed, unique, at most 10', () => {
    const r = validateMistake(base({ tags: ['Error Handling', 'error-handling', ' Fallback ', '', ...Array.from({ length: 12 }, (_, i) => `t${i}`)] }));
    assert.deepStrictEqual(r.tags.slice(0, 2), ['error-handling', 'fallback']);
    assert.strictEqual(r.tags.length, 10);
  });
});

describe('ulid', () => {
  it('is 26 characters and sorts by time', () => {
    const a = ulid(1_000_000); const b = ulid(2_000_000);
    assert.strictEqual(a.length, 26);
    assert.ok(a.slice(0, 10) < b.slice(0, 10));
  });
});

describe('the ledger file', () => {
  it('only grows: earlier bytes never change', () => {
    recordMistake(base());
    const first = readFileSync(ledgerPath());
    recordMistake(base({ task: 'T2 Limits' }));
    const second = readFileSync(ledgerPath());
    assert.ok(second.length > first.length);
    assert.ok(second.subarray(0, first.length).equals(first));
  });

  it('skips a line cut off by a crash, counts it, and starts the next record on a new line', () => {
    recordMistake(base());
    appendFileSync(ledgerPath(), '{"id":"mk_cut","finding":"half a rec');
    const { id } = recordMistake(base({ task: 'T3 After crash' }));
    const { rows, bad } = readJsonl(ledgerPath());
    assert.strictEqual(bad, 1);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].id, id);
  });

  it('keeps every record on its own line when several processes append at once', async () => {
    const script = `import { appendJsonl } from ${JSON.stringify(STORE)};
      for (let i = 0; i < 50; i += 1) appendJsonl(process.argv[1], { w: process.argv[2], i, pad: 'x'.repeat(1500) });`;
    const file = join(home, 'concurrent.jsonl');
    await Promise.all(['a', 'b', 'c', 'd'].map(w => execFileAsync(process.execPath, ['--input-type=module', '-e', script, file, w])));
    const { rows, bad } = readJsonl(file);
    assert.strictEqual(bad, 0);
    assert.strictEqual(rows.length, 200);
  });

  it('returns no rows for a ledger that does not exist yet', () => {
    assert.deepStrictEqual(readJsonl(join(home, 'nope.jsonl')), { rows: [], bad: 0 });
    assert.deepStrictEqual(currentMistakes(), { mistakes: [], bad: 0 });
  });
});

describe('recordMistake', () => {
  it('does not write a second record with the same key', () => {
    const one = recordMistake(base({ key: 'sdd:demo:T1:fix1:abc' }));
    const two = recordMistake(base({ key: 'sdd:demo:T1:fix1:abc', finding: 'different words' }));
    assert.strictEqual(one.duplicate, false);
    assert.deepStrictEqual([two.id, two.duplicate], [one.id, true]);
    assert.strictEqual(readJsonl(ledgerPath()).rows.length, 1);
  });

  it('supersedes: the old record stays in the file but leaves the current view', () => {
    const old = recordMistake(base());
    const fixed = recordMistake(base({ finding: 'returns undefined, not null', supersedes: old.id }));
    assert.strictEqual(readJsonl(ledgerPath()).rows.length, 2);
    assert.deepStrictEqual(currentMistakes().mistakes.map(m => m.id), [fixed.id]);
  });

  it('refuses to supersede a record that is not in the ledger', () => {
    assert.throws(() => recordMistake(base({ supersedes: `mk_${ulid()}` })), /unknown record/);
    assert.strictEqual(readJsonl(ledgerPath()).rows.length, 0);
  });

  it('reports the mirror result and survives a failing mirror', () => {
    const seen = [];
    assert.strictEqual(recordMistake(base(), { mirror: r => seen.push(r.id) }).mirrored, true);
    const r = recordMistake(base({ task: 'T9' }), { mirror: () => { throw new Error('db locked'); } });
    assert.strictEqual(r.mirrored, false);
    assert.strictEqual(readJsonl(ledgerPath()).rows.length, 2);
    assert.strictEqual(seen.length, 1);
  });

  it('writes nothing when the record is invalid', () => {
    assert.throws(() => recordMistake(base({ client_ok: false })));
    assert.strictEqual(readJsonl(ledgerPath()).rows.length, 0);
  });
});

describe('appendJsonl', () => {
  it('creates the folder on first use', () => {
    const file = join(home, 'deep', 'er', 'x.jsonl');
    appendJsonl(file, { a: 1 });
    assert.deepStrictEqual(readJsonl(file).rows, [{ a: 1 }]);
  });
});
