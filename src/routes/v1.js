// src/routes/v1.js
import { Router } from 'express';
import { homedir } from 'os';
import { join } from 'path';

import {
  searchDocuments,
  listDocuments,
  getDocument,
  getStats,
  getDb,
} from '../db.js';
import { ingestText } from '../ingest.js';

const router = Router();

// Default vault path for capture functions
const DEFAULT_VAULT_PATH = join(homedir(), 'knowledgebase');

// ─── Read Endpoints ──────────────────────────────────────────────────────────

// GET /health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /stats
router.get('/stats', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      total_documents: stats.count,
      total_size_bytes: stats.totalSize,
      db_size_bytes: stats.dbFileSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /search — FTS5 search
router.get('/search', (req, res) => {
  const { q, type, project } = req.query;
  let limit = parseInt(req.query.limit, 10) || 20;
  if (limit > 100) limit = 100;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    let results = searchDocuments(q, limit);

    if (type) {
      results = results.filter(r => r.doc_type === type);
    }
    if (project) {
      // Filter via vault_files join — do a lightweight DB query
      const projectDocIds = new Set(
        getDb()
          .prepare('SELECT document_id FROM vault_files WHERE project = ?')
          .all(project)
          .map(r => r.document_id)
      );
      results = results.filter(r => projectDocIds.has(r.id));
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /search/smart — hybrid (FTS5 + semantic) search
router.get('/search/smart', async (req, res) => {
  const { q, project, type } = req.query;
  let limit = parseInt(req.query.limit, 10) || 10;
  if (limit > 50) limit = 50;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    const { hybridSearch } = await import('../embeddings/search.js');
    const results = await hybridSearch(q, { limit, project, type });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /context — token-efficient briefing from vault summaries
router.get('/context', async (req, res) => {
  const { q, type, project } = req.query;
  let limit = parseInt(req.query.limit, 10) || 15;
  if (limit > 50) limit = 50;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    const ftsResults = searchDocuments(q, limit);

    // Filter by type/project if requested
    let filtered = ftsResults;
    if (type) {
      filtered = filtered.filter(r => r.doc_type === type);
    }
    if (project) {
      const projectDocIds = new Set(
        getDb()
          .prepare('SELECT document_id FROM vault_files WHERE project = ?')
          .all(project)
          .map(r => r.document_id)
      );
      filtered = filtered.filter(r => projectDocIds.has(r.id));
    }

    // Pull summaries from vault_files table for matched documents
    const db = getDb();
    const sources = [];
    const briefingParts = [];

    for (const doc of filtered) {
      const vf = db
        .prepare('SELECT summary, key_topics FROM vault_files WHERE document_id = ?')
        .get(doc.id);

      sources.push({ id: doc.id, title: doc.title });

      if (vf && vf.summary) {
        const topics = vf.key_topics ? ` [${vf.key_topics}]` : '';
        briefingParts.push(`### ${doc.title}${topics}\n${vf.summary}`);
      } else if (doc.snippet) {
        briefingParts.push(`### ${doc.title}\n${doc.snippet}`);
      }
    }

    const briefing =
      briefingParts.length > 0
        ? briefingParts.join('\n\n')
        : `No context found for query: "${q}"`;

    res.json({ briefing, sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /documents — list documents
router.get('/documents', (req, res) => {
  const { type, tag } = req.query;
  let limit = parseInt(req.query.limit, 10) || 50;
  let offset = parseInt(req.query.offset, 10) || 0;
  if (limit > 200) limit = 200;

  try {
    const documents = listDocuments({
      type: type || undefined,
      tag: tag || undefined,
      limit,
      offset,
    });
    res.json({ documents, total: documents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /documents/:id — read full document
router.get('/documents/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid document id' });
  }

  try {
    const doc = getDocument(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Write Endpoints ─────────────────────────────────────────────────────────

// POST /ingest — ingest text document
router.post('/ingest', (req, res) => {
  const { title, content, tags } = req.body || {};

  if (!title || !content) {
    return res.status(400).json({ error: 'Missing required fields: title, content' });
  }

  try {
    const doc = ingestText(title, content, tags);
    // Fetch from DB to get the created_at timestamp set by SQLite default
    const stored = getDocument(doc.id);
    res.status(201).json({
      id: doc.id,
      title: doc.title,
      created_at: stored?.created_at || new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/session — record a terminal session
router.post('/capture/session', async (req, res) => {
  const { goal, commands_worked, commands_failed, root_causes, fixes, lessons, project, machine } =
    req.body || {};

  if (!goal) {
    return res.status(400).json({ error: 'Missing required field: goal' });
  }

  try {
    const { captureSession } = await import('../capture/terminal.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureSession(
      { goal, commands_worked, commands_failed, root_causes, fixes, lessons, project, machine },
      vaultPath
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/fix — record a fix/solution
router.post('/capture/fix', async (req, res) => {
  const { title, symptom, cause, resolution, commands, project, stack } = req.body || {};

  if (!title) {
    return res.status(400).json({ error: 'Missing required field: title' });
  }

  try {
    const { captureFix } = await import('../capture/terminal.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureFix(
      { title, symptom, cause, resolution, commands, project, stack },
      vaultPath
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/web — capture a web article
router.post('/capture/web', async (req, res) => {
  const { title, url, content, tags, project } = req.body || {};

  if (!title || !url || !content) {
    return res.status(400).json({ error: 'Missing required fields: title, url, content' });
  }

  try {
    const { captureWeb } = await import('../capture/web.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureWeb({ title, url, content, tags, project }, vaultPath);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
