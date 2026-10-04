// src/restore.js — restore from bundle (Ship 1: preflight + round-trip)
// Ship 1b will add: live progress, --into-folder, image OCR stub, archive (.tar.gz) input.

import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { createInterface } from 'readline';
import { sha256File, sha256String, MANIFEST_VERSION } from './export/manifest.js';
import { getDb } from './db.js';
import { resolveUnder } from './safe-path.js';

function safeJoin(root, relPath) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('Invalid bundle path: expected a non-empty relative path');
  }
  return resolveUnder(root, relPath, `Unsafe path escapes target directory: ${relPath}`);
}

function bundleFilePath(bundlePath, vaultPath) {
  const isMarkdown = vaultPath.endsWith('.md');
  return safeJoin(bundlePath, join(isMarkdown ? 'notes' : 'attachments', vaultPath));
}

function hashBundleFile(filePath) {
  return filePath.endsWith('.md')
    ? sha256String(readFileSync(filePath, 'utf8'))
    : sha256File(filePath);
}

/**
 * Load and validate a manifest.json from a bundle directory.
 * @param {string} bundlePath - absolute path to bundle directory
 * @returns {{ manifest: object, error: string|null }}
 */
export function loadManifest(bundlePath) {
  const manifestPath = join(bundlePath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { manifest: null, error: `No manifest.json found in: ${bundlePath}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { manifest: null, error: `Failed to parse manifest.json: ${err.message}` };
  }
  if (!manifest.manifest_version) {
    return { manifest: null, error: 'Invalid manifest: missing manifest_version field' };
  }
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    return {
      manifest,
      error: `Manifest version mismatch: bundle has v${manifest.manifest_version}, this server supports v${MANIFEST_VERSION}`,
    };
  }
  if (!Array.isArray(manifest.files)) {
    return { manifest: null, error: 'Invalid manifest: files field must be an array' };
  }
  return { manifest, error: null };
}

/**
 * Run preflight checks: identify conflicts, hash matches, missing files.
 * This always runs first (even for non-dry-run). dry-run stops here.
 *
 * @param {object} manifest
 * @param {string} bundlePath
 * @param {string} vaultPath
 * @param {object} opts
 * @param {boolean} opts.overwrite
 * @returns {{ conflicts: object[], hashMatches: string[], titleWarnings: object[], missingBundleFiles: string[], hashMismatches: object[], unsafePaths: object[], nonEmptyVault: boolean }}
 */
export function preflight(manifest, bundlePath, vaultPath, opts = {}) {
  const { overwrite = false } = opts;

  const conflicts = [];        // same path, different content (would overwrite unless --overwrite)
  const hashMatches = [];      // same sha256 found somewhere else — skip silently
  const titleWarnings = [];    // same title, different path AND different content
  const missingBundleFiles = []; // in manifest but not in bundle dir
  const hashMismatches = [];   // bundle file exists but does not match manifest sha256
  const unsafePaths = [];      // manifest paths that escape bundle/vault roots

  // Build a content-hash → path map of existing vault files
  const existingByHash = new Map(); // sha256 → vault_path
  const existingByPath = new Map(); // vault_path → sha256

  function scanExisting(dir, base) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanExisting(full, base ? join(base, entry.name) : entry.name);
      } else if (entry.isFile()) {
        try {
          const relPath = base ? join(base, entry.name) : entry.name;
          const hash = entry.name.endsWith('.md')
            ? sha256String(readFileSync(full, 'utf8'))
            : sha256File(full);
          existingByHash.set(hash, relPath);
          existingByPath.set(relPath, hash);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  scanExisting(vaultPath, '');

  // Title → vault_path map (best-effort from DB)
  const existingByTitle = new Map();
  try {
    const rows = getDb().prepare('SELECT title, file_path FROM documents WHERE file_path IS NOT NULL').all();
    for (const r of rows) {
      if (r.file_path && r.title) {
        try {
          const rel = relative(vaultPath, r.file_path);
          if (!rel.startsWith('..')) {
            existingByTitle.set(r.title.toLowerCase(), rel);
          }
        } catch {
          // skip malformed paths
        }
      }
    }
  } catch {
    // ignore
  }

  for (const entry of manifest.files) {
    const { vault_path, sha256, title, restore_destination } = entry;

    // Check: bundle file exists on disk
    let bundleAbsPath;
    let destPath;
    try {
      bundleAbsPath = bundleFilePath(bundlePath, vault_path);
      destPath = relative(resolve(vaultPath), safeJoin(vaultPath, restore_destination || vault_path));
    } catch (err) {
      unsafePaths.push({ vault_path, detail: err.message });
      continue;
    }

    if (!existsSync(bundleAbsPath)) {
      missingBundleFiles.push(vault_path);
      continue;
    }

    const actualSha256 = hashBundleFile(bundleAbsPath);
    if (actualSha256 !== sha256) {
      hashMismatches.push({ vault_path, expected: sha256, actual: actualSha256 });
      continue;
    }

    // Scenario 1: Same vault-relative path already exists at the restore destination
    if (existingByPath.has(destPath)) {
      const existingHash = existingByPath.get(destPath);
      if (existingHash === sha256) {
        // Identical content — treat as hash match (silent skip)
        hashMatches.push(vault_path);
      } else {
        // Different content — conflict
        conflicts.push({
          type: 'path_conflict',
          vault_path,
          action: overwrite ? 'overwrite' : 'skip',
          detail: 'Same path exists with different content',
        });
      }
      continue;
    }

    // Scenario 2: Same content hash at different path
    if (existingByHash.has(sha256)) {
      hashMatches.push(vault_path);
      continue;
    }

    // Scenario 3: Same title, different path, different content
    if (title && existingByTitle.has(title.toLowerCase())) {
      const existingPath = existingByTitle.get(title.toLowerCase());
      titleWarnings.push({
        type: 'title_match',
        vault_path,
        existing_path: existingPath,
        action: 'skip',
        detail: 'Same title exists at different path — manual review recommended',
      });
    }
  }

  // Non-empty vault detection
  const nonEmptyVault = existsSync(vaultPath)
    && readdirSync(vaultPath).some(f => !f.startsWith('.'));

  return { conflicts, hashMatches, titleWarnings, missingBundleFiles, hashMismatches, unsafePaths, nonEmptyVault };
}

/**
 * Prompt user for confirmation (y/n). Returns true if confirmed.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(res => {
    rl.question(`${question} [y/N] `, answer => {
      rl.close();
      res(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Restore a bundle into the vault.
 *
 * @param {object} options
 * @param {string}  options.bundlePath    - absolute path to bundle directory
 * @param {string}  options.vaultPath     - absolute path to Obsidian vault
 * @param {boolean} [options.dryRun]      - preflight only, no writes
 * @param {boolean} [options.overwrite]   - overwrite existing files at same path
 * @param {boolean} [options.yes]         - skip confirmation prompt
 * @param {boolean} [options.strict]      - fail if vault is non-empty
 * @param {boolean} [options.noEmbeddings] - skip embedding regeneration
 * @returns {Promise<object>}
 */
export async function restoreFromBundle({
  bundlePath,
  vaultPath,
  dryRun = false,
  overwrite = false,
  yes = false,
  strict = false,
  noEmbeddings = false,
}) {
  if (!vaultPath) throw new Error('vaultPath is required');

  bundlePath = resolve(bundlePath);

  // Load + validate manifest
  const { manifest, error: manifestError } = loadManifest(bundlePath);
  if (manifestError) throw new Error(manifestError);

  // Run preflight
  const flight = preflight(manifest, bundlePath, vaultPath, { overwrite });

  if (dryRun) {
    const skipCount = flight.conflicts.filter(c => c.action === 'skip').length
      + flight.hashMatches.length
      + flight.titleWarnings.filter(c => c.action === 'skip').length
      + flight.missingBundleFiles.length
      + flight.hashMismatches.length
      + flight.unsafePaths.length;
    return {
      dry_run: true,
      manifest_version: manifest.manifest_version,
      exported_at: manifest.exported_at,
      total_files: manifest.files.length,
      preflight: flight,
      would_restore: manifest.files.length - skipCount,
    };
  }

  // Non-dry-run: check for blockers
  if (strict && flight.nonEmptyVault) {
    throw new Error('--strict: vault is non-empty. Aborting.');
  }

  if (flight.unsafePaths.length > 0) {
    throw new Error(
      `Bundle contains unsafe paths:\n` +
      flight.unsafePaths.slice(0, 5).map(p => `${p.vault_path}: ${p.detail}`).join('\n') +
      (flight.unsafePaths.length > 5 ? '\n...' : '')
    );
  }

  if (flight.missingBundleFiles.length > 0) {
    throw new Error(
      `Bundle is incomplete: ${flight.missingBundleFiles.length} files listed in manifest are missing:\n` +
      flight.missingBundleFiles.slice(0, 5).join('\n') +
      (flight.missingBundleFiles.length > 5 ? '\n...' : '')
    );
  }

  if (flight.hashMismatches.length > 0) {
    throw new Error(
      `Bundle failed integrity check: ${flight.hashMismatches.length} files do not match manifest hashes:\n` +
      flight.hashMismatches.slice(0, 5).map(h => h.vault_path).join('\n') +
      (flight.hashMismatches.length > 5 ? '\n...' : '')
    );
  }

  // Show preflight summary
  if (flight.conflicts.length > 0 || flight.titleWarnings.length > 0 || flight.nonEmptyVault) {
    process.stderr.write('\n[restore] Preflight summary:\n');
    if (flight.nonEmptyVault) {
      process.stderr.write('  WARNING: vault is non-empty — existing files may be affected\n');
    }
    if (flight.conflicts.length > 0) {
      process.stderr.write(`  Path conflicts: ${flight.conflicts.length} (action: ${overwrite ? 'overwrite' : 'skip'})\n`);
    }
    if (flight.hashMatches.length > 0) {
      process.stderr.write(`  Already-present (hash match): ${flight.hashMatches.length} will be skipped\n`);
    }
    if (flight.titleWarnings.length > 0) {
      process.stderr.write(`  Title matches at different path: ${flight.titleWarnings.length}\n`);
    }
    process.stderr.write('\n');
  }

  // Confirm unless --yes
  if (!yes) {
    const confirmed = await confirm(
      `Restore ${manifest.files.length} files from bundle (${manifest.exported_at}) into ${vaultPath}?`
    );
    if (!confirmed) {
      process.stderr.write('Restore cancelled.\n');
      return { cancelled: true };
    }
  }

  // Build skip-set (path conflicts that are not being overwritten, and hash matches)
  const skipPaths = new Set([
    ...flight.hashMatches,
    ...flight.conflicts.filter(c => c.action === 'skip').map(c => c.vault_path),
    ...flight.titleWarnings.filter(c => c.action === 'skip').map(c => c.vault_path),
  ]);

  let restored = 0;
  let skipped = 0;

  for (const entry of manifest.files) {
    const { vault_path, restore_destination } = entry;
    const destRelPath = restore_destination || vault_path;

    if (skipPaths.has(vault_path)) {
      skipped++;
      continue;
    }

    const bundleAbsPath = bundleFilePath(bundlePath, vault_path);
    const destAbs = safeJoin(vaultPath, destRelPath);

    if (!existsSync(bundleAbsPath)) {
      skipped++;
      continue;
    }

    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(bundleAbsPath, destAbs);
    restored++;
  }

  // Reindex vault
  process.stderr.write(`[restore] Restored ${restored} files, skipped ${skipped}. Reindexing vault...\n`);

  try {
    const { indexVault } = await import('./vault/indexer.js');
    const indexResult = await indexVault(vaultPath, { embeddings: !noEmbeddings });
    process.stderr.write(`[restore] Index complete: ${indexResult.indexed} indexed, ${indexResult.skipped} skipped, ${indexResult.errors?.length || 0} errors\n`);

    // Rebuild FTS5
    const { getDb } = await import('./db.js');
    getDb().exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
    process.stderr.write('[restore] FTS5 index rebuilt.\n');
  } catch (err) {
    process.stderr.write(`[restore] Warning: reindex failed: ${err.message}\n`);
  }

  return {
    dry_run: false,
    restored,
    skipped,
    conflicts: flight.conflicts.length,
    hash_matches: flight.hashMatches.length,
    title_warnings: flight.titleWarnings.length,
  };
}
