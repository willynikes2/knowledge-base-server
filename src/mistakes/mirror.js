// src/mistakes/mirror.js — copy a ledger record into the KB as a searchable document (doc_type "mistake").
// The ledger file stays the source of truth; this copy only makes the record findable with kb_search.
import { ingestText } from '../ingest.js';
import { getDb } from '../db.js';

export function mistakeDocument(r) {
  const title = `Mistake: ${r.project} — ${r.task}`.slice(0, 200);
  const content = [
    `# Mistake in ${r.project}: ${r.task}`,
    '',
    r.finding,
    '',
    `Caught by: ${r.caught_by}. Model: ${r.model ?? 'not recorded'}. Evidence: ${r.evidence}. Ledger id: ${r.id}.`,
    r.file ? `File: ${r.file}${r.line ? `:${r.line}` : ''}` : null,
    r.fix_commit ? `Fix commit: ${r.fix_commit}` : null,
    r.guard_test ? `Guard test: ${r.guard_test}` : null,
    r.supersedes ? `Supersedes: ${r.supersedes}` : null,
    r.fix_diff ? `\n## Fix\n\n\`\`\`diff\n${r.fix_diff}\n\`\`\`` : null,
  ].filter(line => line !== null).join('\n');
  return { title, content, tags: ['mistake', r.source, ...r.tags] };
}

// Makes the copy once: a record that already has its document is left alone, so retries are safe.
export function mirrorMistake(record) {
  const existing = getDb().prepare("SELECT id FROM documents WHERE doc_type = 'mistake' AND source = ? LIMIT 1").get(record.id);
  if (existing) return existing;
  const { title, content, tags } = mistakeDocument(record);
  return ingestText(title, content, { doc_type: 'mistake', tags, source: record.id });
}
