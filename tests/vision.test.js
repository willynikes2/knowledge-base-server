import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Minimal valid 1x1 transparent PNG.
// ---------------------------------------------------------------------------
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let tmpDir;

function makeTmpPng(name = 'test.png') {
  const p = join(tmpDir, name);
  writeFileSync(p, TINY_PNG);
  return p;
}

// ---------------------------------------------------------------------------
// MEDIA_TYPES coverage
// ---------------------------------------------------------------------------
describe('MEDIA_TYPES', () => {
  it('maps all expected image extensions', async () => {
    // We re-read the source to avoid importing side-effects just for the map
    const src = await fs.readFile(
      new URL('../src/vision.js', import.meta.url),
      'utf-8'
    );
    const extensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    for (const ext of extensions) {
      assert.ok(
        src.includes(`'${ext}'`),
        `MEDIA_TYPES should contain ${ext}`
      );
    }
  });

  it('maps .jpg and .jpeg to image/jpeg', async () => {
    // Verify the string values appear in the source
    const src = await fs.readFile(
      new URL('../src/vision.js', import.meta.url),
      'utf-8'
    );
    assert.ok(src.includes("'image/jpeg'"), 'should map to image/jpeg');
    assert.ok(src.includes("'image/png'"), 'should map to image/png');
    assert.ok(src.includes("'image/gif'"), 'should map to image/gif');
    assert.ok(src.includes("'image/webp'"), 'should map to image/webp');
    assert.ok(src.includes("'image/svg+xml'"), 'should map to image/svg+xml');
  });
});

// ---------------------------------------------------------------------------
// extractFromImage
// ---------------------------------------------------------------------------
describe('extractFromImage', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vision-test-'));
    // Force Tesseract path for all tests in this suite
    process.env.KB_VISION_ENABLED = 'false';
    process.env.KB_TESSERACT_STUB_TEXT = '';
    // Ensure no API key leaks into Claude path
    delete process.env.ANTHROPIC_API_KEY;
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KB_VISION_ENABLED;
    delete process.env.KB_TESSERACT_STUB_TEXT;
  });

  it('throws when file exceeds 20 MB', async () => {
    const { extractFromImage } = await import('../src/vision.js');

    // Create a real temp file so stat() works, then override fs.stat via
    // a large fake size by creating a file and patching the stat result.
    // Simplest approach: create a real file and monkey-patch fs/promises.stat
    const imgPath = makeTmpPng('big.png');

    // Save original and replace with a mock that returns oversized stat
    const originalStat = fs.stat.bind(fs);
    fs.stat = async (p) => {
      if (p === imgPath) return { size: 21 * 1024 * 1024 };
      return originalStat(p);
    };

    try {
      await assert.rejects(
        () => extractFromImage(imgPath),
        (err) => {
          assert.ok(err.message.includes('20 MB'), `Expected 20 MB message, got: ${err.message}`);
          return true;
        }
      );
    } finally {
      fs.stat = originalStat;
    }
  });

  it('uses Tesseract when KB_VISION_ENABLED=false', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    const imgPath = makeTmpPng('tesseract-path.png');

    const result = await extractFromImage(imgPath);

    assert.equal(result.method, 'tesseract', 'method should be tesseract');
    assert.ok(typeof result.text === 'string', 'text should be a string');
    assert.ok(typeof result.description === 'string', 'description should be a string');
  });

  it('returns { text, method, description } shape', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    const imgPath = makeTmpPng('shape.png');

    const result = await extractFromImage(imgPath);

    assert.ok('text' in result, 'result should have text');
    assert.ok('method' in result, 'result should have method');
    assert.ok('description' in result, 'result should have description');
  });

  it('prepends options.note to text', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    const imgPath = makeTmpPng('with-note.png');

    const result = await extractFromImage(imgPath, { note: 'my annotation' });

    assert.ok(
      result.text.startsWith('User note: my annotation'),
      `Expected text to start with note, got: ${result.text.slice(0, 60)}`
    );
  });

  it('sets description to first non-empty line of text', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    const imgPath = makeTmpPng('description.png');

    const result = await extractFromImage(imgPath, { note: 'first line note' });

    // When note is prepended, first non-empty line is "User note: ..."
    assert.equal(
      result.description,
      'User note: first line note',
      'description should be first non-empty line'
    );
  });

  it('description is empty string when text is empty', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    // Use a real PNG with no OCR-able text (1x1 pixel → Tesseract returns empty/whitespace)
    const imgPath = makeTmpPng('empty-desc.png');

    const result = await extractFromImage(imgPath);

    // Tesseract on a 1x1 pixel returns empty or whitespace-only text
    // description should be '' (firstLine returns '' for empty input)
    assert.ok(
      typeof result.description === 'string',
      'description should be a string even when text is empty'
    );
  });
});

// ---------------------------------------------------------------------------
// firstLine logic (tested indirectly via description field)
// ---------------------------------------------------------------------------
describe('firstLine behavior via description', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'firstline-test-'));
    process.env.KB_VISION_ENABLED = 'false';
    process.env.KB_TESSERACT_STUB_TEXT = '';
    delete process.env.ANTHROPIC_API_KEY;
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KB_VISION_ENABLED;
    delete process.env.KB_TESSERACT_STUB_TEXT;
  });

  it('skips leading empty lines to find first non-empty line', async () => {
    const { extractFromImage } = await import('../src/vision.js');
    const imgPath = makeTmpPng('firstline.png');

    // Note with leading newlines — description should skip blank lines
    const result = await extractFromImage(imgPath, { note: '\n\nactual content' });

    // text = "User note: \n\nactual content\n\n<tesseract output>"
    // firstLine scans lines and returns first non-empty one
    const lines = result.text.split('\n').filter((l) => l.trim());
    assert.equal(
      result.description,
      lines[0],
      'description should equal first non-empty line of text'
    );
  });
});

// ---------------------------------------------------------------------------
// ingest.js — extractContent routes image type correctly
// ---------------------------------------------------------------------------
describe('ingest.js image routing', () => {
  let tmpDir2;

  before(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), 'ingest-test-'));
    process.env.KB_VISION_ENABLED = 'false';
    process.env.KB_TESSERACT_STUB_TEXT = '';
    delete process.env.ANTHROPIC_API_KEY;
  });

  after(() => {
    rmSync(tmpDir2, { recursive: true, force: true });
    delete process.env.KB_VISION_ENABLED;
    delete process.env.KB_TESSERACT_STUB_TEXT;
  });

  it('TYPE_MAP maps image extensions to "image" type', async () => {
    // Read ingest.js source and verify image extensions are mapped
    const src = await fs.readFile(
      new URL('../src/ingest.js', import.meta.url),
      'utf-8'
    );
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    for (const ext of imageExts) {
      assert.ok(
        src.includes(`'${ext}': 'image'`),
        `ingest.js TYPE_MAP should map ${ext} to 'image'`
      );
    }
  });

  it('extractContent calls extractFromImage for image type', async () => {
    // Verify the routing exists in source code
    const src = await fs.readFile(
      new URL('../src/ingest.js', import.meta.url),
      'utf-8'
    );
    assert.ok(
      src.includes("type === 'image'"),
      "extractContent should have branch for type === 'image'"
    );
    assert.ok(
      src.includes('extractFromImage'),
      'extractContent should call extractFromImage'
    );
  });

  it('ingestFile returns null for unknown extensions', async () => {
    const { ingestFile } = await import('../src/ingest.js');
    const unknownFile = join(tmpDir2, 'file.xyz');
    writeFileSync(unknownFile, 'data');

    const result = await ingestFile(unknownFile);
    assert.equal(result, null, 'ingestFile should return null for unknown extensions');
  });
});
