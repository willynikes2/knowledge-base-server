// tests/mistakes-dashboard.test.js — the Learning panel's data route and its page hooks.
// HOME is replaced before anything from src/ is loaded, so no test touches the real ~/.knowledge-base.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'kb-dashboard-home-'));
process.env.HOME = HOME;

const { default: express } = await import('express');
const { default: apiRoutes } = await import('../src/routes/api.js');
const { createSession } = await import('../src/auth.js');
const { recordRun } = await import('../src/mistakes/metrics.js');
const { recordMistake } = await import('../src/mistakes/store.js');

const PUBLIC = fileURLToPath(new URL('../src/public/', import.meta.url));
let ledgerHome; let vault;
beforeEach(() => {
  ledgerHome = mkdtempSync(join(tmpdir(), 'kb-dashboard-ledger-')); process.env.KB_MISTAKES_HOME = ledgerHome;
  vault = mkdtempSync(join(tmpdir(), 'kb-dashboard-vault-')); process.env.OBSIDIAN_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.KB_MISTAKES_HOME; delete process.env.OBSIDIAN_VAULT_PATH;
  rmSync(ledgerHome, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true });
});
after(() => rmSync(HOME, { recursive: true, force: true }));

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(apiRoutes);
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const signedIn = () => ({ headers: { Cookie: `kb_session=${createSession()}` } });

describe('GET /api/mistakes/metrics', () => {
  it('needs a signed-in session', async () => {
    await withServer(async (base) => {
      assert.strictEqual((await fetch(`${base}/api/mistakes/metrics`)).status, 401);
      assert.strictEqual((await fetch(`${base}/api/mistakes/metrics`, { headers: { Cookie: 'kb_session=forged' } })).status, 401);
    });
  });

  it('returns the counts and the one-shot rate by model', async () => {
    recordMistake({ source: 'swarm', project: 'demo', task: 'T4', caught_by: 'review:opus', finding: 'no fallback', client_ok: true, fix_commit: 'abc1234' });
    recordRun({ source: 'swarm', project: 'demo', run: 'live-demo', model: 'claude-sonnet', attempted: 6, first_pass: 4, fix_rounds: 2 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/mistakes/metrics`, signedIn());
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual([body.mistakes.total, body.mistakes.by_evidence.strong], [1, 1]);
      assert.deepStrictEqual(body.one_shot.map(m => [m.model, m.rate, m.runs.length]), [['claude-sonnet', 0.667, 1]]);
      assert.strictEqual(body.patterns.unreadable_notes, 0);
    });
  });

  it('returns empty numbers, not an error, when nothing is recorded', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/mistakes/metrics`, signedIn())).json();
      assert.deepStrictEqual([body.mistakes.total, body.one_shot], [0, []]);
    });
  });
});

describe('the dashboard page', () => {
  it('has a Learning section that the script fills without innerHTML', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    const js = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
    assert.match(html, /data-section="learning"/);
    assert.match(html, /id="section-learning"/);
    assert.match(html, /id="learning-display"/);
    assert.match(js, /if \(name === 'learning'\) loadLearning\(\);/);
    assert.match(js, /fetch\('\/api\/mistakes\/metrics'\)/);
    const start = js.indexOf('async function loadLearning');
    assert.ok(start >= 0, 'app.js defines loadLearning');
    assert.ok(!js.slice(start, start + 4000).includes('innerHTML'), 'the panel builds its rows with textContent');
  });
});
