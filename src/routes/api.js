import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { authMiddleware } from '../auth.js';
import {
  listDocuments,
  searchDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  getStats,
} from '../db.js';
import { ingestFile, ingestDirectory } from '../ingest.js';
import { indexVault } from '../vault/indexer.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// All API routes require auth
router.use('/api/documents', authMiddleware);
router.use('/api/ingest-directory', authMiddleware);
router.use('/api/stats', authMiddleware);

// GET /api/documents — list or search
router.get('/api/documents', (req, res) => {
  try {
    const { q, type, tag, limit, offset } = req.query;
    if (q) {
      const results = searchDocuments(q, limit ? parseInt(limit, 10) : 20);
      return res.json(results);
    }
    const results = listDocuments({
      type: type || undefined,
      tag: tag || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get('/api/documents/:id', (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — file upload
router.post('/api/documents', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const documents = [];
    const tags = req.body.tags || '';

    for (const file of req.files) {
      const tempName = `kb-upload-${randomBytes(8).toString('hex')}-${file.originalname}`;
      const tempPath = join(tmpdir(), tempName);

      try {
        writeFileSync(tempPath, file.buffer);
        const doc = await ingestFile(tempPath);
        if (doc) {
          // Fix title and source to use original filename
          const origName = file.originalname;
          const title = origName.replace(/\.[^.]+$/, '');
          updateDocument(doc.id, { title, tags: tags || doc.tags });
          doc.title = title;
          doc.source = origName;
          if (tags) doc.tags = tags;
          documents.push(doc);
        }
      } finally {
        try { unlinkSync(tempPath); } catch {}
      }
    }

    return res.json({ documents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id
router.put('/api/documents/:id', (req, res) => {
  try {
    const { title, tags } = req.body || {};
    updateDocument(parseInt(req.params.id, 10), { title, tags });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/:id
router.delete('/api/documents/:id', (req, res) => {
  try {
    const filePath = deleteDocument(parseInt(req.params.id, 10));
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest-directory
router.post('/api/ingest-directory', async (req, res) => {
  try {
    const { path: dirPath } = req.body || {};
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!existsSync(dirPath)) {
      return res.status(400).json({ error: `Path not found: ${dirPath}` });
    }
    const result = await ingestDirectory(dirPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
router.get('/api/stats', (req, res) => {
  try {
    return res.json(getStats());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/vault/reindex — triggered by post-sync hook or manually
router.post('/api/vault/reindex', authMiddleware, async (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) {
      return res.status(400).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    }
    const result = indexVault(vaultPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/vault/status — check vault index state
router.get('/api/vault/status', authMiddleware, (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    return res.json({
      configured: !!vaultPath,
      vault_path: vaultPath || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
