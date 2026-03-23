import { describe, it } from 'node:test';
import assert from 'node:assert';
import { KB_DIR, ENV_PATH } from '../src/paths.js';
import { join } from 'path';
import { homedir } from 'os';

describe('paths', () => {
  it('should export KB_DIR as ~/.knowledge-base', () => {
    assert.strictEqual(KB_DIR, join(homedir(), '.knowledge-base'));
  });

  it('should export ENV_PATH inside KB_DIR', () => {
    assert.strictEqual(ENV_PATH, join(homedir(), '.knowledge-base', '.env'));
  });
});
