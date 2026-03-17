import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { DB_PATH } from './paths.js';

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 100');  // Checkpoint every 100 pages (~400KB) to prevent WAL bloat
    initSchema(db);

    // Periodic WAL checkpoint every 5 minutes to keep WAL file small
    setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        console.error('[KB] WAL checkpoint failed:', e.message);
      }
    }, 5 * 60 * 1000).unref();
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      doc_type TEXT NOT NULL,
      tags TEXT DEFAULT '',
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content, tags,
      content='documents',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    -- Vault file tracking for incremental indexing
    CREATE TABLE IF NOT EXISTS vault_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      title TEXT,
      note_type TEXT,
      tags TEXT DEFAULT '',
      project TEXT,
      status TEXT DEFAULT 'active',
      source TEXT,
      confidence TEXT,
      summary TEXT,
      key_topics TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vault_files_hash ON vault_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_vault_files_type ON vault_files(note_type);
    CREATE INDEX IF NOT EXISTS idx_vault_files_project ON vault_files(project);
  `);

  // Migration: add summary and key_topics columns if missing
  const cols = db.prepare("PRAGMA table_info(vault_files)").all().map(c => c.name);
  if (!cols.includes('summary')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN summary TEXT').run();
  }
  if (!cols.includes('key_topics')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN key_topics TEXT').run();
  }

  db.exec(`

    -- Embeddings for semantic search (stored as Float32Array binary blobs)
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      vault_path TEXT,
      chunk_index INTEGER DEFAULT 0,
      chunk_text TEXT,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_vault ON embeddings(vault_path);
  `);
}

export { initSchema, getDb };

export function insertDocument({ title, content, source, doc_type, tags, file_path, file_size }) {
  const stmt = getDb().prepare(`
    INSERT INTO documents (title, content, source, doc_type, tags, file_path, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(title, content, source || null, doc_type, tags || '', file_path || null, file_size || 0);
  return {
    id: result.lastInsertRowid,
    title,
    content,
    source: source || null,
    doc_type,
    tags: tags || '',
    file_path: file_path || null,
    file_size: file_size || 0,
  };
}

export function updateDocument(id, { title, tags }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, tags, id);
}

export function deleteDocument(id) {
  const doc = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(id);
  getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
  return doc ? doc.file_path : null;
}

// Common English stop words to filter from search queries
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'about', 'up',
]);

export function searchDocuments(query, limit = 20) {
  // Strip punctuation, split into terms, remove stop words
  const terms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && t.length > 1);

  if (terms.length === 0) {
    // All terms were stop words — fall back to original terms
    const fallback = query.replace(/['"]/g, '').split(/\s+/).filter(Boolean);
    if (fallback.length === 0) return [];
    const sanitized = fallback.map(term => `"${term}"`).join(' OR ');
    const stmt = getDb().prepare(`
      SELECT d.id, d.title,
        snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
        d.doc_type, d.tags, d.file_size, d.created_at,
        bm25(documents_fts, 10.0, 1.0, 5.0) as rank
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(sanitized, limit);
  }

  // Build FTS5 query: AND-first for precision, OR fallback for recall
  // Title-boosted ranking via bm25() weights: title=10x, content=1x, tags=5x
  const andQuery = terms.map(term => `"${term}" *`).join(' AND ');
  const orQuery = terms.map(term => `"${term}" *`).join(' OR ');

  const stmt = getDb().prepare(`
    SELECT d.id, d.title,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
      d.doc_type, d.tags, d.file_size, d.created_at,
      bm25(documents_fts, 10.0, 1.0, 5.0) as rank
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  // Try AND first for precision; fall back to OR if no results
  let results = stmt.all(andQuery, limit);
  if (results.length === 0 && terms.length > 1) {
    results = stmt.all(orQuery, limit);
  }

  // If OR gives too many low-quality results, re-rank: boost docs matching more terms
  if (terms.length > 1 && results.length > 0) {
    for (const r of results) {
      const titleLower = (r.title || '').toLowerCase();
      const tagsLower = (r.tags || '').toLowerCase();
      let termBoost = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) termBoost += 20;  // title match is very strong
        if (tagsLower.includes(term)) termBoost += 10;   // tag match is strong
      }
      // rank is negative (lower = better in bm25), so subtract boost to improve ranking
      r.rank = r.rank - termBoost;
    }
    results.sort((a, b) => a.rank - b.rank);
  }

  return results;
}

export function listDocuments({ type, tag, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT id, title, doc_type, tags, file_size, source, created_at, updated_at FROM documents';
  const conditions = [];
  const params = [];

  if (type) {
    conditions.push('doc_type = ?');
    params.push(type);
  }
  if (tag) {
    conditions.push("tags LIKE '%' || ? || '%'");
    params.push(tag);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(sql).all(...params);
}

export function getDocument(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}

export function getStats() {
  const count = getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
  const totalSize = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM documents').get().total;
  let dbFileSize = 0;
  try {
    dbFileSize = statSync(DB_PATH).size;
  } catch {
    // DB file may not exist yet
  }
  return { count, totalSize, dbFileSize };
}

export function getDocumentCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
}

export function updateDocumentFull(id, { title, content, tags, doc_type, source, file_path, file_size }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, content = ?, tags = ?, doc_type = ?, source = ?, file_path = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, content, tags, doc_type, source, file_path, file_size, id);
}

export function getVaultFile(vaultPath) {
  return getDb().prepare('SELECT * FROM vault_files WHERE vault_path = ?').get(vaultPath);
}

export function upsertVaultFile({ vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics }) {
  const stmt = getDb().prepare(`
    INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vault_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      document_id = excluded.document_id,
      title = excluded.title,
      note_type = excluded.note_type,
      tags = excluded.tags,
      project = excluded.project,
      status = excluded.status,
      source = excluded.source,
      confidence = excluded.confidence,
      summary = excluded.summary,
      key_topics = excluded.key_topics,
      indexed_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(vault_path, content_hash, document_id, title, note_type, tags || '', project, status, source, confidence, summary || null, key_topics ? JSON.stringify(key_topics) : null);
}

export function deleteVaultFile(vaultPath) {
  const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(vaultPath);
  if (vf && vf.document_id) {
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(vf.document_id);
  }
  getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(vaultPath);
}

export function getAllVaultPaths() {
  return getDb().prepare('SELECT vault_path, content_hash FROM vault_files').all();
}
