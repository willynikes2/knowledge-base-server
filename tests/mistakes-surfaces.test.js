// tests/mistakes-surfaces.test.js — the MCP tools, the /api/v1 routes and the KB mirror.
// HOME is replaced before anything from src/ is loaded, so no test touches the real ~/.knowledge-base.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kb-surfaces-home-'));
process.env.HOME = HOME;
process.env.KB_API_KEY_SWARM = 'swarm-key-123';

const { default: express } = await import('express');
const { default: Database } = await import('better-sqlite3');
const { setDbForTesting, searchDocuments, listDocuments } = await import('../src/db.js');
const { createApiKeyMiddleware } = await import('../src/middleware/api-key.js');
const { default: mistakesV1 } = await import('../src/routes/mistakes-v1.js');
const { getMistakeToolDefinitions } = await import('../src/mistakes/tools.js');
const { mirrorMistake, mistakeDocument } = await import('../src/mistakes/mirror.js');
const { currentMistakes, validateMistake } = await import('../src/mistakes/store.js');
const { writePattern } = await import('../src/mistakes/patterns.js');
const { readDeliveries } = await import('../src/mistakes/delivery.js');

const record = (extra = {}) => ({ source: 'swarm', project: 'demo', task: 'T4 Run manager', caught_by: 'review:opus',
  finding: 'an internal error is shown instead of the recorded fallback', client_ok: true, ...extra });
const AUTH = { 'X-API-Key': 'swarm-key-123', 'Content-Type': 'application/json' };

let mistakesHome; let vault; let db;
beforeEach(() => {
  mistakesHome = mkdtempSync(join(tmpdir(), 'kb-surfaces-ledger-')); process.env.KB_MISTAKES_HOME = mistakesHome;
  vault = mkdtempSync(join(tmpdir(), 'kb-surfaces-vault-')); process.env.OBSIDIAN_VAULT_PATH = vault;
  db = new Database(':memory:'); setDbForTesting(db);
});
afterEach(() => {
  setDbForTesting(null); db.close();
  delete process.env.KB_MISTAKES_HOME; delete process.env.OBSIDIAN_VAULT_PATH;
  rmSync(mistakesHome, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true });
});
after(() => rmSync(HOME, { recursive: true, force: true }));

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createApiKeyMiddleware(), mistakesV1);
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}/api/v1`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (base, path, body, headers = AUTH) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const teachPattern = () => writePattern(vault, { id: 'pt_fallback', name: 'Fall back when the browser is down', status: 'approved', group: 'teach',
  rule: 'Return the recorded fallback when the browser cannot start.', tags: ['fallback', 'browser'], evidence: [], bad: 'bad', good: 'return fallback();', approved_at: '2026-10-14T00:00:00.000Z' });

describe('the KB mirror', () => {
  it('makes a searchable document of type "mistake" that names the ledger id', () => {
    const r = validateMistake(record({ fix_commit: 'abc1234', fix_diff: '+return fallback("browser_down");', tags: ['fallback'], file: 'web/src/runs.ts', line: 154 }));
    const doc = mirrorMistake(r);
    assert.strictEqual(doc.doc_type, 'mistake');
    assert.strictEqual(doc.source, r.id);
    assert.strictEqual(doc.tags, 'mistake, swarm, fallback');
    assert.strictEqual(searchDocuments('recorded fallback', 5).length, 1);
    const { title, content } = mistakeDocument(r);
    assert.strictEqual(title, 'Mistake: demo — T4 Run manager');
    assert.match(content, /File: web\/src\/runs\.ts:154\nFix commit: abc1234/);
    assert.match(content, /```diff\n\+return fallback/);
  });
});

describe('MCP tools', () => {
  const tool = (name) => getMistakeToolDefinitions().find(t => t.name === name);
  const parse = (result) => JSON.parse(result.content[0].text);

  it('defines kb_mistake_record and kb_patterns_for', () => {
    assert.deepStrictEqual(getMistakeToolDefinitions().map(t => t.name), ['kb_mistake_record', 'kb_patterns_for']);
    for (const t of getMistakeToolDefinitions()) { assert.ok(t.description.length > 40); assert.strictEqual(typeof t.handler, 'function'); assert.ok(t.schema); }
  });

  it('kb_mistake_record writes a manual record and mirrors it', async () => {
    const { source: _omit, ...args } = record();
    const out = parse(await tool('kb_mistake_record').handler(args));
    assert.deepStrictEqual([out.duplicate, out.mirrored], [false, true]);
    assert.strictEqual(currentMistakes().mistakes[0].source, 'manual');
    assert.strictEqual(listDocuments({ type: 'mistake' }).length, 1);
  });

  it('kb_mistake_record answers with the reason when the record is refused', async () => {
    const r = await tool('kb_mistake_record').handler(record({ client_ok: false }));
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^Error: client_ok is false/);
    assert.strictEqual(currentMistakes().mistakes.length, 0);
  });

  it('kb_patterns_for returns the matching pitfalls and logs the delivery', async () => {
    teachPattern();
    const out = parse(await tool('kb_patterns_for').handler({ task_text: 'recorded fallback when the browser is down', files: [], run: 'r1', task: 'T4' }));
    assert.deepStrictEqual(out.patterns.map(p => p.id), ['pt_fallback']);
    assert.match(out.markdown, /^## Known pitfalls/);
    assert.deepStrictEqual(readDeliveries().map(d => [d.run, d.task]), [['r1', 'T4']]);
  });
});

describe('/api/v1 routes', () => {
  it('needs an API key, and accepts the swarm key', async () => {
    await withServer(async (base) => {
      assert.strictEqual((await post(base, '/mistakes', record(), { 'Content-Type': 'application/json' })).status, 401);
      assert.strictEqual((await post(base, '/mistakes', record(), { ...AUTH, 'X-API-Key': 'wrong' })).status, 403);
      assert.strictEqual((await post(base, '/mistakes', record())).status, 201);
    });
  });

  it('POST /mistakes: 201 then 200 for the same key, 400 with the reason for a bad record', async () => {
    await withServer(async (base) => {
      const first = await post(base, '/mistakes', record({ key: 'swarm:demo:bead-1:0' }));
      const body = await first.json();
      assert.deepStrictEqual([first.status, body.duplicate, body.mirrored], [201, false, true]);
      const again = await post(base, '/mistakes', record({ key: 'swarm:demo:bead-1:0' }));
      assert.deepStrictEqual([again.status, (await again.json()).id], [200, body.id]);
      const bad = await post(base, '/mistakes', record({ client_ok: false }));
      assert.strictEqual(bad.status, 400);
      assert.match((await bad.json()).error, /client_ok is false/);
      const unknown = await post(base, '/mistakes', record({ supersedes: 'mk_01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
      assert.strictEqual(unknown.status, 400);
      assert.strictEqual(currentMistakes().mistakes.length, 1);
    });
  });

  it('POST /patterns/for: the pitfalls for a task, nothing for no match, 400 without task_text', async () => {
    teachPattern();
    await withServer(async (base) => {
      const hit = await (await post(base, '/patterns/for', { task_text: 'recorded fallback when the browser is down', files: ['web/src/runs.ts'], run: 'r1', task: 'T4' })).json();
      assert.deepStrictEqual(hit.patterns.map(p => p.id), ['pt_fallback']);
      assert.deepStrictEqual(await (await post(base, '/patterns/for', { task_text: 'add a CSV export' })).json(), { patterns: [], markdown: '' });
      assert.strictEqual((await post(base, '/patterns/for', { files: [] })).status, 400);
      assert.strictEqual((await post(base, '/patterns/for', { task_text: 'browser fallback recorded', files: 'not-a-list' })).status, 200);
    });
  });

  it('POST /runs and GET /mistakes/metrics', async () => {
    await withServer(async (base) => {
      const run = { source: 'swarm', project: 'demo', run: 'live-demo', model: 'claude-sonnet', attempted: 6, first_pass: 4, fix_rounds: 2 };
      assert.strictEqual((await post(base, '/runs', run)).status, 201);
      assert.strictEqual((await post(base, '/runs', run)).status, 200);
      const bad = await post(base, '/runs', { ...run, first_pass: 9 });
      assert.strictEqual(bad.status, 400);
      assert.match((await bad.json()).error, /first_pass cannot be more than attempted/);
      await post(base, '/mistakes', record());
      const m = await (await fetch(`${base}/mistakes/metrics`, { headers: AUTH })).json();
      assert.deepStrictEqual([m.mistakes.total, m.mistakes.by_source.swarm, m.mistakes.by_evidence.weak], [1, 1, 1]);
      assert.deepStrictEqual([m.one_shot[0].model, m.one_shot[0].rate], ['claude-sonnet', 0.667]);
      assert.strictEqual(m.patterns.teach, 0);
    });
  });

  it('answers 400, not a crash, for a body that is not an object', async () => {
    await withServer(async (base) => {
      assert.strictEqual((await post(base, '/mistakes', [1, 2])).status, 400);
      assert.strictEqual((await post(base, '/runs', [])).status, 400);
    });
  });
});
