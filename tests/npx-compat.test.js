import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

describe('npx compatibility', () => {
  const kbBin = join(import.meta.dirname, '..', 'bin', 'kb.js');

  it('should show usage when run from /tmp (no CWD .env needed)', () => {
    const result = execFileSync(process.execPath, [kbBin], {
      cwd: '/tmp',
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.ok(result.includes('Usage: kb'), 'Should print usage');
  });

  it('should load .env from ~/.knowledge-base/ when present', () => {
    const envPath = join(homedir(), '.knowledge-base', '.env');
    if (!existsSync(envPath)) return; // skip on fresh install
    try {
      execFileSync(process.execPath, [kbBin, 'status'], {
        cwd: '/tmp',
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (err) {
      // Status may fail if server isn't running, but should NOT have dotenv errors
      assert.ok(
        !err.stderr?.includes('dotenv') && !err.stderr?.includes('ENOENT'),
        'Should not have dotenv/file errors'
      );
    }
  });

  it('should have KB_DIR at ~/.knowledge-base', async () => {
    const { KB_DIR } = await import('../src/paths.js');
    assert.strictEqual(KB_DIR, join(homedir(), '.knowledge-base'));
  });

  it('should have ENV_PATH at ~/.knowledge-base/.env', async () => {
    const { ENV_PATH } = await import('../src/paths.js');
    assert.strictEqual(ENV_PATH, join(homedir(), '.knowledge-base', '.env'));
  });

  it('should not crash when openapi.json is loaded', async () => {
    const openapiPath = join(import.meta.dirname, '..', 'openapi.json');
    assert.ok(existsSync(openapiPath), 'openapi.json should exist at package root');
  });
});
