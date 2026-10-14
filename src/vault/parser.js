import { readNote } from '../utils/frontmatter.js';

// Map folder prefixes to note types
// Map folder prefixes to note types — supports both numbered (00_inbox) and unnumbered (inbox) prefixes
const FOLDER_TYPE_MAP = {
  '00_inbox': 'inbox',
  'inbox': 'inbox',
  '01_sources': 'source',
  'sources': 'source',
  '02_projects': 'project',
  'projects': 'project',
  '03_people': 'person',
  'People': 'person',
  '04_companies': 'company',
  'companies': 'company',
  '05_research': 'research',
  'research': 'research',
  '06_ideas': 'idea',
  'ideas': 'idea',
  '07_workflows': 'workflow',
  'workflows': 'workflow',
  '08_agents': 'lesson',
  'agents': 'lesson',
  '09_decisions': 'decision',
  'decisions': 'decision',
  '10_runbooks': 'runbook',
  '11_builds/sessions': 'session',
  'builds/sessions': 'session',
  '11_builds/fixes': 'fix',
  'builds/fixes': 'fix',
  '11_builds': 'build',
  'builds': 'build',
  '12_archive': 'archive',
  'archive': 'archive',
  'Clippings': 'source',
};

function inferTypeFromPath(vaultPath) {
  // Sort by prefix length descending so '11_builds/sessions' matches before '11_builds'
  const sorted = Object.entries(FOLDER_TYPE_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, type] of sorted) {
    if (vaultPath.startsWith(prefix)) return type;
  }
  return 'note';
}

function inferTitleFromContent(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(t => String(t).trim());
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

export function parseVaultNote(content, vaultPath) {
  const { data: fm, content: body } = readNote(content);

  const title = fm.title || inferTitleFromContent(body) || vaultPath.split('/').pop().replace(/\.md$/, '');
  const type = fm.type || inferTypeFromPath(vaultPath);
  const tags = normalizeTags(fm.tags);

  return {
    title,
    type,
    tags,
    project: fm.project || null,
    status: fm.status || 'active',
    source: fm.source || null,
    confidence: fm.confidence || null,
    created: fm.created || null,
    updated: fm.updated || null,
    body: body.trim(),
    vault_path: vaultPath,
    frontmatter: fm,
  };
}
