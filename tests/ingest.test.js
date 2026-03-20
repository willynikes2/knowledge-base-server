import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectFiles } from '../src/ingest.js';

describe('collectFiles', () => {
  let testDir;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'test-ingest-'));

    // A valid markdown file at root
    writeFileSync(join(testDir, 'readme.md'), '# Hello');

    // Files inside ignored directories — should all be skipped
    for (const ignored of ['node_modules', '.git', 'dist', 'build', '__pycache__']) {
      mkdirSync(join(testDir, ignored), { recursive: true });
      writeFileSync(join(testDir, ignored, 'file.md'), '# ignored');
    }

    // A valid file in a normal subdirectory — should be included
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide');
  });

  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('should collect files in normal directories', () => {
    const files = collectFiles(testDir);
    assert.ok(files.some(f => f.endsWith('readme.md')), 'should include readme.md');
    assert.ok(files.some(f => f.endsWith('guide.md')), 'should include docs/guide.md');
  });

  it('should skip node_modules, .git, dist, build, and __pycache__', () => {
    const files = collectFiles(testDir);
    for (const ignored of ['node_modules', '.git', 'dist', 'build', '__pycache__']) {
      assert.ok(
        !files.some(f => f.includes(`/${ignored}/`)),
        `should not include files from ${ignored}/`,
      );
    }
  });
});
