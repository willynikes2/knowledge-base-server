// src/cli/restore-cli.js — kb restore command handler
import { resolve } from 'path';
import { restoreFromBundle } from '../restore.js';

/**
 * Usage:
 *   kb restore <bundle-path> [--dry-run] [--overwrite] [--yes] [--strict] [--no-embeddings]
 */
export async function restoreCmd(args) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH is not set. Run kb setup first.');
    process.exit(1);
  }

  // First positional arg that doesn't start with -- is the bundle path
  const bundleArg = args.find(a => !a.startsWith('--'));
  if (!bundleArg) {
    console.error('Usage: kb restore <bundle-path> [--dry-run] [--overwrite] [--yes] [--strict] [--no-embeddings]');
    process.exit(1);
  }

  const bundlePath = resolve(bundleArg);
  const dryRun = args.includes('--dry-run');
  const overwrite = args.includes('--overwrite');
  const yes = args.includes('--yes');
  const strict = args.includes('--strict');
  const noEmbeddings = args.includes('--no-embeddings');
  const jsonOutput = args.includes('--json');

  try {
    const result = await restoreFromBundle({
      bundlePath,
      vaultPath,
      dryRun,
      overwrite,
      yes,
      strict,
      noEmbeddings,
    });

    if (jsonOutput || dryRun) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.cancelled) {
      // already printed
    } else {
      console.log(`Restore complete: ${result.restored} restored, ${result.skipped} skipped`);
      if (result.conflicts > 0) {
        console.log(`  Path conflicts: ${result.conflicts} (use --overwrite to replace)`);
      }
    }
  } catch (err) {
    console.error(`Restore failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}
