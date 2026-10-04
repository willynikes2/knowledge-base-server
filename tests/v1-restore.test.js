// tests/v1-restore.test.js — HTTP /export and /restore input handling
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { initSchema, setDbForTesting } from '../src/db.js';
import { buildManifest, sha256String } from '../src/export/manifest.js';

const root = join(tmpdir(), `kb-test-v1-restore-${randomBytes(4).toString('hex')}`);
const exportRoot = join(root, 'exports');
const vault = join(root, 'vault');
const outside = join(root, 'outside');

process.env.KB_API_KEY_CLAUDE = 'test-key-123';
process.env.KB_EXPORT_ROOT = exportRoot;
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.KB_ENABLE_REMOTE_RESTORE = 'true';

const AUTH = { 'X-API-Key': 'test-key-123', 'Content-Type': 'application/json' };

function writeBundle(dir, files) {
  const entries = Object.entries(files).map(([vaultPath, content]) => {
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', vaultPath), content, 'utf8');
    return {
      vault_path: vaultPath,
      sha256: sha256String(content),
      size: Buffer.byteLength(content, 'utf8'),
      title: vaultPath.replace(/\.md$/, ''),
      doc_type: 'note',
      tags: [],
      original_db_id: null,
      restore_destination: vaultPath,
    };
  });
  const manifest = buildManifest({
    kbServerVersion: '1.0.0',
    filterSpec: { all: true },
    filterExpanded: {},
    files: entries,
    counts: { docs: entries.length, attachments: 0 },
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

describe('v1 restore input handling', () => {
  let server, port, db;

  before(async () => {
    for (const d of [exportRoot, vault, outside]) mkdirSync(d, { recursive: true });
    db = new Database(':memory:');
    initSchema(db);
    setDbForTesting(db);
    const { createApiKeyMiddleware } = await import('../src/middleware/api-key.js');
    const { default: v1Router } = await import('../src/routes/v1.js');
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createApiKeyMiddleware(), v1Router);
    server = app.listen(0);
    port = server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  function post(path, body) {
    return fetch(`http://localhost:${port}/api/v1${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  }

  it('treats overwrite: "false" as false', async () => {
    writeFileSync(join(vault, 'note.md'), '# Original\n', 'utf8');
    writeBundle(join(exportRoot, 'b1'), { 'note.md': '# Incoming\n' });

    const res = await post('/restore', { bundle_path: 'b1', yes: true, overwrite: 'false', no_embeddings: true });

    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.strictEqual(readFileSync(join(vault, 'note.md'), 'utf8'), '# Original\n');
  });

  it('treats dry_run: "false" as a real restore that still requires yes=true', async () => {
    writeBundle(join(exportRoot, 'b2'), { 'new.md': '# New\n' });

    const res = await post('/restore', { bundle_path: 'b2', dry_run: 'false', no_embeddings: true });

    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /yes=true/);
  });

  it('rejects a bundle_path that escapes the export root through a symlink', async () => {
    writeBundle(join(outside, 'evil'), { 'x.md': '# x\n' });
    symlinkSync(join(outside, 'evil'), join(exportRoot, 'evil-link'));

    const res = await post('/restore', { bundle_path: 'evil-link', dry_run: true });

    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
    assert.match((await res.json()).error, /must stay under/);
  });

  it('rejects an output_path that escapes the export root through a symlink', async () => {
    symlinkSync(outside, join(exportRoot, 'out-link'));

    const res = await post('/export', { output_path: 'out-link/bundle' });

    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
    assert.ok(!existsSync(join(outside, 'bundle')));
  });
});
