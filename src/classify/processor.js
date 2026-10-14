import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readNote, writeNote } from '../utils/frontmatter.js';
import { classifyNote } from './classifier.js';
import { scanVault } from '../vault/indexer.js';
import { indexVault } from '../vault/indexer.js';

const INTAKE_FOLDERS = ['Clippings', 'inbox'];

function isUnprocessed(filePath, vaultPath) {
  const rel = filePath.replace(vaultPath + '/', '');
  const inIntake = INTAKE_FOLDERS.some(f => rel.startsWith(f + '/') || rel.startsWith(f));
  if (!inIntake) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return false; // skip empty files
    const { data: fm } = readNote(content);
    return !fm.classified;
  } catch {
    return false;
  }
}

export async function processNewClippings(vaultPath, { dryRun = false } = {}) {
  const allFiles = scanVault(vaultPath);
  const unprocessed = allFiles.filter(f => isUnprocessed(f, vaultPath));

  if (unprocessed.length === 0) {
    return { processed: 0, results: [], message: 'No new clippings to classify' };
  }

  const results = [];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const filePath of unprocessed) {
    const rel = filePath.replace(vaultPath + '/', '');
    const raw = readFileSync(filePath, 'utf-8');
    const { data: fm, content: body } = readNote(raw);
    const title = fm.title || rel.split('/').pop().replace(/\.md$/, '');

    console.log(`Classifying: ${rel}`);
    const classification = await classifyNote(title, body, rel);

    if (!classification.success) {
      console.log(`  Failed: ${classification.error}`);
      results.push({ path: rel, status: 'error', error: classification.error });
      continue;
    }

    console.log(`  → type=${classification.type}, tags=[${classification.tags?.join(', ')}]`);

    if (dryRun) {
      results.push({ path: rel, status: 'dry-run', classification });
      continue;
    }

    // Update frontmatter in place
    const updatedFm = {
      ...fm,
      title: fm.title || title,
      type: classification.type,
      tags: classification.tags || fm.tags || [],
      project: classification.project || fm.project || null,
      summary: classification.summary || null,
      confidence: classification.confidence || null,
      key_topics: classification.key_topics || [],
      classified: true,
      classified_at: new Date().toISOString().split('T')[0],
      classified_by: 'claude',
    };

    // Remove null values from frontmatter
    for (const [key, val] of Object.entries(updatedFm)) {
      if (val === null) delete updatedFm[key];
    }

    const updated = writeNote(body, updatedFm);
    writeFileSync(filePath, updated);

    results.push({ path: rel, status: 'classified', classification });

    // Brief pause between CLI calls to avoid rate limiting
    await delay(2000);
  }

  // Re-index vault to pick up changes
  if (!dryRun && results.some(r => r.status === 'classified')) {
    console.log('Re-indexing vault...');
    await indexVault(vaultPath);
  }

  return {
    processed: results.filter(r => r.status === 'classified').length,
    errors: results.filter(r => r.status === 'error').length,
    total: unprocessed.length,
    results,
  };
}
