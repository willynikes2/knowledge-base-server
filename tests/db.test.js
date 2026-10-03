import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';

describe('vault_files schema', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    initSchema(db);
  });

  after(() => db.close());

  it('should create vault_files table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_files'"
    ).all();
    assert.strictEqual(tables.length, 1);
  });

  it('should track file path, hash, and frontmatter fields', () => {
    db.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, title, note_type, tags, project, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('05_research/test.md', 'abc123', 'Test Note', 'research', 'ai,agents', 'kb-system', 'active');

    const row = db.prepare('SELECT * FROM vault_files WHERE vault_path = ?').get('05_research/test.md');
    assert.strictEqual(row.title, 'Test Note');
    assert.strictEqual(row.note_type, 'research');
    assert.strictEqual(row.project, 'kb-system');
  });

  it('migrates older documents tables missing source', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          tags TEXT DEFAULT '',
          file_path TEXT,
          file_size INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      initSchema(legacyDb);
      const cols = legacyDb.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
      assert.ok(cols.includes('source'));
    } finally {
      legacyDb.close();
    }
  });
});
