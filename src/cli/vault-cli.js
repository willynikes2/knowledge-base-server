import { indexVault } from '../vault/indexer.js';

export function vaultReindex() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH not set');
    process.exit(1);
  }
  console.log(`Indexing vault at ${vaultPath}...`);
  const result = indexVault(vaultPath);
  console.log(`Done: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.deleted} removed`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`  ${e}`));
  }
}
