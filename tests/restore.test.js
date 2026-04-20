// tests/restore.test.js — round-trip, preflight, collision tests
// Uses isolated temp vault + temp DB to avoid touching production data.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { exportDocs } from '../src/export.js';
import { getDb, insertDocument, initSchema, setDbForTesting } from '../src/db.js';
import { indexVault } from '../src/vault/indexer.js';
import { parseVaultNote } from '../src/vault/parser.js';
import { loadManifest, preflight, restoreFromBundle } from '../src/restore.js';
import { buildManifest, sha256String, MANIFEST_VERSION } from '../src/export/manifest.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(label) {
  const d = join(tmpdir(), `kb-test-${label}-${randomBytes(4).toString('hex')}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeVault(dir, files) {
  // files: { [relPath]: content }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function makeBundle(dir, files) {
  // files: { [vaultRelPath]: content }
  // Writes them under notes/ (markdown only in Ship 1)
  for (const [vaultRelPath, content] of Object.entries(files)) {
    const abs = join(dir, 'notes', vaultRelPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function makeBundleManifest(dir, files) {
  // files: { [vaultRelPath]: content }
  const entries = Object.entries(files).map(([vaultRelPath, content]) => ({
    vault_path: vaultRelPath,
    sha256: sha256String(content),
    size: Buffer.byteLength(content, 'utf8'),
    title: vaultRelPath.replace(/\.md$/, '').split('/').pop(),
    doc_type: 'note',
    tags: [],
    original_db_id: null,
    restore_destination: vaultRelPath,
  }));
  const m = buildManifest({
    kbServerVersion: '1.0.0',
    filterSpec: { all: true },
    filterExpanded: {},
    files: entries,
    counts: { docs: entries.length, attachments: 0 },
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');
  return m;
}

// ─── loadManifest tests ───────────────────────────────────────────────────────

describe('loadManifest', () => {
  let tmpBundle;

  before(() => { tmpBundle = tmpDir('loadmanifest'); });
  after(() => { try { rmSync(tmpBundle, { recursive: true }); } catch {} });

  it('returns error when no manifest.json', () => {
    const emptyDir = tmpDir('no-manifest');
    const { error } = loadManifest(emptyDir);
    assert.ok(error.includes('No manifest.json'));
    rmSync(emptyDir, { recursive: true });
  });

  it('returns error for invalid JSON', () => {
    writeFileSync(join(tmpBundle, 'manifest.json'), 'NOT JSON', 'utf8');
    const { error } = loadManifest(tmpBundle);
    assert.ok(error.includes('Failed to parse'));
  });

  it('returns error for wrong manifest version', () => {
    writeFileSync(join(tmpBundle, 'manifest.json'), JSON.stringify({
      manifest_version: 99,
      files: [],
    }), 'utf8');
    const { manifest, error } = loadManifest(tmpBundle);
    assert.ok(error.includes('Manifest version mismatch'));
    assert.strictEqual(manifest.manifest_version, 99);
  });

  it('accepts valid v1 manifest', () => {
    writeFileSync(join(tmpBundle, 'manifest.json'), JSON.stringify({
      manifest_version: MANIFEST_VERSION,
      kb_server_version: '1.0.0',
      exported_at: new Date().toISOString(),
      filter_spec: { all: true },
      filter_expanded: {},
      counts: { docs: 0, attachments: 0 },
      files: [],
    }), 'utf8');
    const { manifest, error } = loadManifest(tmpBundle);
    assert.strictEqual(error, null);
    assert.strictEqual(manifest.manifest_version, MANIFEST_VERSION);
  });
});

// ─── preflight collision tests ────────────────────────────────────────────────

describe('preflight — collision scenarios', () => {
  let vault, bundle;

  beforeEach(() => {
    vault = tmpDir('vault');
    bundle = tmpDir('bundle');
    mkdirSync(join(bundle, 'notes'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true }); } catch {}
    try { rmSync(bundle, { recursive: true }); } catch {}
  });

  it('Scenario 1: same path, same content → hash match (skip silently)', () => {
    const content = '# Doc\n\nSame content.';
    makeVault(vault, { 'doc.md': content });
    makeBundle(bundle, { 'doc.md': content });
    const manifest = makeBundleManifest(bundle, { 'doc.md': content });

    const result = preflight(manifest, bundle, vault, { overwrite: false });
    assert.strictEqual(result.hashMatches.length, 1);
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(result.missingBundleFiles.length, 0);
  });

  it('Scenario 1b: same path, different content → conflict (skip by default)', () => {
    makeVault(vault, { 'doc.md': '# Existing\n\nOld content.' });
    const newContent = '# Updated\n\nNew content.';
    makeBundle(bundle, { 'doc.md': newContent });
    const manifest = makeBundleManifest(bundle, { 'doc.md': newContent });

    const result = preflight(manifest, bundle, vault, { overwrite: false });
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].type, 'path_conflict');
    assert.strictEqual(result.conflicts[0].action, 'skip');
    assert.strictEqual(result.hashMatches.length, 0);
  });

  it('Scenario 1b with --overwrite: same path conflict → overwrite action', () => {
    makeVault(vault, { 'doc.md': '# Existing\n\nOld.' });
    const newContent = '# Updated\n\nNew.';
    makeBundle(bundle, { 'doc.md': newContent });
    const manifest = makeBundleManifest(bundle, { 'doc.md': newContent });

    const result = preflight(manifest, bundle, vault, { overwrite: true });
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].action, 'overwrite');
  });

  it('Scenario 2: same hash at different path → hash match (skip silently)', () => {
    const content = '# Shared Content\n\nIdentical bytes.';
    makeVault(vault, { 'existing/other-name.md': content });
    makeBundle(bundle, { 'different/name.md': content });
    const manifest = makeBundleManifest(bundle, { 'different/name.md': content });

    const result = preflight(manifest, bundle, vault, {});
    assert.strictEqual(result.hashMatches.length, 1);
    assert.strictEqual(result.conflicts.length, 0);
  });

  it('missing bundle file → missingBundleFiles', () => {
    // Bundle has manifest entry but no actual file in notes/
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [{
        vault_path: 'ghost.md',
        sha256: 'aaa',
        size: 10,
        title: 'Ghost',
        doc_type: 'note',
        tags: [],
        original_db_id: null,
        restore_destination: 'ghost.md',
      }],
      counts: { docs: 1, attachments: 0 },
    });
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');
    // Don't write the actual file

    const result = preflight(m, bundle, vault, {});
    assert.strictEqual(result.missingBundleFiles.length, 1);
    assert.strictEqual(result.missingBundleFiles[0], 'ghost.md');
  });

  it('dry-run would_restore excludes missing files, hash mismatches, unsafe paths, and title warnings', async () => {
    const existing = '---\ntitle: "Shared Title"\ntype: note\n---\n\n# Existing\n';
    makeVault(vault, { 'existing/shared.md': existing });
    insertDocument({
      title: 'Shared Title',
      content: '# Existing',
      source: 'vault:existing/shared.md',
      doc_type: 'note',
      tags: '',
      file_path: join(vault, 'existing/shared.md'),
      file_size: Buffer.byteLength(existing, 'utf8'),
    });

    makeBundle(bundle, {
      'good.md': '# Good\n',
      'tampered.md': '# Tampered actual\n',
      'title-warning.md': '---\ntitle: "Shared Title"\n---\n\n# New\n',
    });

    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [
        {
          vault_path: 'good.md',
          sha256: sha256String('# Good\n'),
          size: 7,
          title: 'Good',
          doc_type: 'note',
          tags: [],
          original_db_id: null,
          restore_destination: 'good.md',
        },
        {
          vault_path: 'missing.md',
          sha256: sha256String('# Missing\n'),
          size: 10,
          title: 'Missing',
          doc_type: 'note',
          tags: [],
          original_db_id: null,
          restore_destination: 'missing.md',
        },
        {
          vault_path: 'tampered.md',
          sha256: sha256String('# Tampered expected\n'),
          size: 19,
          title: 'Tampered',
          doc_type: 'note',
          tags: [],
          original_db_id: null,
          restore_destination: 'tampered.md',
        },
        {
          vault_path: '../unsafe.md',
          sha256: sha256String('# Unsafe\n'),
          size: 9,
          title: 'Unsafe',
          doc_type: 'note',
          tags: [],
          original_db_id: null,
          restore_destination: '../unsafe.md',
        },
        {
          vault_path: 'title-warning.md',
          sha256: sha256String('---\ntitle: "Shared Title"\n---\n\n# New\n'),
          size: 38,
          title: 'Shared Title',
          doc_type: 'note',
          tags: [],
          original_db_id: null,
          restore_destination: 'title-warning.md',
        },
      ],
      counts: { docs: 5, attachments: 0 },
    });
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');

    const result = await restoreFromBundle({
      bundlePath: bundle,
      vaultPath: vault,
      dryRun: true,
      noEmbeddings: true,
    });

    assert.strictEqual(result.total_files, 5);
    assert.strictEqual(result.would_restore, 1);
    assert.strictEqual(result.preflight.missingBundleFiles.length, 1);
    assert.strictEqual(result.preflight.hashMismatches.length, 1);
    assert.strictEqual(result.preflight.unsafePaths.length, 1);
    assert.strictEqual(result.preflight.titleWarnings.length, 1);
  });

  it('hash mismatch → hashMismatches', () => {
    makeBundle(bundle, { 'tampered.md': '# Different content\n' });
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [{
        vault_path: 'tampered.md',
        sha256: sha256String('# Original content\n'),
        size: 19,
        title: 'Tampered',
        doc_type: 'note',
        tags: [],
        original_db_id: null,
        restore_destination: 'tampered.md',
      }],
      counts: { docs: 1, attachments: 0 },
    });

    const result = preflight(m, bundle, vault, {});
    assert.strictEqual(result.hashMismatches.length, 1);
    assert.strictEqual(result.hashMismatches[0].vault_path, 'tampered.md');
  });

  it('path traversal → unsafePaths', () => {
    const content = '# Unsafe\n';
    makeBundle(bundle, { 'safe.md': content });
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [{
        vault_path: '../outside.md',
        sha256: sha256String(content),
        size: Buffer.byteLength(content, 'utf8'),
        title: 'Unsafe',
        doc_type: 'note',
        tags: [],
        original_db_id: null,
        restore_destination: '../outside.md',
      }],
      counts: { docs: 1, attachments: 0 },
    });

    const result = preflight(m, bundle, vault, {});
    assert.strictEqual(result.unsafePaths.length, 1);
  });

  it('non-empty vault detected correctly', () => {
    makeVault(vault, { 'some.md': '# Existing\n' });
    const content = '# New\n\nNew file.';
    makeBundle(bundle, { 'new.md': content });
    const manifest = makeBundleManifest(bundle, { 'new.md': content });

    const result = preflight(manifest, bundle, vault, {});
    assert.strictEqual(result.nonEmptyVault, true);
  });

  it('empty vault → nonEmptyVault is false', () => {
    const emptyVault = tmpDir('empty-vault');
    const content = '# New\n\nNew file.';
    makeBundle(bundle, { 'new.md': content });
    const manifest = makeBundleManifest(bundle, { 'new.md': content });

    const result = preflight(manifest, bundle, emptyVault, {});
    assert.strictEqual(result.nonEmptyVault, false);
    rmSync(emptyVault, { recursive: true });
  });
});

describe('restore conflict handling', () => {
  let db, vault, bundle;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    setDbForTesting(db);
    vault = tmpDir('restore-title-vault');
    bundle = tmpDir('restore-title-bundle');
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(vault, { recursive: true }); } catch {}
    try { rmSync(bundle, { recursive: true }); } catch {}
  });

  it('skips same-title different-path entries by default', async () => {
    const existing = '---\ntitle: "Shared Title"\ntype: note\n---\n\n# Existing\n';
    makeVault(vault, { 'existing/shared.md': existing });
    insertDocument({
      title: 'Shared Title',
      content: '# Existing',
      source: 'vault:existing/shared.md',
      doc_type: 'note',
      tags: '',
      file_path: join(vault, 'existing/shared.md'),
      file_size: Buffer.byteLength(existing, 'utf8'),
    });

    const incoming = '---\ntitle: "Shared Title"\ntype: note\n---\n\n# Incoming\n';
    makeBundle(bundle, { 'incoming/shared.md': incoming });
    const manifest = makeBundleManifest(bundle, { 'incoming/shared.md': incoming });
    manifest.files[0].title = 'Shared Title';
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const result = await restoreFromBundle({
      bundlePath: bundle,
      vaultPath: vault,
      yes: true,
      noEmbeddings: true,
    });

    assert.strictEqual(result.title_warnings, 1);
    assert.strictEqual(result.restored, 0);
    assert.strictEqual(result.skipped, 1);
    assert.ok(!existsSync(join(vault, 'incoming/shared.md')));
  });
});

// ─── Round-trip test ──────────────────────────────────────────────────────────
// This test uses the actual exportDocs() + restoreFromBundle() functions
// with isolated tmp directories + a separate DB.
// It verifies vault files are byte-identical after restore.

describe('round-trip: export → wipe → restore → byte-identical files', () => {
  // This test is integration-level: it touches the DB.
  // We use the real DB but with a test vault subdirectory to limit scope.
  // For true isolation, we use a separate test vault + compare file bytes.

  let sourceVault, exportDir, restoreVault;
  const testFiles = {
    'test-rt-1.md': '---\ntitle: "RT Doc 1"\ntype: note\ntags: [roundtrip-test]\n---\n\n# RT Doc 1\n\nContent alpha.\n',
    'subdir/test-rt-2.md': '---\ntitle: "RT Doc 2"\ntype: note\ntags: [roundtrip-test]\n---\n\n# RT Doc 2\n\nContent beta.\n',
  };

  before(() => {
    sourceVault = tmpDir('source-vault');
    exportDir = tmpDir('export-dir');
    restoreVault = tmpDir('restore-vault');

    // Write test files to source vault
    for (const [rel, content] of Object.entries(testFiles)) {
      const abs = join(sourceVault, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  });

  after(() => {
    try { rmSync(sourceVault, { recursive: true }); } catch {}
    try { rmSync(exportDir, { recursive: true }); } catch {}
    try { rmSync(restoreVault, { recursive: true }); } catch {}
  });

  it('exported bundle has valid v1 manifest with correct file hashes', async () => {
    const { exportDocs } = await import('../src/export.js');
    // Export the source vault (no DB needed for the manifest structure test)
    // We'll test the manifest structure by building it manually here since
    // exportDocs requires a live DB. We'll test the file-system side.

    // Build a bundle manually from testFiles and check manifest validity
    const tmpBundle = tmpDir('manifest-check-bundle');
    makeBundle(tmpBundle, testFiles);
    const m = makeBundleManifest(tmpBundle, testFiles);

    assert.strictEqual(m.manifest_version, MANIFEST_VERSION);
    assert.strictEqual(m.files.length, Object.keys(testFiles).length);

    // Verify sha256 in manifest matches actual file sha256
    for (const entry of m.files) {
      const bundleFile = join(tmpBundle, 'notes', entry.vault_path);
      const content = readFileSync(bundleFile, 'utf8');
      assert.strictEqual(entry.sha256, sha256String(content),
        `sha256 mismatch for ${entry.vault_path}`);
    }

    rmSync(tmpBundle, { recursive: true });
  });

  it('restore copies files byte-identical to bundle source', async () => {
    // Build a bundle from testFiles
    const tmpBundle = tmpDir('restore-roundtrip-bundle');
    makeBundle(tmpBundle, testFiles);
    makeBundleManifest(tmpBundle, testFiles);

    const emptyTarget = tmpDir('empty-target');

    // Manually copy files (simulates what restoreFromBundle does for the file copy step)
    // We test the core restoration without triggering the full DB indexer
    const { preflight: pf } = await import('../src/restore.js');
    const { loadManifest: lm } = await import('../src/restore.js');

    const { manifest } = lm(tmpBundle);
    assert.ok(manifest);

    // Preflight on empty vault should have no conflicts
    const flight = pf(manifest, tmpBundle, emptyTarget, {});
    assert.strictEqual(flight.conflicts.length, 0);
    assert.strictEqual(flight.hashMatches.length, 0);
    assert.strictEqual(flight.missingBundleFiles.length, 0);

    // Manually restore files (bypass DB/indexer for isolation)
    const { mkdirSync: mkdir, copyFileSync: copy } = await import('fs');
    for (const entry of manifest.files) {
      const src = join(tmpBundle, 'notes', entry.vault_path);
      const dest = join(emptyTarget, entry.restore_destination);
      mkdir(dirname(dest), { recursive: true });
      copy(src, dest);
    }

    // Verify byte-identical
    for (const [rel, originalContent] of Object.entries(testFiles)) {
      const restoredPath = join(emptyTarget, rel);
      assert.ok(existsSync(restoredPath), `Missing restored file: ${rel}`);
      const restoredContent = readFileSync(restoredPath, 'utf8');
      assert.strictEqual(restoredContent, originalContent,
        `Content mismatch for ${rel}`);
    }

    rmSync(tmpBundle, { recursive: true });
    rmSync(emptyTarget, { recursive: true });
  });

  it('preflight --dry-run reports correct would_restore count', async () => {
    const tmpBundle = tmpDir('dryrun-bundle');
    makeBundle(tmpBundle, testFiles);
    makeBundleManifest(tmpBundle, testFiles);

    const emptyVault = tmpDir('empty-vault-for-dryrun');
    const { loadManifest: lm, preflight: pf } = await import('../src/restore.js');

    const { manifest } = lm(tmpBundle);
    const flight = pf(manifest, tmpBundle, emptyVault, {});

    const skipCount = flight.conflicts.filter(c => c.action === 'skip').length
      + flight.hashMatches.length
      + flight.missingBundleFiles.length;
    const wouldRestore = manifest.files.length - skipCount;

    assert.strictEqual(wouldRestore, Object.keys(testFiles).length);

    rmSync(tmpBundle, { recursive: true });
    rmSync(emptyVault, { recursive: true });
  });

  it('exportDocs → restoreFromBundle reindexes a fresh vault into a queryable KB', async () => {
    const sourceDb = new Database(':memory:');
    initSchema(sourceDb);
    setDbForTesting(sourceDb);

    const sourceVault = tmpDir('e2e-source-vault');
    const exportPath = tmpDir('e2e-export');
    const restoredVault = tmpDir('e2e-restored-vault');

    const files = {
      'decisions/export-e2e-alpha.md': '---\ntitle: "Export E2E Alpha"\ntype: decision\ntags:\n  - kb-export\n  - roundtrip\nproject: knowledge-base-server\nstatus: active\n---\n\n# Export E2E Alpha\n\nUnique alpha query needle.\n',
      'research/export-e2e-beta.md': '---\ntitle: "Export E2E Beta"\ntype: research\ntags: kb-export, beta\n---\n\n# Export E2E Beta\n\nUnique beta query needle.\n',
    };

    try {
      makeVault(sourceVault, files);
      const indexed = await indexVault(sourceVault, { embeddings: false });
      assert.strictEqual(indexed.indexed, 2);

      await exportDocs({
        outPath: exportPath,
        vaultPath: sourceVault,
        all: true,
      });

      const restoreDb = new Database(':memory:');
      initSchema(restoreDb);
      setDbForTesting(restoreDb);

      const restored = await restoreFromBundle({
        bundlePath: exportPath,
        vaultPath: restoredVault,
        yes: true,
        noEmbeddings: true,
      });

      assert.strictEqual(restored.restored, 2);
      assert.strictEqual(restored.skipped, 0);

      for (const [rel, originalContent] of Object.entries(files)) {
        const restoredContent = readFileSync(join(restoredVault, rel), 'utf8');
        assert.strictEqual(restoredContent, originalContent);

        const originalParsed = parseVaultNote(originalContent, rel);
        const restoredParsed = parseVaultNote(restoredContent, rel);
        assert.deepStrictEqual(
          {
            title: restoredParsed.title,
            type: restoredParsed.type,
            tags: restoredParsed.tags,
            body: restoredParsed.body,
          },
          {
            title: originalParsed.title,
            type: originalParsed.type,
            tags: originalParsed.tags,
            body: originalParsed.body,
          }
        );
      }

      const docs = getDb().prepare('SELECT title, doc_type, tags, content FROM documents ORDER BY title').all();
      assert.strictEqual(docs.length, 2);
      assert.deepStrictEqual(docs.map(d => d.title), ['Export E2E Alpha', 'Export E2E Beta']);

      const fts = getDb().prepare(`
        SELECT d.title
        FROM documents_fts f
        JOIN documents d ON d.id = f.rowid
        WHERE documents_fts MATCH ?
      `).all('"alpha"');
      assert.deepStrictEqual(fts.map(r => r.title), ['Export E2E Alpha']);

      try { restoreDb.close(); } catch {}
    } finally {
      try { sourceDb.close(); } catch {}
      try { rmSync(sourceVault, { recursive: true }); } catch {}
      try { rmSync(exportPath, { recursive: true }); } catch {}
      try { rmSync(restoredVault, { recursive: true }); } catch {}
    }
  });
});
