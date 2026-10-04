// src/routes/v1.js
import { Router } from 'express';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdir as mkdirAsync, readdir, rename, stat, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import multer from 'multer';

import {
  searchDocuments,
  listDocuments,
  getDocument,
  getStats,
  getDb,
} from '../db.js';
import { ingestText } from '../ingest.js';
import { extractFromImage } from '../vision.js';
import { resolveUnder } from '../safe-path.js';

const upload = multer({
  dest: join(tmpdir(), 'kb-uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
    cb(null, allowed.test(file.mimetype));
  },
});

const router = Router();

// Default vault path for capture functions
const DEFAULT_VAULT_PATH = join(homedir(), 'knowledgebase');
const REMOTE_EXPORT_ROOT = resolve(process.env.KB_EXPORT_ROOT || join(homedir(), '.knowledge-base', 'exports'));
const UPLOAD_DIR = join(tmpdir(), 'kb-uploads');
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const UPLOAD_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};
const UPLOAD_FILENAME_RE = /^[a-f0-9]{16}\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i;

function pathUnder(root, inputPath) {
  return resolveUnder(root, inputPath, `Path must stay under ${resolve(root)}`);
}

function truthy(value) {
  return value === true || value === 'true' || value === '1';
}

async function cleanupExpiredUploads() {
  try {
    await mkdirAsync(UPLOAD_DIR, { recursive: true });
    const entries = await readdir(UPLOAD_DIR);
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    await Promise.all(entries.map(async entry => {
      if (!UPLOAD_FILENAME_RE.test(entry)) return;
      const filePath = pathUnder(UPLOAD_DIR, entry);
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) {
        await unlink(filePath).catch(() => {});
      }
    }));
  } catch {
    // Non-fatal best-effort cleanup.
  }
}

cleanupExpiredUploads();
setInterval(() => {
  cleanupExpiredUploads();
}, 60 * 60 * 1000).unref();

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
  const { title, content, tags, doc_type, source } = req.body || {};

  if (!title || !content) {
    return res.status(400).json({ error: 'Missing required fields: title, content' });
  }

  try {
    const doc = ingestText(title, content, { tags, doc_type, source });
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

// POST /ingest/image — ingest an image via upload
router.post('/ingest/image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing image file. Send as multipart form field "image".' });
  }

  const title = req.body.title || req.file.originalname || 'Untitled image';
  const note = req.body.note || '';
  const tags = req.body.tags || '';
  const doc_type = req.body.doc_type || 'image';

  try {
    const result = await extractFromImage(req.file.path, { note });
    const doc = ingestText(title, result.text, {
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : ['image'],
      doc_type,
      source: `image-upload:${req.file.originalname}`,
    });
    const stored = getDocument(doc.id);

    res.status(201).json({
      id: doc.id,
      title: doc.title,
      extraction_method: result.method,
      extracted_chars: result.text.length,
      created_at: stored?.created_at || new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up temp file
    unlink(req.file.path).catch(() => {});
  }
});

// POST /upload — upload an image temporarily; returns a URL for use with kb_ingest_image
router.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing image file. Send as multipart form field "image".' });
  }

  // Move to a served directory with a unique name
  const ext = UPLOAD_EXT_BY_MIME[req.file.mimetype] || 'png';
  const id = randomBytes(8).toString('hex');
  const filename = `${id}.${ext}`;
  const servePath = pathUnder(UPLOAD_DIR, filename);
  try {
    await mkdirAsync(UPLOAD_DIR, { recursive: true });
    await rename(req.file.path, servePath);

    const baseUrl = process.env.BETTER_AUTH_URL || `http://localhost:${process.env.KB_PORT || 3838}`;
    const url = `${baseUrl}/api/v1/uploads/${filename}`;

    // Auto-delete after 10 minutes
    setTimeout(() => unlink(servePath).catch(() => {}), 10 * 60 * 1000).unref();

    res.status(201).json({ url, expires_in: '10 minutes' });
  } catch (err) {
    unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /uploads/:filename — serve temporary uploads
router.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!UPLOAD_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'Invalid upload filename' });
  }
  const filePath = pathUnder(UPLOAD_DIR, filename);
  // Uploads are untrusted (SVG can carry script): never render them inline on this origin.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).json({ error: 'File not found or expired' });
  });
});

// ─── Export / Restore (Ship 2) ────────────────────────────────────────────────

// POST /export — export vault docs to a bundle
// Body: { output_path, filter?, dry_run?, archive?, no_attachments? }
// output_path is resolved under KB_EXPORT_ROOT (default: ~/.knowledge-base/exports).
router.post('/export', async (req, res) => {
  const { output_path, filter, dry_run = false, archive = false, no_attachments = false } = req.body || {};

  if (!output_path) {
    return res.status(400).json({ error: 'Missing required field: output_path' });
  }

  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    return res.status(500).json({ error: 'OBSIDIAN_VAULT_PATH not configured on server' });
  }

  try {
    const outPath = pathUnder(REMOTE_EXPORT_ROOT, output_path);
    const { exportDocs } = await import('../export.js');
    const result = await exportDocs({
      outPath,
      dryRun: truthy(dry_run),
      all: !filter,
      filter: filter || null,
      vaultPath,
      archive: truthy(archive),
      noAttachments: truthy(no_attachments),
    });

    res.status(truthy(dry_run) ? 200 : 201).json({
      dry_run: result.dryRun,
      written: result.written,
      out_path: outPath,
      export_root: REMOTE_EXPORT_ROOT,
      counts: result.manifest.counts,
      exported_at: result.manifest.exported_at,
      manifest_version: result.manifest.manifest_version,
      filter_expanded: result.manifest.filter_expanded,
      file_count: result.manifest.files.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /restore — restore a bundle into the vault
// Body: { bundle_path, dry_run?, overwrite?, strict?, no_embeddings?, yes? }
// bundle_path is resolved under KB_EXPORT_ROOT. Non-dry-run restore also requires
// yes=true and KB_ENABLE_REMOTE_RESTORE=true.
router.post('/restore', async (req, res) => {
  const { bundle_path, yes = false } = req.body || {};
  const dry_run = truthy(req.body?.dry_run);
  const overwrite = truthy(req.body?.overwrite);
  const strict = truthy(req.body?.strict);
  const no_embeddings = truthy(req.body?.no_embeddings);

  if (!bundle_path) {
    return res.status(400).json({ error: 'Missing required field: bundle_path' });
  }

  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    return res.status(500).json({ error: 'OBSIDIAN_VAULT_PATH not configured on server' });
  }

  try {
    const bundlePath = pathUnder(REMOTE_EXPORT_ROOT, bundle_path);
    if (!dry_run && !truthy(yes)) {
      return res.status(400).json({ error: 'Non-dry-run restore requires yes=true' });
    }
    if (!dry_run && process.env.KB_ENABLE_REMOTE_RESTORE !== 'true') {
      return res.status(403).json({ error: 'Remote restore writes are disabled. Set KB_ENABLE_REMOTE_RESTORE=true to enable.' });
    }

    const { restoreFromBundle } = await import('../restore.js');
    const result = await restoreFromBundle({
      bundlePath,
      vaultPath,
      dryRun: dry_run,
      overwrite,
      yes: true,  // HTTP API callers don't have interactive prompts after explicit yes=true
      strict,
      noEmbeddings: no_embeddings,
    });

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
