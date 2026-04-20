// src/cli/export-cli.js — kb export command handler
import { resolve, join } from 'path';
import { readFileSync } from 'fs';
import { exportDocs } from '../export.js';

/**
 * Usage:
 *   kb export [--out=<dir>] [--all] [--dry-run] [--dry-run --json]
 *             [--filter=spec.json]
 *             [--tag=X] [--tag=Y]     (shortcut: desugar to filter.include.tags_any)
 *             [--doc-type=X]          (shortcut: desugar to filter.include.doc_type)
 *             [--archive]             (produce .tar.gz alongside directory)
 *             [--no-attachments]      (skip binary attachments)
 */
export async function exportCmd(args) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH is not set. Run kb setup first.');
    process.exit(1);
  }

  const dryRun = args.includes('--dry-run');
  const jsonOutput = args.includes('--json');
  const archive = args.includes('--archive');
  const noAttachments = args.includes('--no-attachments');

  // Resolve --out= flag
  const outFlag = args.find(a => a.startsWith('--out='));
  let outPath;
  if (outFlag) {
    outPath = resolve(outFlag.slice('--out='.length));
  } else {
    const today = new Date().toISOString().slice(0, 10);
    outPath = resolve(process.cwd(), `export-${today}-full-backup`);
  }

  // Resolve --filter= flag
  const filterFlag = args.find(a => a.startsWith('--filter='));
  let filterSpec = null;
  let useAll = true;

  if (filterFlag) {
    const filterPath = resolve(filterFlag.slice('--filter='.length));
    try {
      filterSpec = JSON.parse(readFileSync(filterPath, 'utf8'));
      useAll = false;
    } catch (err) {
      console.error(`Error reading filter spec: ${err.message}`);
      process.exit(1);
    }
  }

  // Shortcut flags: --tag=X, --doc-type=Y
  const tagFlags = args.filter(a => a.startsWith('--tag=')).map(a => a.slice('--tag='.length));
  const docTypeFlags = args.filter(a => a.startsWith('--doc-type=')).map(a => a.slice('--doc-type='.length));

  if (tagFlags.length > 0 || docTypeFlags.length > 0) {
    // Desugar to filter spec
    filterSpec = filterSpec || {};
    filterSpec.include = filterSpec.include || {};
    if (tagFlags.length > 0) {
      filterSpec.include.tags_any = [...(filterSpec.include.tags_any || []), ...tagFlags];
    }
    if (docTypeFlags.length > 0) {
      filterSpec.include.doc_type = [...(filterSpec.include.doc_type || []), ...docTypeFlags];
    }
    useAll = false;
  }

  if (!dryRun) {
    process.stderr.write(`[export] Writing bundle to: ${outPath}\n`);
    if (!useAll) {
      process.stderr.write(`[export] Using filter spec\n`);
    }
  } else {
    process.stderr.write('[export] Dry-run mode — nothing will be written\n');
  }

  try {
    const result = await exportDocs({
      outPath,
      dryRun,
      all: useAll,
      filter: filterSpec,
      vaultPath,
      archive,
      noAttachments,
    });

    if (jsonOutput || dryRun) {
      const output = {
        dry_run: dryRun,
        out_path: outPath,
        manifest_version: result.manifest.manifest_version,
        exported_at: result.manifest.exported_at,
        counts: result.manifest.counts,
        filter_spec: result.manifest.filter_spec,
        filter_expanded: result.manifest.filter_expanded,
        files: result.manifest.files,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`Exported ${result.written} files to: ${outPath}`);
      console.log(`  docs: ${result.manifest.counts.docs}, attachments: ${result.manifest.counts.attachments}`);
      console.log(`  manifest: ${outPath}/manifest.json`);
      if (archive) {
        console.log(`  archive: ${outPath}.tar.gz`);
      }
    }
  } catch (err) {
    console.error(`Export failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}
