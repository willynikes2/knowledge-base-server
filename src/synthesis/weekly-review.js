import { getDb } from '../db.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseVaultNote } from '../vault/parser.js';
import { formatYamlTags } from '../utils/frontmatter.js';

export function getRecentNotes(vaultPath, days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getDb().prepare(`
    SELECT vault_path, title, note_type, project, tags
    FROM vault_files
    WHERE indexed_at > ? AND note_type NOT IN ('inbox', 'archive')
    ORDER BY indexed_at DESC
  `).all(cutoff);

  return rows.map(row => {
    try {
      const content = readFileSync(join(vaultPath, row.vault_path), 'utf-8');
      const parsed = parseVaultNote(content, row.vault_path);
      return { ...row, body: parsed.body.slice(0, 500) };
    } catch {
      return { ...row, body: '' };
    }
  });
}

export function generateSynthesisPrompt(notes) {
  const byProject = {};
  const byType = {};

  for (const note of notes) {
    const proj = note.project || 'general';
    const type = note.note_type || 'other';
    (byProject[proj] = byProject[proj] || []).push(note);
    (byType[type] = byType[type] || []).push(note);
  }

  const sections = [];
  sections.push(`# Weekly Knowledge Synthesis\n`);
  sections.push(`**Period:** Last 7 days | **Notes processed:** ${notes.length}\n`);

  sections.push(`## Notes by Project`);
  for (const [proj, items] of Object.entries(byProject)) {
    sections.push(`### ${proj} (${items.length} notes)`);
    for (const item of items.slice(0, 5)) {
      sections.push(`- **${item.title}** (${item.note_type}): ${item.body.slice(0, 100)}...`);
    }
  }

  sections.push(`\n## Analysis Needed`);
  sections.push(`Based on the notes above, please generate:`);
  sections.push(`1. **Recurring themes** across sources`);
  sections.push(`2. **Business opportunities** or product ideas that emerge`);
  sections.push(`3. **Workflow improvements** suggested by the collected information`);
  sections.push(`4. **Contradictions** between new information and existing assumptions`);
  sections.push(`5. **Action items** for each active project`);

  return sections.join('\n');
}

export function writeSynthesisNote(content, vaultPath) {
  const destDir = join(vaultPath, 'research', 'weekly');
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-weekly-synthesis.md`;

  const fm = [
    '---',
    `title: "Weekly Synthesis ${date}"`,
    `type: synthesis`,
    `created: "${date}"`,
    `updated: "${date}"`,
    formatYamlTags(['synthesis', 'weekly', 'meta']),
    `status: active`,
    '---',
  ].join('\n');

  writeFileSync(join(destDir, filename), `${fm}\n\n${content}\n`);
  return { path: `research/weekly/${filename}` };
}
