import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { getRecentNotes, generateSynthesisPrompt } from './synthesis/weekly-review.js';

export async function start() {
  const server = new McpServer({
    name: 'knowledge-base',
    version: '1.0.0',
  });

  server.tool(
    'kb_search',
    'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets.',
    {
      query: z.string().describe('Full-text search query'),
      limit: z.number().optional().default(20).describe('Maximum number of results to return'),
    },
    async ({ query, limit }) => {
      try {
        const results = searchDocuments(query, limit);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_list',
    'List documents in the knowledge base, optionally filtered by type or tag.',
    {
      type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
      tag: z.string().optional().describe('Filter by tag'),
      limit: z.number().optional().default(50).describe('Maximum number of results to return'),
    },
    async ({ type, tag, limit }) => {
      try {
        const results = listDocuments({ type, tag, limit });
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_read',
    'Read the full content of a specific document by its ID.',
    {
      id: z.number().describe('Document ID'),
    },
    async ({ id }) => {
      try {
        const doc = getDocument(id);
        if (!doc) {
          return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_ingest',
    'Ingest a new document into the knowledge base from text content.',
    {
      title: z.string().describe('Document title'),
      content: z.string().describe('Document text content'),
      tags: z.string().optional().describe('Comma-separated tags'),
    },
    async ({ title, content, tags }) => {
      try {
        const doc = ingestText(title, content, tags);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_write',
    'Write a new note to the Obsidian vault. Use this to capture knowledge, ideas, lessons, or research that should persist across sessions. The note will be synced to all devices via Obsidian Sync.',
    {
      title: z.string().describe('Note title'),
      content: z.string().describe('Markdown content (body text, no frontmatter needed)'),
      type: z.enum(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'session', 'capture'])
        .optional().default('capture').describe('Note type — determines vault folder destination'),
      tags: z.string().optional().describe('Comma-separated tags'),
      project: z.string().optional().describe('Project name (e.g. kb-system, media-ai, example-sensor)'),
    },
    async ({ title, content, type, tags, project }) => {
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
          `tags: [${tagList.join(', ')}]`,
        ];
        if (project) fm.push(`project: ${project}`);
        fm.push('status: active');
        fm.push('---');

        writeFileSync(filePath, fm.join('\n') + '\n\n' + content);

        // Index immediately so the note is searchable right away
        try { indexVault(vaultPath); } catch { /* non-fatal */ }

        return { content: [{ type: 'text', text: `Note saved to ${folder}/${filename}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_vault_status',
    'Show vault indexing status — how many notes are indexed, by type and project.',
    {},
    async () => {
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
    }
  );

  server.tool(
    'kb_capture_youtube',
    'Capture a YouTube video transcript into the knowledge base. Creates a structured note with metadata.',
    {
      title: z.string().describe('Video title'),
      url: z.string().describe('YouTube URL'),
      transcript: z.string().describe('Video transcript text'),
      channel: z.string().optional().describe('Channel name'),
      tags: z.string().optional().describe('Comma-separated tags'),
    },
    async ({ title, url, transcript, channel, tags }) => {
      try {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        const result = captureYouTube({ title, url, transcript, channel, tags }, vaultPath);
        try { indexVault(vaultPath); } catch { /* non-fatal */ }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_capture_web',
    'Capture a web article or URL into the knowledge base. Use this whenever you find useful information during research.',
    {
      title: z.string().describe('Article/page title'),
      url: z.string().describe('Source URL'),
      content: z.string().describe('Article content or summary in markdown'),
      tags: z.string().optional().describe('Comma-separated tags'),
      project: z.string().optional().describe('Related project'),
    },
    async ({ title, url, content, tags, project }) => {
      try {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        const result = captureWeb({ title, url, content, tags, project }, vaultPath);
        try { indexVault(vaultPath); } catch { /* non-fatal */ }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_capture_session',
    'Record a terminal/coding session summary — what you tried, what worked, what failed, and lessons learned. IMPORTANT: Call this at the end of every significant debugging or implementation session.',
    {
      goal: z.string().describe('What was the session trying to accomplish'),
      commands_failed: z.string().optional().describe('Commands that failed (markdown list)'),
      commands_worked: z.string().optional().describe('Commands that worked (markdown list)'),
      root_causes: z.string().optional().describe('Root cause analysis'),
      fixes: z.string().optional().describe('Fixes applied'),
      lessons: z.string().optional().describe('Key takeaways and lessons learned'),
      project: z.string().optional().describe('Project name'),
      machine: z.string().optional().describe('Machine/environment identifier'),
    },
    async ({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }) => {
      try {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        const result = captureSession({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }, vaultPath);
        try { indexVault(vaultPath); } catch { /* non-fatal */ }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_capture_fix',
    'Record a bug fix with symptom, cause, and resolution. Creates a searchable fix note for future reference.',
    {
      title: z.string().describe('Short title for the fix'),
      symptom: z.string().optional().describe('What the symptom/error was'),
      cause: z.string().optional().describe('Root cause'),
      resolution: z.string().optional().describe('How it was fixed'),
      commands: z.string().optional().describe('Key commands used'),
      project: z.string().optional().describe('Project name'),
      stack: z.string().optional().describe('Tech stack (e.g. node, docker, postgres)'),
    },
    async ({ title, symptom, cause, resolution, commands, project, stack }) => {
      try {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        const result = captureFix({ title, symptom, cause, resolution, commands, project, stack }, vaultPath);
        try { indexVault(vaultPath); } catch { /* non-fatal */ }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_search_smart',
    'Smart search combining keyword matching and semantic similarity. Better than kb_search for conceptual queries like "how do we handle authentication" vs exact keyword matches.',
    {
      query: z.string().describe('Search query — can be a question or topic'),
      limit: z.number().optional().default(10),
      project: z.string().optional().describe('Filter by project'),
      type: z.string().optional().describe('Filter by note type'),
    },
    async ({ query, limit, project, type }) => {
      try {
        const results = await hybridSearch(query, { limit, project, type });
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_promote',
    'Analyze a source/inbox note and promote it into structured knowledge. Read the note, classify it, then use kb_write to create promoted notes (research, ideas, workflows, lessons).',
    {
      note_path: z.string().describe('Vault-relative path to the source note (e.g. sources/web/article.md)'),
    },
    async ({ note_path }) => {
      try {
        const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
        if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
        return { content: [{ type: 'text', text: `To promote this note, read it and use kb_write to create the appropriate output notes (research, idea, workflow, lesson, decision) based on what you extract. Source note: ${note_path}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'kb_synthesize',
    'Generate a synthesis of recent knowledge. Connects dots across sources to find themes, opportunities, and improvements.',
    {
      days: z.number().optional().default(7).describe('How many days back to look'),
    },
    async ({ days }) => {
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
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow direct execution
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('mcp.js')) {
  start().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
