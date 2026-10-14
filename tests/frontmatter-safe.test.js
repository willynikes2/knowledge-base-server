// tests/frontmatter-safe.test.js
// A note's header is data. Only YAML (and JSON) headers are read; a header that declares a code language is refused.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readNote } from '../src/utils/frontmatter.js';
import { parseVaultNote } from '../src/vault/parser.js';

const CODE_HEADERS = ['js', 'javascript', 'coffee', 'coffeescript', 'cson', 'toml', 'JS', 'JavaScript'];

describe('reading a note header', () => {
  it('reads a YAML header and the body', () => {
    const { data, content } = readNote('---\ntitle: "Plain"\ntags: [a, b]\n---\n\nBody text.\n');
    assert.deepStrictEqual(data, { title: 'Plain', tags: ['a', 'b'] });
    assert.strictEqual(content.trim(), 'Body text.');
  });

  it('reads a note with no header', () => {
    const { data, content } = readNote('# Just a note\n\nText.\n');
    assert.deepStrictEqual(data, {});
    assert.match(content, /Just a note/);
  });

  it('refuses a header written in a code language, and names the note problem', () => {
    for (const lang of CODE_HEADERS) {
      assert.throws(() => readNote(`---${lang}\n{ "title": "From code" }\n---\nBody\n`), /only YAML note headers are read/, lang);
    }
  });

  it('the vault parser refuses such a note instead of using its header', () => {
    assert.throws(() => parseVaultNote('---js\n{ "title": "From code" }\n---\nBody\n', 'inbox/x.md'), /only YAML note headers are read/);
    assert.strictEqual(parseVaultNote('---\ntitle: "Fine"\n---\nBody\n', 'inbox/y.md').title, 'Fine');
  });

  it('every reader of note headers goes through readNote', () => {
    for (const file of ['../src/vault/parser.js', '../src/classify/processor.js', '../src/classify/summarizer.js']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      assert.ok(!/from 'gray-matter'/.test(source), `${file} must not import gray-matter directly`);
      assert.ok(source.includes('readNote('), `${file} reads headers with readNote`);
    }
  });
});

describe('writing a note', () => {
  it('keeps the body exactly as given, whatever it starts with, and never reads it as a header', async () => {
    const { writeNote } = await import('../src/utils/frontmatter.js');
    for (const body of ['---js\n{ "added": 1 }\n---\nrest of the body\n', '---\nadded: 1\n---\nrest of the body\n', '---json\n{ "added": 1 }\n---\nrest\n', 'plain body\n']) {
      const out = writeNote(body, { title: 'Kept' });
      const back = readNote(out);
      assert.deepStrictEqual(back.data, { title: 'Kept' }, `header is only what was passed in, for body ${JSON.stringify(body.slice(0, 12))}`);
      assert.ok(out.endsWith(body) || out.includes(body.trim()), 'the body is written unchanged');
    }
  });
});

describe('a note that starts with a rule line', () => {
  it('is an ordinary note with no header', () => {
    for (const text of ['----\n\nText under a rule.\n', '-----\nText\n']) {
      const { data } = readNote(text);
      assert.deepStrictEqual(data, {}, JSON.stringify(text.slice(0, 8)));
    }
  });
});
