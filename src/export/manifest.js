// src/export/manifest.js — v1 manifest writer + README generator
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export const MANIFEST_VERSION = 1;

/**
 * Compute SHA-256 hex digest of a file's bytes.
 * @param {string} filePath - absolute path
 * @returns {string}
 */
export function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute SHA-256 hex digest of a string (UTF-8).
 * @param {string} content
 * @returns {string}
 */
export function sha256String(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Build a manifest.json v1 object.
 *
 * @param {object} opts
 * @param {string} opts.kbServerVersion  - semver string from package.json
 * @param {object} opts.filterSpec       - the filter spec used (or { all: true } for --all)
 * @param {object} opts.filterExpanded   - expanded filter state (general_infra expansion, resolved_ids)
 * @param {Array}  opts.files            - array of file entry objects (see below)
 * @param {object} opts.counts           - { docs: N, attachments: N }
 * @returns {object}
 *
 * File entry shape:
 *   vault_path        - relative path from vault root (e.g. "decisions/foo.md")
 *   sha256            - hex sha256 of the exported file bytes
 *   size              - byte size
 *   title             - document title
 *   doc_type          - document type string
 *   tags              - normalized tags array
 *   original_db_id    - informational: DB id at export time
 *   restore_destination - relative path to write during restore (usually same as vault_path)
 */
export function buildManifest({ kbServerVersion, filterSpec, filterExpanded, files, counts }) {
  return {
    manifest_version: MANIFEST_VERSION,
    kb_server_version: kbServerVersion,
    exported_at: new Date().toISOString(),
    filter_spec: filterSpec || { all: true },
    filter_expanded: filterExpanded || {},
    counts: counts || { docs: files.length, attachments: 0 },
    files,
  };
}

/**
 * Generate the actionable README.md content for the bundle.
 * @param {object} manifest
 * @param {string} bundleName - directory or archive name
 * @returns {string}
 */
export function generateReadme(manifest, bundleName) {
  const docCount = manifest.counts.docs;
  const filterLine = manifest.filter_spec?.all
    ? '`--all` (full export)'
    : '`--filter=<spec>` (see manifest.json for filter_spec)';

  return `# KB Export Bundle

**Exported:** ${manifest.exported_at}
**Documents:** ${docCount}
**Filter:** ${filterLine}
**KB Server Version:** ${manifest.kb_server_version}
**Manifest Version:** ${manifest.manifest_version}

## Restore

\`\`\`bash
# Prerequisites: KB server installed and configured
# (run kb-server-install.sh if fresh install)

# Preview what will happen (no writes):
kb restore ./${bundleName} --dry-run

# Restore:
kb restore ./${bundleName} --yes

# Restore without regenerating embeddings (faster):
kb restore ./${bundleName} --yes --no-embeddings

# Overwrite existing files:
kb restore ./${bundleName} --yes --overwrite
\`\`\`

## Notes

- \`--overwrite\` replaces files at the **same vault path** only. It does NOT mass-overwrite title matches.
- The KB will be reindexed automatically after restore.
- \`original_db_id\` fields in \`manifest.json\` are **informational only** — IDs are reassigned on restore.
- Embeddings are NOT included; they are regenerated on restore (or skipped with \`--no-embeddings\`).
`;
}

/**
 * Read kb server version from package.json.
 * @param {string} repoRoot - absolute path to repo root
 * @returns {string}
 */
export function readKbVersion(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
