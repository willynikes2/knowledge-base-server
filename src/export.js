// src/export.js — core export logic (Ship 1 + 1b)

import { mkdirSync, writeFileSync, copyFileSync, readFileSync, statSync, existsSync, createWriteStream } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { getDb } from './db.js';
import { normalizeTags } from './export/tags.js';
import { normalizeFilter, queryByFilter } from './export/filter.js';
import { buildManifest, generateReadme, sha256File, sha256String, readKbVersion } from './export/manifest.js';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * Export documents from the vault to an output directory.
 *
 * @param {object} options
 * @param {string}  options.outPath       - absolute path to output directory (will be created)
 * @param {boolean} [options.dryRun]      - if true, compute manifest but write nothing
 * @param {boolean} [options.all]         - export all docs (default true; overrides filter)
 * @param {object}  [options.filter]      - filter spec (Ship 1b; ignored when all=true)
 * @param {string}  options.vaultPath     - absolute path to Obsidian vault
 * @param {boolean} [options.archive]     - produce a .tar.gz archive (Ship 1b)
 * @param {boolean} [options.noAttachments] - skip attachments (Ship 1b)
 * @returns {Promise<{manifest: object, written: number, dryRun: boolean}>}
 */
export async function exportDocs({ outPath, dryRun = false, all = true, filter, vaultPath, archive = false, noAttachments = false }) {
  if (!vaultPath) throw new Error('vaultPath is required');
  if (!outPath) throw new Error('outPath is required');

  let rows, filterExpanded = {}, filterSpec = { all: true };

  if (all || !filter) {
    // --all: query all vault_files that have a document record
    const db = getDb();
    rows = db.prepare(`
      SELECT
        vf.vault_path,
        vf.content_hash,
        vf.title,
        vf.note_type,
        vf.tags,
        d.id AS doc_id,
        d.doc_type,
        d.tags AS doc_tags,
        d.file_path,
        d.file_size
      FROM vault_files vf
      LEFT JOIN documents d ON d.id = vf.document_id
      WHERE vf.status != 'deleted' OR vf.status IS NULL
      ORDER BY vf.vault_path
    `).all();
    filterSpec = { all: true };
  } else {
    // Filter mode (Ship 1b)
    const normalized = normalizeFilter(filter);
    filterSpec = filter;
    const result = queryByFilter(normalized);
    rows = result.rows;
    filterExpanded = result.filterExpanded;
  }

  const fileEntries = [];
  const notesDir = join(outPath, 'notes');
  const attachmentsDir = join(outPath, 'attachments');

  if (!dryRun) {
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });
  }

  for (const row of rows) {
    const vaultRelPath = row.vault_path;
    if (!vaultRelPath) continue;

    const absPath = join(vaultPath, vaultRelPath);

    if (!existsSync(absPath)) {
      // File tracked in DB but not on disk — skip, log
      process.stderr.write(`[export] warning: tracked file not found on disk: ${vaultRelPath}\n`);
      continue;
    }

    const isMarkdown = vaultRelPath.endsWith('.md');
    const isBinary = !isMarkdown;

    // Skip attachments if --no-attachments
    if (noAttachments && isBinary) continue;

    let sha256, size, destRelPath;

    if (isMarkdown) {
      const content = readFileSync(absPath, 'utf8');
      sha256 = sha256String(content);
      size = Buffer.byteLength(content, 'utf8');
      destRelPath = join('notes', vaultRelPath);
    } else {
      // Binary file (image, attachment)
      sha256 = sha256File(absPath);
      size = statSync(absPath).size;
      destRelPath = join('attachments', vaultRelPath);
    }

    const docType = row.doc_type || row.note_type || 'note';
    const rawTags = row.doc_tags || row.tags || '';
    const normalizedTags = normalizeTags(rawTags);
    const title = row.doc_title || row.title || vaultRelPath;

    fileEntries.push({
      vault_path: vaultRelPath,
      sha256,
      size,
      title,
      doc_type: docType,
      tags: normalizedTags,
      original_db_id: row.doc_id || null,
      restore_destination: vaultRelPath,
    });

    if (!dryRun) {
      const destAbs = join(outPath, destRelPath);
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(absPath, destAbs);
    }
  }

  const kbVersion = readKbVersion(REPO_ROOT);
  const manifest = buildManifest({
    kbServerVersion: kbVersion,
    filterSpec,
    filterExpanded,
    files: fileEntries,
    counts: {
      docs: fileEntries.filter(f => f.doc_type !== 'image').length,
      attachments: fileEntries.filter(f => f.doc_type === 'image').length,
    },
  });

  if (!dryRun) {
    writeFileSync(join(outPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const bundleName = outPath.split('/').pop();
    writeFileSync(join(outPath, 'README.md'), generateReadme(manifest, bundleName), 'utf8');

    // --archive: create .tar.gz alongside the directory
    if (archive) {
      await createArchive(outPath);
    }
  }

  return { manifest, written: dryRun ? 0 : fileEntries.length, dryRun };
}

/**
 * Create a .tar.gz archive of the bundle directory.
 * @param {string} bundleDir
 */
async function createArchive(bundleDir) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const archivePath = bundleDir + '.tar.gz';
  const parentDir = dirname(bundleDir);
  const bundleName = bundleDir.split('/').pop();
  await execFileAsync('tar', ['-czf', archivePath, '-C', parentDir, bundleName]);
  process.stderr.write(`[export] Archive created: ${archivePath}\n`);
}
