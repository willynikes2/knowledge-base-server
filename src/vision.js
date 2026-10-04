import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { KB_DIR } from './paths.js';

// Tesseract caches its language model in the cwd by default; keep it with the KB data.
const TESSERACT_CACHE_DIR = path.join(KB_DIR, 'tesseract');

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const VISION_PROMPT =
  'Describe this image in detail. Extract ALL visible text, code, data, labels, and UI elements. ' +
  'Provide a comprehensive searchable summary.';

async function extractWithClaude(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`Unsupported image type: ${ext}`);

  const buffer = await fs.readFile(imagePath);
  const base64 = buffer.toString('base64');

  const client = new Anthropic();
  const model = process.env.KB_VISION_MODEL || 'claude-haiku-4-5-20251001';

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return text;
}

async function extractWithTesseract(imagePath) {
  if (process.env.KB_TESSERACT_STUB_TEXT !== undefined) {
    return process.env.KB_TESSERACT_STUB_TEXT;
  }

  const { createWorker } = await import('tesseract.js');
  let worker;
  try {
    await fs.mkdir(TESSERACT_CACHE_DIR, { recursive: true });
    worker = await createWorker('eng', undefined, { cachePath: TESSERACT_CACHE_DIR });
    const { data } = await worker.recognize(imagePath);
    return data.text;
  } catch (err) {
    throw new Error(`OCR failed: ${err.message || 'corrupt or unreadable image'}`);
  } finally {
    try { if (worker) await worker.terminate(); } catch {}
  }
}

function firstLine(text) {
  return (text || '').split('\n').find((l) => l.trim()) || '';
}

/**
 * Extract text and description from an image file.
 *
 * @param {string} imagePath - Absolute path to the image file.
 * @param {object} [options]
 * @param {string} [options.note] - Optional user note prepended to the result.
 * @returns {Promise<{ text: string, method: 'claude-vision'|'tesseract', description: string }>}
 */
export async function extractFromImage(imagePath, options = {}) {
  const stat = await fs.stat(imagePath);
  if (stat.size > 20 * 1024 * 1024) {
    throw new Error(`Image exceeds 20 MB limit: ${imagePath}`);
  }

  const visionEnabled = process.env.KB_VISION_ENABLED !== 'false';
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  let text = '';
  let method;

  if (visionEnabled && hasApiKey) {
    try {
      text = await extractWithClaude(imagePath);
      method = 'claude-vision';
    } catch {
      text = await extractWithTesseract(imagePath);
      method = 'tesseract';
    }
  } else {
    text = await extractWithTesseract(imagePath);
    method = 'tesseract';
  }

  if (options.note) {
    text = `User note: ${options.note}\n\n${text}`;
  }

  const description = firstLine(text);

  return { text, method, description };
}
