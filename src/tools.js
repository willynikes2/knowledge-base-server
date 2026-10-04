import { z } from 'zod';
import http from 'http';
import https from 'https';
import { writeFileSync, mkdirSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { searchDocuments, listDocuments, getDocument, getStats, getDb } from './db.js';
import { ingestText } from './ingest.js';
import { extractFromImage } from './vision.js';
import { indexVault } from './vault/indexer.js';
import { captureYouTube } from './capture/youtube.js';
import { captureWeb } from './capture/web.js';
import { captureSession, captureFix } from './capture/terminal.js';
import { hybridSearch } from './embeddings/search.js';
import { formatYamlTags } from './utils/frontmatter.js';
import { getRecentNotes, generateSynthesisPrompt } from './synthesis/weekly-review.js';
import { processNewClippings } from './classify/processor.js';
import { reviewDestructiveAction } from './safety/review.js';
import { getBusToolDefinitions } from './bus/tools.js';
import { resolveUnder } from './safe-path.js';

const ADMIN_ONLY_TOOLS = new Set([
  'kb_classify',
  'kb_promote',
  'kb_synthesize',
  'kb_safety_check',
  'kb_capture_youtube',
  'kb_export',
  'kb_restore',
  'bus_send',
  'bus_inbox',
  'bus_wait',
]);

const TOOL_EXPORT_ROOT = resolve(process.env.KB_EXPORT_ROOT || join(homedir(), '.knowledge-base', 'exports'));

function pathUnder(root, inputPath) {
  return resolveUnder(root, inputPath, `Path must stay under ${resolve(root)}`);
}

// Non-public ranges. BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d)
// against the IPv4 rules; IPv4-compatible (::/96) and NAT64 are listed explicitly.
const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC_ADDRESSES.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) NON_PUBLIC_ADDRESSES.addSubnet(net, prefix, 'ipv6');

function isPrivateIPv4(address) {
  return isIP(address) !== 4 || NON_PUBLIC_ADDRESSES.check(address, 'ipv4');
}

function isPrivateIPv6(address) {
  return isIP(address) !== 6 || NON_PUBLIC_ADDRESSES.check(address, 'ipv6');
}

async function assertPublicImageUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('image_url must use http or https');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalType = isIP(hostname);
  if (literalType === 4 && isPrivateIPv4(hostname)) {
    throw new Error('image_url must not point to a private or loopback IPv4 address');
  }
  if (literalType === 6 && isPrivateIPv6(hostname)) {
    throw new Error('image_url must not point to a private or loopback IPv6 address');
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  for (const record of records) {
    if ((record.family === 4 && isPrivateIPv4(record.address))
      || (record.family === 6 && isPrivateIPv6(record.address))) {
      throw new Error('image_url resolves to a private or loopback address');
    }
  }
  return { url, record: records[0] };
}

async function downloadPublicImageUrl(rawUrl, redirects = 0) {
  const { url, record } = await assertPublicImageUrl(rawUrl);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolvePromise, rejectPromise) => {
    const req = client.request(url, {
      lookup: (_hostname, _options, callback) => callback(null, record.address, record.family),
      timeout: 10_000,
      headers: { 'User-Agent': 'knowledge-base-server/1.0' },
    }, (res) => {
      const statusCode = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 3) {
          rejectPromise(new Error('Too many redirects while downloading image'));
          return;
        }
        downloadPublicImageUrl(new URL(res.headers.location, url).toString(), redirects + 1)
          .then(resolvePromise, rejectPromise);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        rejectPromise(new Error(`Failed to download image: ${statusCode} ${res.statusMessage || ''}`.trim()));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          req.destroy(new Error('Downloaded image exceeds 20MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolvePromise(Buffer.concat(chunks)));
    });

    req.on('timeout', () => req.destroy(new Error('Timed out downloading image')));
    req.on('error', rejectPromise);
    req.end();
  });
}

export function getToolDefinitions() {
  return [
    ...getBusToolDefinitions(),
    {
      name: 'kb_search',
      description: 'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets.',
      schema: {
        query: z.string().describe('Full-text search query'),
        limit: z.number().optional().default(20).describe('Maximum number of results to return'),
      },
      handler: async ({ query, limit }) => {
        try {
          const results = searchDocuments(query, limit);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_list',
      description: 'List documents in the knowledge base, optionally filtered by type or tag.',
      schema: {
        type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().default(50).describe('Maximum number of results to return'),
      },
      handler: async ({ type, tag, limit }) => {
        try {
          const results = listDocuments({ type, tag, limit });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_read',
      description: 'Read the full content of a specific document by its ID.',
      schema: {
        id: z.number().describe('Document ID'),
      },
      handler: async ({ id }) => {
        try {
          const doc = getDocument(id);
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_ingest',
      description: 'Ingest a new document into the knowledge base from text content.',
      schema: {
        title: z.string().describe('Document title'),
        content: z.string().describe('Document text content'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, content, tags }) => {
        try {
          const doc = ingestText(title, content, tags);
          return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_ingest_image',
      description: 'Ingest an image into the knowledge base. Stores the original in the vault and extracts text via AI vision. IMPORTANT: base64 image_data has a ~50KB limit due to MCP tool call size constraints. For large images: (1) ALWAYS resize to max 800px wide and convert to JPEG quality 60 before encoding, or (2) prefer image_url if the image is hosted anywhere. If the image is too large even after compression, describe it in a kb_write note instead.',
      schema: {
        title: z.string().describe('Document title for the ingested image'),
        image_data: z.string().optional().describe('Base64-encoded image data (provide this OR image_url)'),
        image_url: z.string().optional().describe('URL to download the image from (provide this OR image_data)'),
        media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).optional()
          .default('image/png').describe('MIME type of the image'),
        note: z.string().optional().describe('Context about the image — what it shows, why it matters'),
        tags: z.string().optional().describe('Comma-separated tags (e.g. screenshot,error,debug)'),
        category: z.enum(['screenshot', 'error', 'diagram', 'reference', 'photo', 'other']).optional()
          .default('screenshot').describe('Image category for organization'),
      },
      handler: async ({ title, image_data, image_url, media_type, note, tags, category }) => {
        if (!image_data && !image_url) {
          return { content: [{ type: 'text', text: 'Error: Provide either image_data (base64) or image_url' }], isError: true };
        }
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) {
          return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        }

        const ext = (media_type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
        const date = new Date().toISOString().split('T')[0];
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
        const filename = `${date}-${slug}.${ext}`;
        const tmpPath = join(tmpdir(), `kb-img-${randomBytes(8).toString('hex')}.${ext}`);

        try {
          // Download or decode image to temp file
          if (image_url) {
            const buf = await downloadPublicImageUrl(image_url);
            await writeFile(tmpPath, buf);
          } else {
            const cleaned = image_data.replace(/^data:image\/[^;]+;base64,/, '');
            const buf = Buffer.from(cleaned, 'base64');
            if (buf.length > 50 * 1024) throw new Error('image_data exceeds the 50KB MCP limit; use image_url or summarize it in a note');
            if (buf.length < 100) throw new Error('Image data too small or corrupt — base64 may have been truncated');
            await writeFile(tmpPath, buf);
          }

          // Store original image in vault Images/ folder
          const { mkdirSync, copyFileSync } = await import('fs');
          const imagesDir = join(vaultPath, 'Images', category || 'screenshot');
          mkdirSync(imagesDir, { recursive: true });
          const imagePath = join(imagesDir, filename);
          copyFileSync(tmpPath, imagePath);

          // Extract text/description via vision
          const result = await extractFromImage(tmpPath, { note });

          // Build KB document content with image reference
          const content = [
            note ? `**Context:** ${note}` : '',
            imagePath ? `**Image:** [[Images/${category || 'screenshot'}/${filename}]]` : '',
            image_url ? `**Source URL:** ${image_url}` : '',
            `**Category:** ${category || 'screenshot'}`,
            `**Extraction method:** ${result.method}`,
            '',
            '---',
            '',
            result.text,
          ].filter(Boolean).join('\n');

          const doc = ingestText(title, content, {
            tags: tags ? tags.split(',').map(t => t.trim()) : ['image', category || 'screenshot'],
            doc_type: 'image',
            source: image_url ? `image-url:${image_url}` : `image-upload:${filename}`,
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: doc.id,
                title: doc.title,
                image_stored: imagePath ? `Images/${category || 'screenshot'}/${filename}` : null,
                extraction_method: result.method,
                preview: result.text.slice(0, 300) + (result.text.length > 300 ? '...' : ''),
              }, null, 2),
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        } finally {
          unlink(tmpPath).catch(() => {});
        }
      },
    },

    {
      name: 'kb_write',
      description: 'Write a new note to the Obsidian vault. Use this to capture knowledge, ideas, lessons, or research that should persist across sessions. The note will be synced to all devices via Obsidian Sync.',
      schema: {
        title: z.string().describe('Note title'),
        content: z.string().describe('Markdown content (body text, no frontmatter needed)'),
        type: z.enum(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'session', 'capture'])
          .optional().default('capture').describe('Note type — determines vault folder destination'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Project name (e.g. my-app, backend, frontend)'),
      },
      handler: async ({ title, content, type, tags, project }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };

          const folderMap = {
            capture: 'inbox',
            research: 'research',
            idea: 'ideas',
            workflow: 'workflows',
            lesson: 'agents/lessons',
            fix: 'builds/fixes',
            decision: 'decisions',
            session: 'builds/sessions',
          };
          const folder = folderMap[type] || 'inbox';
          const destDir = join(vaultPath, folder);
          mkdirSync(destDir, { recursive: true });

          const date = new Date().toISOString().split('T')[0];
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          const filename = `${date}-${slug}.md`;
          const filePath = join(destDir, filename);

          const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
          const fm = [
            '---',
            `title: "${title}"`,
            `type: ${type}`,
            `created: "${date}"`,
            `updated: "${date}"`,
            formatYamlTags(tagList),
          ];
          if (project) fm.push(`project: ${project}`);
          fm.push('status: active');
          fm.push('---');

          writeFileSync(filePath, fm.join('\n') + '\n\n' + content);

          // Index immediately so the note is searchable right away
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }

          return { content: [{ type: 'text', text: `Note saved to ${folder}/${filename}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_vault_status',
      description: 'Show vault indexing status — how many notes are indexed, by type and project.',
      schema: {},
      handler: async () => {
        try {
          const stats = getStats();
          const db = getDb();
          const byType = db.prepare(
            'SELECT note_type, COUNT(*) as count FROM vault_files GROUP BY note_type ORDER BY count DESC'
          ).all();
          const byProject = db.prepare(
            'SELECT project, COUNT(*) as count FROM vault_files WHERE project IS NOT NULL GROUP BY project ORDER BY count DESC'
          ).all();
          return { content: [{ type: 'text', text: JSON.stringify({ ...stats, byType, byProject }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_youtube',
      description: 'Capture a YouTube video transcript into the knowledge base. Creates a structured note with metadata.',
      schema: {
        title: z.string().describe('Video title'),
        url: z.string().describe('YouTube URL'),
        transcript: z.string().describe('Video transcript text'),
        channel: z.string().optional().describe('Channel name'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, url, transcript, channel, tags }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureYouTube({ title, url, transcript, channel, tags }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_web',
      description: 'Capture a web article or URL into the knowledge base. Use this whenever you find useful information during research.',
      schema: {
        title: z.string().describe('Article/page title'),
        url: z.string().describe('Source URL'),
        content: z.string().describe('Article content or summary in markdown'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Related project'),
      },
      handler: async ({ title, url, content, tags, project }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureWeb({ title, url, content, tags, project }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_session',
      description: 'Record a terminal/coding session summary — what you tried, what worked, what failed, and lessons learned. IMPORTANT: Call this at the end of every significant debugging or implementation session.',
      schema: {
        goal: z.string().describe('What was the session trying to accomplish'),
        commands_failed: z.string().optional().describe('Commands that failed (markdown list)'),
        commands_worked: z.string().optional().describe('Commands that worked (markdown list)'),
        root_causes: z.string().optional().describe('Root cause analysis'),
        fixes: z.string().optional().describe('Fixes applied'),
        lessons: z.string().optional().describe('Key takeaways and lessons learned'),
        project: z.string().optional().describe('Project name'),
        machine: z.string().optional().describe('Machine/environment identifier'),
      },
      handler: async ({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureSession({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_fix',
      description: 'Record a bug fix with symptom, cause, and resolution. Creates a searchable fix note for future reference.',
      schema: {
        title: z.string().describe('Short title for the fix'),
        symptom: z.string().optional().describe('What the symptom/error was'),
        cause: z.string().optional().describe('Root cause'),
        resolution: z.string().optional().describe('How it was fixed'),
        commands: z.string().optional().describe('Key commands used'),
        project: z.string().optional().describe('Project name'),
        stack: z.string().optional().describe('Tech stack (e.g. node, docker, postgres)'),
      },
      handler: async ({ title, symptom, cause, resolution, commands, project, stack }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureFix({ title, symptom, cause, resolution, commands, project, stack }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_search_smart',
      description: 'Smart search combining keyword matching and semantic similarity. Better than kb_search for conceptual queries like "how do we handle authentication" vs exact keyword matches.',
      schema: {
        query: z.string().describe('Search query — can be a question or topic'),
        limit: z.number().optional().default(10),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const results = await hybridSearch(query, { limit, project, type });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_promote',
      description: 'Analyze a source/inbox note and promote it into structured knowledge. Read the note, classify it, then use kb_write to create promoted notes (research, ideas, workflows, lessons).',
      schema: {
        note_path: z.string().describe('Vault-relative path to the source note (e.g. sources/web/article.md)'),
      },
      handler: async ({ note_path }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          return { content: [{ type: 'text', text: `To promote this note, read it and use kb_write to create the appropriate output notes (research, idea, workflow, lesson, decision) based on what you extract. Source note: ${note_path}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_synthesize',
      description: 'Generate a synthesis of recent knowledge. Connects dots across sources to find themes, opportunities, and improvements.',
      schema: {
        days: z.number().optional().default(7).describe('How many days back to look'),
      },
      handler: async ({ days }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const notes = getRecentNotes(vaultPath, days);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No recent notes to synthesize.' }] };
          const prompt = generateSynthesisPrompt(notes);
          return { content: [{ type: 'text', text: prompt }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_classify',
      description: 'Auto-classify new clippings and inbox notes using AI. Reads unprocessed notes, classifies them (type, tags, project, summary), and updates their frontmatter. Run this after syncing new content.',
      schema: {
        dry_run: z.boolean().optional().default(false).describe('Preview classifications without writing changes'),
      },
      handler: async ({ dry_run }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = await processNewClippings(vaultPath, { dryRun: dry_run });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_context',
      description: 'Get a token-efficient briefing on a topic. Returns summaries and metadata for matching docs WITHOUT full content. Use this BEFORE kb_read to decide which docs are worth reading in full. Saves 90%+ tokens vs reading everything.',
      schema: {
        query: z.string().describe('Topic or question to get context on'),
        limit: z.number().optional().default(15).describe('Max docs to include'),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const db = getDb();
          const ftsResults = searchDocuments(query, limit);

          const briefings = ftsResults.map(r => {
            const vf = db.prepare('SELECT vault_path, note_type, tags, project, summary, key_topics FROM vault_files WHERE document_id = ?').get(r.id);
            return {
              id: r.id,
              title: r.title,
              type: vf?.note_type || r.doc_type,
              tags: vf?.tags || r.tags,
              project: vf?.project || null,
              summary: vf?.summary || r.snippet?.replace(/<\/?mark>/g, '').slice(0, 200),
              key_topics: vf?.key_topics || null,
            };
          });

          if (project || type) {
            let sql = 'SELECT vf.document_id as id, vf.title, vf.note_type, vf.tags, vf.project, vf.summary, vf.key_topics FROM vault_files vf WHERE 1=1';
            const params = [];
            if (project) { sql += ' AND vf.project = ?'; params.push(project); }
            if (type) { sql += ' AND vf.note_type = ?'; params.push(type); }
            sql += ' LIMIT ?';
            params.push(limit);
            const filtered = db.prepare(sql).all(...params);
            const seenIds = new Set(briefings.map(b => b.id));
            for (const f of filtered) {
              if (!seenIds.has(f.id)) {
                briefings.push({ id: f.id, title: f.title, type: f.note_type, tags: f.tags, project: f.project, summary: f.summary, key_topics: f.key_topics });
              }
            }
          }

          const header = `Found ${briefings.length} relevant docs. Use kb_read(id) for full content on any that look useful.`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(briefings, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_safety_check',
      description: 'Review a potentially destructive action before executing it. Searches KB for past incidents, evaluates risk, and returns a safety verdict. Use this before ANY destroy, delete, drop, or force-push operation.',
      schema: {
        action: z.string().describe('The destructive action about to be taken (e.g. "destroy vast.ai instance 12345")'),
        context: z.string().optional().describe('Additional context about why this is being done'),
      },
      handler: async ({ action, context }) => {
        try {
          const result = await reviewDestructiveAction(action, context);
          const prefix = result.safe ? 'SAFE' : 'BLOCKED';
          return { content: [{ type: 'text', text: `[${prefix}] Risk: ${result.risk_level}\n\n${JSON.stringify(result, null, 2)}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ─── Export / Restore tools (Ship 2) ──────────────────────────────────────

    {
      name: 'kb_export',
      description: 'Export vault documents to a portable bundle directory. Supports --all or filtered export. Returns manifest with file list and sha256 hashes. Use dry_run=true to preview without writing.',
      schema: {
        output_path: z.string().describe('Absolute path for the output bundle directory'),
        filter: z.record(z.string(), z.any()).optional().describe('Filter spec JSON object (see docs). Omit for --all export.'),
        dry_run: z.boolean().optional().default(false).describe('Preview only — compute manifest without writing files'),
        archive: z.boolean().optional().default(false).describe('Also create a .tar.gz archive alongside the directory'),
        no_attachments: z.boolean().optional().default(false).describe('Skip binary attachments (markdown only)'),
      },
      handler: async ({ output_path, filter, dry_run, archive, no_attachments }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };

          const { exportDocs } = await import('./export.js');
          const outPath = pathUnder(TOOL_EXPORT_ROOT, output_path);
          const result = await exportDocs({
            outPath,
            dryRun: dry_run,
            all: !filter,
            filter: filter || null,
            vaultPath,
            archive: archive || false,
            noAttachments: no_attachments || false,
          });

          const summary = {
            dry_run: result.dryRun,
            written: result.written,
            out_path: outPath,
            export_root: TOOL_EXPORT_ROOT,
            counts: result.manifest.counts,
            exported_at: result.manifest.exported_at,
            manifest_version: result.manifest.manifest_version,
            filter_expanded: result.manifest.filter_expanded,
            file_count: result.manifest.files.length,
          };
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_restore',
      description: 'Restore a KB bundle into the vault. Runs preflight checks first. Use dry_run=true to preview conflicts without writing. Triggers reindex after restore.',
      schema: {
        bundle_path: z.string().describe('Absolute path to the bundle directory (or .tar.gz)'),
        dry_run: z.boolean().optional().default(false).describe('Preflight only — report conflicts without writing'),
        overwrite: z.boolean().optional().default(false).describe('Overwrite existing files at same vault path'),
        yes: z.boolean().optional().default(false).describe('Skip confirmation prompt'),
        strict: z.boolean().optional().default(false).describe('Fail if vault is non-empty'),
        no_embeddings: z.boolean().optional().default(false).describe('Skip embedding regeneration after restore'),
      },
      handler: async ({ bundle_path, dry_run, overwrite, yes, strict, no_embeddings }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          if (!dry_run && yes !== true) {
            return { content: [{ type: 'text', text: 'Error: Non-dry-run restore requires yes=true' }], isError: true };
          }

          const { restoreFromBundle } = await import('./restore.js');
          const bundlePath = pathUnder(TOOL_EXPORT_ROOT, bundle_path);
          const result = await restoreFromBundle({
            bundlePath,
            vaultPath,
            dryRun: dry_run,
            overwrite: overwrite || false,
            yes: true,   // MCP callers don't have stdin after explicit confirmation
            strict: strict || false,
            noEmbeddings: no_embeddings || false,
          });

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },
  ];
}

export function getHttpToolDefinitions() {
  return getToolDefinitions().filter(tool => !ADMIN_ONLY_TOOLS.has(tool.name));
}
