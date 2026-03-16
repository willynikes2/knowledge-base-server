import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { createHash } from 'crypto';
import { parseVaultNote } from './parser.js';
import {
  insertDocument, updateDocumentFull,
  getVaultFile, upsertVaultFile, deleteVaultFile, getAllVaultPaths,
} from '../db.js';

const IGNORE_DIRS = new Set(['.obsidian', '.trash', '.git', '_assets', '_system', 'node_modules', 'textgenerator']);
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export function scanVault(vaultPath) {
  const results = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (IGNORE_FILES.has(entry.name)) continue;
        if (entry.name.startsWith('.sync-conflict')) continue;
        if (extname(entry.name).toLowerCase() === '.md') {
          results.push(fullPath);
        }
      }
    }
  }

  walk(vaultPath);
  return results;
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function indexVault(vaultPath) {
  const files = scanVault(vaultPath);
  const existingPaths = new Map(getAllVaultPaths().map(r => [r.vault_path, r.content_hash]));
  const seenPaths = new Set();

  let indexed = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = [];

  for (const filePath of files) {
    const relPath = relative(vaultPath, filePath);
    seenPaths.add(relPath);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const hash = hashContent(content);

      // Skip if unchanged
      if (existingPaths.get(relPath) === hash) {
        skipped++;
        continue;
      }

      const parsed = parseVaultNote(content, relPath);

      // Check if we already have a document for this vault file
      const existing = getVaultFile(relPath);
      let docId;

      if (existing && existing.document_id) {
        // Update existing document with full content
        updateDocumentFull(existing.document_id, {
          title: parsed.title,
          content: parsed.body,
          tags: parsed.tags.join(', '),
          doc_type: parsed.type,
          source: `vault:${relPath}`,
          file_path: filePath,
          file_size: statSync(filePath).size,
        });
        docId = existing.document_id;
      } else {
        // Insert new document
        const doc = insertDocument({
          title: parsed.title,
          content: parsed.body,
          source: `vault:${relPath}`,
          doc_type: parsed.type,
          tags: parsed.tags.join(', '),
          file_path: filePath,
          file_size: statSync(filePath).size,
        });
        docId = doc.id;
      }

      // Update vault_files tracking
      upsertVaultFile({
        vault_path: relPath,
        content_hash: hash,
        document_id: docId,
        title: parsed.title,
        note_type: parsed.type,
        tags: parsed.tags.join(', '),
        project: parsed.project,
        status: parsed.status,
        source: parsed.source,
        confidence: parsed.confidence,
      });

      indexed++;
    } catch (err) {
      errors.push(`${relPath}: ${err.message}`);
    }
  }

  // Delete tracking entries for files that no longer exist in vault
  for (const [path] of existingPaths) {
    if (!seenPaths.has(path)) {
      deleteVaultFile(path);
      deleted++;
    }
  }

  return { indexed, skipped, deleted, errors, total: files.length };
}
