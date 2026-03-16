import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseVaultNote } from '../src/vault/parser.js';

describe('parseVaultNote', () => {
  it('should extract frontmatter and body', () => {
    const content = `---
title: "Test Note"
type: research
tags: [ai, agents]
project: kb-system
created: "2026-03-16"
status: active
---

# Test Note

This is the body content.

## Section Two

More content here.`;

    const result = parseVaultNote(content, '05_research/test-note.md');
    assert.strictEqual(result.title, 'Test Note');
    assert.strictEqual(result.type, 'research');
    assert.strictEqual(result.project, 'kb-system');
    assert.strictEqual(result.status, 'active');
    assert.deepStrictEqual(result.tags, ['ai', 'agents']);
    assert.ok(result.body.includes('This is the body content.'));
    assert.ok(result.body.includes('Section Two'));
    assert.strictEqual(result.vault_path, '05_research/test-note.md');
  });

  it('should handle notes without frontmatter', () => {
    const content = '# Quick Note\n\nJust some text.';
    const result = parseVaultNote(content, '00_inbox/quick.md');
    assert.strictEqual(result.title, 'Quick Note');
    assert.strictEqual(result.type, 'inbox');
    assert.strictEqual(result.body, '# Quick Note\n\nJust some text.');
  });

  it('should infer type from folder path', () => {
    const content = '---\ntitle: Fix\n---\nFixed it.';
    const result = parseVaultNote(content, '11_builds/fixes/my-fix.md');
    assert.strictEqual(result.type, 'fix');
  });

  it('should normalize tags from string to array', () => {
    const content = '---\ntags: "ai, agents, workflow"\n---\nBody';
    const result = parseVaultNote(content, 'test.md');
    assert.deepStrictEqual(result.tags, ['ai', 'agents', 'workflow']);
  });
});
