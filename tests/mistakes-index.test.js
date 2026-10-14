// tests/mistakes-index.test.js — only patterns approved for teaching are searchable. Drafts, rejected patterns and
// the held-back (test) half stay out of the KB index, so no agent can find a rule it is not meant to have seen.
// HOME is replaced before anything from src/ is loaded.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kb-index-home-'));
process.env.HOME = HOME;

const { default: Database } = await import('better-sqlite3');
const { setDbForTesting, searchDocuments, getDb } = await import('../src/db.js');
const { indexVault } = await import('../src/vault/indexer.js');
const { writePattern, setStatus } = await import('../src/mistakes/patterns.js');

const pattern = (slug, extra = {}) => ({ id: `pt_${slug}`, name: `Pattern ${slug}`, status: 'draft', group: null,
  rule: `Rule for ${slug} zebrafinch.`, tags: ['checks'], evidence: [], bad: 'bad', good: 'good', created: '2026-10-01T00:00:00.000Z', ...extra });
const indexedPaths = () => getDb().prepare("SELECT vault_path FROM vault_files WHERE vault_path LIKE 'patterns/%' ORDER BY vault_path").all().map(r => r.vault_path);

let vault; let db;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'kb-index-vault-'));
  mkdirSync(join(vault, 'research'), { recursive: true });
  writeFileSync(join(vault, 'research', 'note.md'), '---\ntitle: Ordinary note\ntype: research\n---\nzebrafinch ordinary text\n');
  db = new Database(':memory:'); setDbForTesting(db);
});
afterEach(() => { setDbForTesting(null); db.close(); rmSync(vault, { recursive: true, force: true }); });
after(() => rmSync(HOME, { recursive: true, force: true }));

describe('which pattern notes are searchable', () => {
  it('only approved and retired patterns of the teach group are indexed', async () => {
    writePattern(vault, pattern('a-draft'));
    writePattern(vault, pattern('b-rejected', { status: 'rejected' }));
    writePattern(vault, pattern('c-taught', { status: 'approved', group: 'teach', approved_at: '2026-10-02T00:00:00.000Z' }));
    writePattern(vault, pattern('d-held-back', { status: 'approved', group: 'test', approved_at: '2026-10-02T00:00:00.000Z' }));
    writePattern(vault, pattern('e-retired', { status: 'retired', group: 'teach', approved_at: '2026-10-02T00:00:00.000Z' }));
    writePattern(vault, pattern('f-retired-held-back', { status: 'retired', group: 'test', approved_at: '2026-10-02T00:00:00.000Z' }));
    await indexVault(vault);
    assert.deepStrictEqual(indexedPaths(), ['patterns/c-taught.md', 'patterns/e-retired.md']);
    const titles = searchDocuments('zebrafinch', 50).map(r => r.title).sort();
    assert.deepStrictEqual(titles, ['Ordinary note', 'Pattern: Pattern c-taught', 'Pattern: Pattern e-retired']);
  });

  it('a draft approved into the held-back group never becomes searchable, and one approved to teach does', async () => {
    writePattern(vault, pattern('one')); writePattern(vault, pattern('two'));
    await indexVault(vault);
    assert.deepStrictEqual(indexedPaths(), []);
    const first = setStatus(vault, 'pt_one', 'approve');
    const second = setStatus(vault, 'pt_two', 'approve');
    await indexVault(vault);
    const teach = [first, second].filter(p => p.group === 'teach').map(p => `patterns/${p.id.slice(3)}.md`);
    assert.strictEqual(teach.length, 1, 'one of each group');
    assert.deepStrictEqual(indexedPaths(), teach);
  });

  it('a pattern that leaves the teach group is removed from the index', async () => {
    writePattern(vault, pattern('moved', { status: 'approved', group: 'teach', approved_at: '2026-10-02T00:00:00.000Z' }));
    await indexVault(vault);
    assert.deepStrictEqual(indexedPaths(), ['patterns/moved.md']);
    writePattern(vault, pattern('moved', { status: 'approved', group: 'test', approved_at: '2026-10-02T00:00:00.000Z' }));
    await indexVault(vault);
    assert.deepStrictEqual(indexedPaths(), []);
    assert.strictEqual(searchDocuments('zebrafinch', 50).filter(r => r.title.includes('moved')).length, 0);
  });

  it('other notes are indexed as before', async () => {
    await indexVault(vault);
    assert.deepStrictEqual(searchDocuments('zebrafinch', 50).map(r => r.title), ['Ordinary note']);
  });
});
