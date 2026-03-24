/**
 * KB-to-Vault Sync
 *
 * Exports all KB documents that don't have corresponding vault files
 * into the Obsidian vault as properly frontmattered markdown files.
 */

import { getDb, getAllVaultPaths } from '../db.js';
import { indexVault } from '../vault/indexer.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { formatYamlTags } from '../utils/frontmatter.js';
import { join, dirname } from 'path';

import { homedir } from 'os';

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), 'obsidian-vault');

// ── Folder routing ──────────────────────────────────────────────────

function isYouTubeDoc(doc) {
  // Numbered prefix like "01-sonarr..." or "34-..." from transcript pulls
  if (doc.source && /^\d+-/.test(doc.source)) return true;
  if (doc.source && /youtube/i.test(doc.source)) return true;
  if (doc.tags && /youtube|transcript/i.test(doc.tags)) return true;
  return false;
}

function routeToFolder(doc) {
  const title = (doc.title || '').toLowerCase();
  const source = (doc.source || '').toLowerCase();
  const tags = (doc.tags || '').toLowerCase();

  // YouTube transcripts
  if (doc.doc_type === 'text' && isYouTubeDoc(doc)) {
    return 'sources/youtube';
  }

  // Research / consolidated docs
  if (title.startsWith('consolidated') || title.includes('cross-refer')) {
    return 'research';
  }

  // TRaSH / Recyclarr guides
  if (title.includes('trash guide') || title.includes('recyclarr')) {
    return 'research';
  }

  // Business / strategy docs
  if (title.includes('business planning') || title.includes('strategy') ||
      title.includes('economics') || title.includes('multi-tenant')) {
    return 'research';
  }

  // Design specs / implementation plans
  if (title.includes('design spec') || title.includes('implementation plan')) {
    return 'research';
  }

  // Session / debugging docs
  if (title.includes('debugging session') || title.includes('session')) {
    return 'builds/sessions';
  }

  // Fix docs
  if (title.includes('fix') && tags.includes('fix')) {
    return 'builds/fixes';
  }

  // Jellyfin docs
  if (title.startsWith('jellyfin -') || title.startsWith('jellyfin -')) {
    return 'research';
  }

  // Bookmarks
  if (title.startsWith('bookmarks-') || title.includes('x_bookmarks')) {
    return 'sources/x-bookmarks';
  }

  // Code files
  if (doc.doc_type === 'code') {
    return 'sources/captures';
  }

  // Memory / operational docs
  if (title === 'memory' || source === 'memory.md') {
    return 'sources/captures';
  }

  // Everything else: captures
  return 'sources/captures';
}

function noteTypeFromFolder(folder) {
  const map = {
    'sources/youtube': 'source',
    'sources/captures': 'source',
    'sources/x-bookmarks': 'source',
    'research': 'research',
    'builds/sessions': 'session',
    'builds/fixes': 'fix',
    'inbox': 'inbox',
  };
  return map[folder] || 'note';
}

// ── Slug / filename helpers ─────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function datePrefix(dateStr) {
  if (!dateStr) return '2026-03-07';
  // Handle "2026-03-07 14:27:14" → "2026-03-07"
  return dateStr.slice(0, 10);
}

// ── Frontmatter builder ─────────────────────────────────────────────

function buildFrontmatter(doc, noteType) {
  const lines = ['---'];
  lines.push(`title: "${doc.title.replace(/"/g, '\\"')}"`);
  lines.push(`type: ${noteType}`);

  const tagList = (doc.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (tagList.length > 0) {
    lines.push(formatYamlTags(tagList));
  } else {
    // Infer basic tags from doc characteristics
    const inferred = [];
    if (isYouTubeDoc(doc)) inferred.push('youtube', 'transcript');
    else if (doc.doc_type === 'markdown') inferred.push('reference');
    else if (doc.doc_type === 'code') inferred.push('code');
    else if (doc.doc_type === 'text') inferred.push('reference');
    if (inferred.length > 0) {
      lines.push(formatYamlTags(inferred));
    }
  }

  lines.push(`created: ${datePrefix(doc.created_at)}`);

  if (doc.source) {
    lines.push(`source: "${doc.source.replace(/"/g, '\\"')}"`);
  }

  lines.push(`kb_id: ${doc.id}`);
  lines.push('---');
  return lines.join('\n');
}

// ── Main sync ───────────────────────────────────────────────────────

function getOrphanedDocs() {
  const db = getDb();
  return db.prepare(`
    SELECT d.*
    FROM documents d
    WHERE d.id NOT IN (
      SELECT document_id FROM vault_files WHERE document_id IS NOT NULL
    )
    ORDER BY d.created_at
  `).all();
}

function sync() {
  const docs = getOrphanedDocs();
  console.log(`Found ${docs.length} KB documents without vault files.\n`);

  if (docs.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  const created = [];
  const skipped = [];
  const errors = [];

  // Track slugs we've used this run to avoid collisions
  const usedSlugs = new Set();

  for (const doc of docs) {
    try {
      const folder = routeToFolder(doc);
      const noteType = noteTypeFromFolder(folder);
      const date = datePrefix(doc.created_at);
      let slug = slugify(doc.title);

      // Deduplicate slug within this run
      let finalSlug = slug;
      let counter = 2;
      while (usedSlugs.has(`${folder}/${finalSlug}`)) {
        finalSlug = `${slug}-${counter}`;
        counter++;
      }
      usedSlugs.add(`${folder}/${finalSlug}`);

      const filename = `${date}-${finalSlug}.md`;
      const relPath = `${folder}/${filename}`;
      const absPath = join(VAULT_PATH, relPath);

      // Skip if file already exists on disk
      if (existsSync(absPath)) {
        skipped.push({ id: doc.id, title: doc.title, reason: 'file exists' });
        continue;
      }

      // Ensure directory exists
      mkdirSync(dirname(absPath), { recursive: true });

      // Build file content
      const frontmatter = buildFrontmatter(doc, noteType);
      const body = doc.content || '';
      const fileContent = `${frontmatter}\n\n${body}\n`;

      writeFileSync(absPath, fileContent, 'utf-8');
      created.push({ id: doc.id, title: doc.title, path: relPath, folder });
    } catch (err) {
      errors.push({ id: doc.id, title: doc.title, error: err.message });
    }
  }

  // Summary
  console.log(`Created: ${created.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Errors:  ${errors.length}\n`);

  // Breakdown by folder
  const byFolder = {};
  for (const c of created) {
    byFolder[c.folder] = (byFolder[c.folder] || 0) + 1;
  }
  console.log('By folder:');
  for (const [folder, count] of Object.entries(byFolder).sort()) {
    console.log(`  ${folder}: ${count}`);
  }

  if (skipped.length > 0) {
    console.log('\nSkipped:');
    for (const s of skipped) {
      console.log(`  [${s.id}] ${s.title} (${s.reason})`);
    }
  }

  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const e of errors) {
      console.log(`  [${e.id}] ${e.title}: ${e.error}`);
    }
  }

  return created.length;
}

// ── Run ─────────────────────────────────────────────────────────────

console.log('=== KB → Vault Sync ===\n');

const count = sync();

if (count > 0) {
  console.log('\nRe-indexing vault...');
  indexVault(VAULT_PATH).then(result => {
    console.log(`\nVault re-index complete:`);
    console.log(`  Indexed: ${result.indexed}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Deleted: ${result.deleted}`);
    console.log(`  Total:   ${result.total}`);
    if (result.errors.length > 0) {
      console.log(`  Errors:  ${result.errors.length}`);
      result.errors.slice(0, 5).forEach(e => console.log(`    ${e}`));
    }
    console.log('\nDone.');
  });
} else {
  console.log('\nDone.');
}
