import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { searchDocuments, listDocuments, getDocument, getStats, getDb } from './db.js';
import { ingestText } from './ingest.js';
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

const ADMIN_ONLY_TOOLS = new Set([
  'kb_classify',
  'kb_promote',
  'kb_synthesize',
  'kb_safety_check',
  'kb_capture_youtube',
  'bus_send',
  'bus_inbox',
  'bus_wait',
]);

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
  ];
}

export function getHttpToolDefinitions() {
  return getToolDefinitions().filter(tool => !ADMIN_ONLY_TOOLS.has(tool.name));
}
