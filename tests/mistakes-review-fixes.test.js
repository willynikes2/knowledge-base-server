// tests/mistakes-review-fixes.test.js — regressions for the findings of the final review and the security pass.
// HOME is replaced before anything from src/ is loaded, so no test touches the real ~/.knowledge-base.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kb-fixes-home-'));
process.env.HOME = HOME;
process.env.KB_API_KEY_SWARM = 'swarm-key-for-tests';
process.env.KB_API_KEY_CLAUDE = 'claude-key-for-tests';

const { default: express } = await import('express');
const { default: Database } = await import('better-sqlite3');
const { setDbForTesting, listDocuments } = await import('../src/db.js');
const { createApiKeyMiddleware } = await import('../src/middleware/api-key.js');
const { default: v1Router } = await import('../src/routes/v1.js');
const { getHttpToolDefinitions, getToolDefinitions } = await import('../src/tools.js');
const { currentMistakes, ledgerPath, readJsonl, recordMistake, validateMistake } = await import('../src/mistakes/store.js');
const { redactSecrets } = await import('../src/mistakes/redact.js');
const { getPattern, listPatterns, patternsDir, setStatus, writePattern } = await import('../src/mistakes/patterns.js');
const { draftPatterns, unassignedMistakes } = await import('../src/mistakes/draft.js');
const { applyReply, approvalMapPath, writeApprovalPage } = await import('../src/mistakes/approval.js');
const { mirrorMistake } = await import('../src/mistakes/mirror.js');
const { importSdd } = await import('../src/mistakes/import-sdd.js');
const { importSeed } = await import('../src/mistakes/import-seed.js');
const { recordRun, runsPath } = await import('../src/mistakes/metrics.js');
const { mistakesCmd } = await import('../src/cli/mistakes-cli.js');

const record = (extra = {}) => ({ source: 'manual', project: 'demo', task: 'T1', caught_by: 'review:opus', finding: 'a plain finding', client_ok: true, ...extra });
const pattern = (slug, extra = {}) => ({ id: `pt_${slug}`, name: `Pattern ${slug}`, status: 'draft', group: null, rule: 'Check the result before using it.',
  tags: ['checks'], evidence: [], bad: 'bad', good: 'good', created: '2026-10-01T00:00:00.000Z', ...extra });
// Made-up strings with the shape of a secret: a known prefix followed by filler. None is a real credential.
const filler = (n) => 'Ab1'.repeat(Math.ceil(n / 3)).slice(0, n);
const SHAPES = {
  'a provider key with dashes and underscores': `sk-ant-api03-${filler(20)}_${filler(20)}-${filler(12)}`,
  'a project-scoped provider key': `sk-proj-${filler(24)}_${filler(16)}`,
  'a fine-grained source-host token': `github_pat_${filler(22)}_${filler(40)}`,
  'a chat-platform bot token': `xoxb-${'1'.repeat(12)}-${'2'.repeat(13)}-${filler(24)}`,
  'a cloud API key': `AIza${filler(35)}`,
  'a bearer header': `Authorization: Bearer ${filler(36)}`,
  'a quoted JSON key': `"apiKey": "${filler(20)}"`,
  'a named secret with spaces': `aws_secret_access_key = ${filler(40)}`,
  'a password inside a URL': `https://deploy:${filler(14)}@example.com/repo.git`,
  'a private key block': `-----BEGIN PRIVATE KEY-----\n${filler(64)}\n${filler(64)}\n-----END PRIVATE KEY-----`,
};

let ledgerHome; let vault; let db;
beforeEach(() => {
  ledgerHome = mkdtempSync(join(tmpdir(), 'kb-fixes-ledger-')); process.env.KB_MISTAKES_HOME = ledgerHome;
  vault = mkdtempSync(join(tmpdir(), 'kb-fixes-vault-')); process.env.OBSIDIAN_VAULT_PATH = vault;
  db = new Database(':memory:'); setDbForTesting(db);
});
afterEach(() => {
  setDbForTesting(null); db.close();
  delete process.env.KB_MISTAKES_HOME; delete process.env.OBSIDIAN_VAULT_PATH;
  rmSync(ledgerHome, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true });
});
after(() => rmSync(HOME, { recursive: true, force: true }));

describe('secrets are removed from everything a record keeps', () => {
  for (const [name, secret] of Object.entries(SHAPES)) {
    it(`removes ${name}`, () => {
      const tail = filler(12); // every shape carries at least this much of the made-up secret
      for (const text of [secret, `+const value = ${JSON.stringify(secret)};`, `before ${secret} after`]) {
        const out = redactSecrets(text);
        assert.ok(!out.replace(/\s+/g, '').includes(tail), `still present in: ${out.slice(0, 60)}`);
        assert.ok(out.includes('[REDACTED]'));
      }
      const r = validateMistake(record({ finding: `leaked ${secret}`, fix_diff: `-x\n+${secret}\n`, task: `T1 ${secret}`.slice(0, 190), guard_test: secret.slice(0, 250) }));
      for (const field of ['finding', 'fix_diff', 'task', 'guard_test']) assert.ok(!r[field].replace(/\s+/g, '').includes(tail), field);
    });
  }

  it('leaves ordinary code and prose alone', () => {
    for (const text of ['const total = items.length + 1;', 'returns null for an empty file', 'see docs/plan.md#task-4 and commit abc1234', 'max_tokens: 1000', 'https://example.com/a/b?c=d']) {
      assert.strictEqual(redactSecrets(text), text);
    }
    assert.strictEqual(redactSecrets(null), null);
    assert.strictEqual(redactSecrets(''), '');
  });
});

describe('the idempotency key is never rewritten', () => {
  it('keeps a valid key exactly as given', () => {
    for (const key of ['seed:1510', 'sdd:demo:T5:fix1:0a1b2c3d4e5f', 'swarm:browser-agent-demo:live-demo:live-demo-r8i:0', 'manual:x/y#z@1']) {
      assert.strictEqual(validateMistake(record({ key })).key, key);
    }
  });

  it('refuses a key it would have to change, so two different keys can never become one', () => {
    for (const key of [`${'a'.repeat(299)}X1`, 'has space', ' padded ', 'token=abcdefgh12345678', 'new\nline', '', 42, {}]) {
      if (key === '') { assert.strictEqual(validateMistake(record({ key })).key, null); continue; }
      assert.throws(() => validateMistake(record({ key })), /key may use letters, digits and/, JSON.stringify(key));
    }
    recordMistake(record({ key: `${'a'.repeat(299)}1` }));
    recordMistake(record({ key: `${'a'.repeat(299)}2`, task: 'T2' }));
    assert.strictEqual(currentMistakes().mistakes.length, 2);
  });

  it('import-sdd builds a valid key from a project name with spaces', () => {
    const dir = join(ledgerHome, 'repo', '.superpowers', 'sdd', 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'progress.md'), '# SDD ledger — plan: p.md\n');
    writeFileSync(join(dir, 'task-1-fix1.md'), '## 1. One\nx');
    const noGit = () => ({ diff: null, guardTest: null });
    assert.strictEqual(importSdd(dir, { project: 'My Project (v2)', clientOk: true, evidence: noGit }).added, 1);
    assert.strictEqual(importSdd(dir, { project: 'My Project (v2)', clientOk: true, evidence: noGit }).duplicates, 1);
    assert.match(currentMistakes().mistakes[0].key, /^sdd:My-Project-v2:T1:fix1:[0-9a-f]{12}$/);
  });

  it('a run is told apart by its parts, not by a joined string', () => {
    const run = { source: 'swarm', model: 'm', attempted: 1, first_pass: 1 };
    assert.strictEqual(recordRun({ ...run, project: 'a:b', run: 'c' }).duplicate, false);
    assert.strictEqual(recordRun({ ...run, project: 'a', run: 'b:c' }).duplicate, false);
    assert.strictEqual(recordRun({ ...run, project: 'a', run: 'b:c' }).duplicate, true);
    assert.strictEqual(readJsonl(runsPath()).rows.length, 2);
  });
});

describe('bounded fields', () => {
  it('caught_by has a short model name or none', () => {
    assert.strictEqual(validateMistake(record({ caught_by: 'review:claude-opus-5.5' })).caught_by, 'review:claude-opus-5.5');
    assert.throws(() => validateMistake(record({ caught_by: `review:${'a'.repeat(61)}` })), /caught_by must be/);
    assert.throws(() => validateMistake(record({ caught_by: `review:${'a'.repeat(1_000_000)}` })), /caught_by must be/);
  });
});

describe('pattern notes are data', () => {
  it('a note whose header names a code language is skipped with a reason', () => {
    writePattern(vault, pattern('fine'));
    writeFileSync(join(patternsDir(vault), 'odd.md'), '---js\n{ "id": "pt_odd", "name": "x", "status": "draft", "rule": "r", "evidence": [], "bad": "b", "good": "g" }\n---\n');
    const { patterns, skipped } = listPatterns(vault);
    assert.deepStrictEqual(patterns.map(p => p.id), ['pt_fine']);
    assert.match(skipped[0].reason, /only YAML note headers are read/);
  });
});

describe('drafting', () => {
  const add = (task, extra = {}) => recordMistake(record({ task, source: 'swarm', finding: `unreadable state treated as empty in ${task}`, fix_commit: 'abc1234', fix_diff: '+throw e;', ...extra })).id;
  const answer = (ids, name = 'Check result') => async () => JSON.stringify([{ name, rule: 'Only a missing file is empty.', tags: ['state'], ids }]);

  it('never overwrites a note that exists but cannot be read; the new draft gets its own file', async () => {
    writePattern(vault, pattern('check-result', { status: 'approved', group: 'teach', approved_at: '2026-10-01T00:00:00.000Z', rule: 'The operator wrote this rule by hand.' }));
    const file = join(patternsDir(vault), 'check-result.md');
    const broken = readFileSync(file, 'utf8').replace('The operator wrote this rule by hand.', Array.from({ length: 61 }, () => 'word').join(' '));
    writeFileSync(file, broken);
    assert.strictEqual(listPatterns(vault).patterns.length, 0, 'the edited note is unreadable');
    const a = add('T2'); const b = add('T4');
    const r = await draftPatterns({ vault, llm: answer([a, b]) });
    assert.deepStrictEqual(r.drafted.map(d => d.id), ['pt_check-result-2']);
    assert.strictEqual(readFileSync(file, 'utf8'), broken, 'the hand-edited note is untouched');
  });

  it('a correction to a mistake stays with the pattern that used the original', async () => {
    const a = add('T2'); const b = add('T4');
    await draftPatterns({ vault, llm: answer([a, b], 'Rejected idea') });
    setStatus(vault, 'pt_rejected-idea', 'reject');
    const c = recordMistake(record({ task: 'T2', source: 'swarm', finding: 'a corrected wording of the same mistake', supersedes: a })).id;
    const d = recordMistake(record({ task: 'T2', source: 'swarm', finding: 'corrected again', supersedes: c })).id;
    const e = add('T9');
    const open = unassignedMistakes(currentMistakes().mistakes, listPatterns(vault).patterns, readJsonl(ledgerPath()).rows).map(m => m.id);
    assert.deepStrictEqual(open, [e], `the corrections ${c} and ${d} are not proposed again`);
    let asked = 0;
    await draftPatterns({ vault, llm: async () => { asked += 1; return '[]'; } });
    assert.strictEqual(asked, 0, 'one open task is not enough to ask the model');
  });
});

describe('the approval reply applies to what was on the page', () => {
  const NOW = new Date('2026-10-14T00:00:00Z');

  it('a number keeps its pattern when the page is made again with new drafts', () => {
    writePattern(vault, pattern('m-first')); writePattern(vault, pattern('z-second'));
    writeApprovalPage({ vault, now: NOW });
    writePattern(vault, pattern('a-later'));
    const again = writeApprovalPage({ vault, now: NOW });
    const items = JSON.parse(readFileSync(approvalMapPath(), 'utf8')).items;
    assert.deepStrictEqual(items.map(i => [i.n, i.id]), [[1, 'pt_m-first'], [2, 'pt_z-second'], [3, 'pt_a-later']]);
    const html = readFileSync(again.file, 'utf8');
    assert.ok(html.indexOf('Pattern m-first') < html.indexOf('Pattern z-second') && html.indexOf('Pattern z-second') < html.indexOf('Pattern a-later'), 'the page lists them by number');
    applyReply('approve 1', { vault, now: NOW });
    assert.strictEqual(getPattern(vault, 'pt_m-first').status, 'approved');
    assert.strictEqual(getPattern(vault, 'pt_a-later').status, 'draft');
  });

  it('a number is never reused for another pattern', () => {
    writePattern(vault, pattern('one')); writePattern(vault, pattern('two'));
    writeApprovalPage({ vault, now: NOW });
    applyReply('reject 1', { vault, now: NOW });
    writePattern(vault, pattern('three'));
    writeApprovalPage({ vault, now: NOW });
    const items = JSON.parse(readFileSync(approvalMapPath(), 'utf8')).items;
    assert.deepStrictEqual(items.map(i => [i.n, i.id]), [[2, 'pt_two'], [3, 'pt_three']]);
    assert.throws(() => applyReply('approve 1', { vault, now: NOW }), /there is no number 1 on the latest page/);
  });

  it('refuses a decision about a pattern that changed after the page was made', () => {
    writePattern(vault, pattern('one')); writePattern(vault, pattern('two'));
    writeApprovalPage({ vault, now: NOW });
    writePattern(vault, pattern('one', { rule: 'A different rule that the operator never saw.' }));
    assert.throws(() => applyReply('approve 2, approve 1', { vault, now: NOW }), /number 1 \(Pattern one\) changed after the page was made; run "kb patterns page" again/);
    assert.strictEqual(getPattern(vault, 'pt_two').status, 'draft', 'nothing is applied');
  });
});

describe('who may use the ledger routes', () => {
  async function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createApiKeyMiddleware(), v1Router);
    const server = app.listen(0);
    try { await fn(`http://127.0.0.1:${server.address().port}/api/v1`); } finally { await new Promise(resolve => server.close(resolve)); }
  }
  const SWARM = { 'X-API-Key': 'swarm-key-for-tests', 'Content-Type': 'application/json' };
  const OTHER = { 'X-API-Key': 'claude-key-for-tests', 'Content-Type': 'application/json' };
  const post = (base, path, body, headers) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('only the swarm key can write records, ask for pitfalls, send runs or read the numbers', async () => {
    await withServer(async (base) => {
      for (const [path, body] of [['/mistakes', record()], ['/patterns/for', { task_text: 'x y z' }], ['/runs', { source: 'swarm', project: 'p', run: 'r', model: 'm', attempted: 1, first_pass: 1 }]]) {
        const refused = await post(base, path, body, OTHER);
        assert.strictEqual(refused.status, 403, path);
        assert.match((await refused.json()).error, /swarm key/);
      }
      assert.strictEqual((await fetch(`${base}/mistakes/metrics`, { headers: OTHER })).status, 403);
      assert.strictEqual(currentMistakes().mistakes.length, 0);
      assert.strictEqual((await post(base, '/mistakes', record(), SWARM)).status, 201);
      assert.strictEqual((await fetch(`${base}/mistakes/metrics`, { headers: SWARM })).status, 200);
    });
  });

  it('the swarm key opens nothing else in the API', async () => {
    await withServer(async (base) => {
      for (const path of ['/stats', '/search?q=secret', '/documents', '/documents/1', '/context?q=x']) {
        const r = await fetch(`${base}${path}`, { headers: SWARM });
        assert.strictEqual(r.status, 403, path);
      }
      assert.strictEqual((await post(base, '/ingest', { title: 't', content: 'c' }, SWARM)).status, 403);
      assert.strictEqual((await fetch(`${base}/stats`, { headers: OTHER })).status, 200, 'other keys are unaffected');
    });
  });

  it('a record sent over HTTP is always a swarm record and cannot replace another', async () => {
    const old = recordMistake(record()).id;
    await withServer(async (base) => {
      const replaced = await post(base, '/mistakes', record({ supersedes: old }), SWARM);
      assert.strictEqual(replaced.status, 400);
      assert.match((await replaced.json()).error, /supersedes cannot be set over HTTP/);
      assert.strictEqual((await post(base, '/mistakes', record({ source: 'seed', task: 'T7' }), SWARM)).status, 201);
    });
    const all = currentMistakes().mistakes;
    assert.deepStrictEqual(all.map(m => m.id).includes(old), true, 'the old record is still current');
    assert.strictEqual(all.find(m => m.task === 'T7').source, 'swarm');
  });

  it('a server fault answers with a plain message, not the internal one', async () => {
    writeFileSync(join(ledgerHome, 'ledger.jsonl'), '');
    rmSync(join(ledgerHome, 'ledger.jsonl'));
    mkdirSync(join(ledgerHome, 'ledger.jsonl')); // a folder where the file should be: reads and appends fail
    await withServer(async (base) => {
      const r = await post(base, '/mistakes', record(), SWARM);
      assert.strictEqual(r.status, 500);
      const body = await r.json();
      assert.strictEqual(body.error, 'The server could not complete this request.');
      assert.ok(!JSON.stringify(body).includes(ledgerHome));
    });
  });

  it('recording and fetching pitfalls by MCP are local only', () => {
    const local = getToolDefinitions().map(t => t.name);
    const remote = getHttpToolDefinitions().map(t => t.name);
    assert.ok(local.includes('kb_mistake_record') && local.includes('kb_patterns_for'));
    assert.ok(!remote.includes('kb_mistake_record'));
    assert.ok(!remote.includes('kb_patterns_for'));
  });
});

describe('the KB copy of a record', () => {
  it('is made once, also when the same record is sent again after a failed copy', () => {
    let fail = true;
    const flaky = (r) => { if (fail) throw new Error('database is locked'); return mirrorMistake(r); };
    const first = recordMistake(record({ key: 'manual:demo:1' }), { mirror: flaky });
    assert.deepStrictEqual([first.duplicate, first.mirrored], [false, false]);
    assert.strictEqual(listDocuments({ type: 'mistake' }).length, 0);
    fail = false;
    const again = recordMistake(record({ key: 'manual:demo:1' }), { mirror: flaky });
    assert.deepStrictEqual([again.duplicate, again.mirrored], [true, true]);
    recordMistake(record({ key: 'manual:demo:1' }), { mirror: flaky });
    assert.strictEqual(listDocuments({ type: 'mistake' }).length, 1, 'never copied twice');
    assert.strictEqual(currentMistakes().mistakes.length, 1);
  });

  it('imports say how many copies failed', async () => {
    const file = join(ledgerHome, 'catalogue.json');
    writeFileSync(file, JSON.stringify([{ kb_id: 1, title: 'First' }, { kb_id: 2, title: 'Second' }]));
    const broken = () => { throw new Error('database is locked'); };
    assert.strictEqual(importSeed(file, { mirror: broken }).unmirrored, 2);
    const lines = [];
    await mistakesCmd(['import-seed', file], { log: (l) => lines.push(l), mirror: broken });
    assert.match(lines.join('\n'), /2 could not be copied into the KB search \(run the import again to retry\)/);
    await mistakesCmd(['import-seed', file], { log: (l) => lines.push(l) });
    assert.strictEqual(listDocuments({ type: 'mistake' }).length, 2, 'a second run makes the missing copies');
  });
});

describe('the swarm key at the server gate', () => {
  const run = async (headers, baseUrl) => {
    const { createBrainAuth } = await import('../src/middleware/brain-auth.js');
    const gate = createBrainAuth({ verifyAccessToken: async () => null, challenge: () => 'Bearer x' });
    return new Promise((resolve) => {
      const req = { headers, baseUrl };
      const res = { setHeader() {}, status: (code) => ({ json: (body) => resolve({ passed: false, code, body }) }) };
      gate(req, res, () => resolve({ passed: true, service: req.apiService }));
    });
  };

  it('is accepted for the API, where the router limits it to the ledger routes', async () => {
    assert.deepStrictEqual(await run({ 'x-api-key': 'swarm-key-for-tests' }, '/api/v1'), { passed: true, service: 'swarm' });
    assert.deepStrictEqual(await run({ authorization: 'Bearer swarm-key-for-tests' }, '/api/v1'), { passed: true, service: 'swarm' });
  });

  it('is refused everywhere else, including the MCP endpoint', async () => {
    for (const baseUrl of ['', '/mcp', undefined]) {
      for (const headers of [{ 'x-api-key': 'swarm-key-for-tests' }, { authorization: 'Bearer swarm-key-for-tests' }]) {
        const r = await run(headers, baseUrl);
        assert.deepStrictEqual([r.passed, r.code], [false, 403], `${JSON.stringify(headers)} at ${baseUrl}`);
        assert.match(r.body.error, /swarm key can only use the mistake-ledger routes/);
      }
    }
    assert.deepStrictEqual(await run({ 'x-api-key': 'claude-key-for-tests' }, ''), { passed: true, service: 'claude' }, 'other keys are unaffected');
  });
});

describe('the drafting model call', () => {
  it('runs with every tool turned off, one turn, no settings and no MCP servers', async () => {
    const { llmArgs } = await import('../src/mistakes/draft.js');
    const args = llmArgs('some-model');
    const valueOf = (flag) => args[args.indexOf(flag) + 1];
    assert.strictEqual(valueOf('--tools'), '', 'an empty list turns every tool off');
    assert.strictEqual(valueOf('--max-turns'), '1');
    assert.strictEqual(valueOf('--model'), 'some-model');
    assert.strictEqual(valueOf('--setting-sources'), '');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence') && args.includes('-p'));
  });
});

describe('redaction stays fast on long input', () => {
  it('a megabyte of text with no secret takes well under a second', () => {
    for (const text of ['a'.repeat(1_000_000), 'ab-'.repeat(333_334), 'token '.repeat(170_000), `x=${'b'.repeat(999_998)}`]) {
      const started = Date.now();
      redactSecrets(text);
      assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms on ${JSON.stringify(text.slice(0, 6))}…`);
    }
  });

  it('a huge diff is cut at a line boundary before redaction, and its secrets are still removed', () => {
    const secret = `sk-ant-api03-${filler(40)}`;
    const diff = `+const k = "${secret}";\n${'+x\n'.repeat(400_000)}`;
    const started = Date.now();
    const r = validateMistake(record({ fix_diff: diff }));
    assert.ok(Date.now() - started < 2000);
    assert.ok(!r.fix_diff.includes(filler(20)));
    assert.ok(Buffer.byteLength(r.fix_diff) <= 4096);
  });
});

describe('fetching pitfalls is local or swarm only', () => {
  it('kb_patterns_for is not offered to remote MCP clients', () => {
    assert.ok(!getHttpToolDefinitions().map(t => t.name).includes('kb_patterns_for'));
    assert.ok(getToolDefinitions().map(t => t.name).includes('kb_patterns_for'));
  });
});
