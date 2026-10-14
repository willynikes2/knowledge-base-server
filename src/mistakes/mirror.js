// src/mistakes/mirror.js — copy a ledger record into the KB as a searchable document (doc_type "mistake").
// The ledger file stays the source of truth; this copy only makes the record findable with kb_search.
import { ingestText } from '../ingest.js';

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

export function mirrorMistake(record) {
  const { title, content, tags } = mistakeDocument(record);
  return ingestText(title, content, { doc_type: 'mistake', tags, source: record.id });
}
