import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('setup config paths', () => {
  it('should import setup module without error', async () => {
    const mod = await import('../src/cli/setup.js');
    assert.ok(mod.setup, 'setup function should be exported');
  });

  it('should not reference PROJECT_ROOT for config writes', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'cli', 'setup.js'),
      'utf-8'
    );
    assert.ok(
      !source.includes("join(PROJECT_ROOT, '.env')"),
      'Should not write .env to PROJECT_ROOT'
    );
    assert.ok(
      !source.includes("join(PROJECT_ROOT, 'setup-config.json')"),
      'Should not read setup-config.json from PROJECT_ROOT'
    );
    assert.ok(
      !source.includes("join(PROJECT_ROOT, 'docker-compose.yml')"),
      'Should not write docker-compose.yml to PROJECT_ROOT'
    );
  });
});
