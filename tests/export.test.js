// tests/export.test.js — unit tests for export helpers
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  normalizeTag,
  normalizeTags,
  tagsMatchAll,
  tagsMatchAny,
} from '../src/export/tags.js';

import {
  sha256String,
  sha256File,
  buildManifest,
  generateReadme,
  MANIFEST_VERSION,
} from '../src/export/manifest.js';

// ─── Tag normalization tests ──────────────────────────────────────────────────

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    assert.strictEqual(normalizeTag('  CutDaCord  '), 'cutdacord');
    assert.strictEqual(normalizeTag('HETZNER'), 'hetzner');
    assert.strictEqual(normalizeTag('already-normalized'), 'already-normalized');
  });

  it('handles non-string input gracefully', () => {
    assert.strictEqual(normalizeTag(42), '42');
  });
});

describe('normalizeTags', () => {
  it('handles array input', () => {
    assert.deepStrictEqual(normalizeTags(['CutDaCord', 'Jellyfin']), ['cutdacord', 'jellyfin']);
  });

  it('handles comma-separated string', () => {
    assert.deepStrictEqual(normalizeTags('ai, agents, workflow'), ['ai', 'agents', 'workflow']);
  });

  it('handles whitespace-separated string', () => {
    assert.deepStrictEqual(normalizeTags('ai agents'), ['ai', 'agents']);
  });

  it('handles null/undefined', () => {
    assert.deepStrictEqual(normalizeTags(null), []);
    assert.deepStrictEqual(normalizeTags(undefined), []);
    assert.deepStrictEqual(normalizeTags(''), []);
  });

  it('filters empty tokens', () => {
    assert.deepStrictEqual(normalizeTags(',,, a , , b ,'), ['a', 'b']);
  });
});

describe('tagsMatchAll', () => {
  it('returns true when all query tags present', () => {
    assert.ok(tagsMatchAll(['a', 'b', 'c'], ['a', 'c']));
  });

  it('returns false when any query tag missing', () => {
    assert.ok(!tagsMatchAll(['a', 'b'], ['a', 'z']));
  });

  it('empty query matches everything', () => {
    assert.ok(tagsMatchAll(['a'], []));
  });
});

describe('tagsMatchAny', () => {
  it('returns true when any query tag present', () => {
    assert.ok(tagsMatchAny(['a', 'b'], ['z', 'a']));
  });

  it('returns false when no query tag present', () => {
    assert.ok(!tagsMatchAny(['a', 'b'], ['x', 'y']));
  });

  it('empty query always returns false', () => {
    assert.ok(!tagsMatchAny(['a', 'b'], []));
  });
});

// ─── Manifest tests ───────────────────────────────────────────────────────────

describe('sha256String', () => {
  it('returns hex string of correct length', () => {
    const hash = sha256String('hello world');
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64);
  });

  it('deterministic for same input', () => {
    assert.strictEqual(sha256String('test'), sha256String('test'));
  });

  it('differs for different input', () => {
    assert.notStrictEqual(sha256String('a'), sha256String('b'));
  });
});

describe('sha256File', () => {
  let tmpFile;

  before(() => {
    tmpFile = join(tmpdir(), `kb-test-${randomBytes(4).toString('hex')}.txt`);
    writeFileSync(tmpFile, 'test content for sha256');
  });

  after(() => {
    try { rmSync(tmpFile); } catch {}
  });

  it('returns hex string of correct length', () => {
    const hash = sha256File(tmpFile);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64);
  });

  it('matches sha256String for text file', () => {
    const content = readFileSync(tmpFile, 'utf8');
    assert.strictEqual(sha256File(tmpFile), sha256String(content));
  });
});

describe('buildManifest', () => {
  it('returns correct v1 structure', () => {
    const files = [
      {
        vault_path: 'decisions/test.md',
        sha256: 'abc123',
        size: 100,
        title: 'Test',
        doc_type: 'decision',
        tags: ['test'],
        original_db_id: 1,
        restore_destination: 'decisions/test.md',
      },
    ];
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files,
      counts: { docs: 1, attachments: 0 },
    });

    assert.strictEqual(m.manifest_version, MANIFEST_VERSION);
    assert.strictEqual(m.kb_server_version, '1.0.0');
    assert.ok(m.exported_at);
    assert.deepStrictEqual(m.filter_spec, { all: true });
    assert.deepStrictEqual(m.filter_expanded, {});
    assert.strictEqual(m.counts.docs, 1);
    assert.strictEqual(m.files.length, 1);
    assert.strictEqual(m.files[0].vault_path, 'decisions/test.md');
  });

  it('defaults counts from files if not provided', () => {
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [{ vault_path: 'x.md' }],
    });
    assert.strictEqual(m.counts.docs, 1);
  });
});

describe('generateReadme', () => {
  it('contains kb restore command', () => {
    const m = buildManifest({
      kbServerVersion: '1.0.0',
      filterSpec: { all: true },
      filterExpanded: {},
      files: [],
      counts: { docs: 0, attachments: 0 },
    });
    const readme = generateReadme(m, 'test-bundle');
    assert.ok(readme.includes('kb restore'));
    assert.ok(readme.includes('--dry-run'));
    assert.ok(readme.includes('--overwrite'));
  });
});
