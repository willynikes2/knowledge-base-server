// src/mistakes/import-seed.js — import the October 2026 catalogue of mined mistakes (KB #3557) as weak-evidence records.
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { currentMistakes, recordMistake } from './store.js';

const hash12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

const part = (label, value) => (typeof value === 'string' && value.trim() ? `${label}: ${value.trim()}` : null);

// One catalogue row → one record. No fix commit is kept, so every seed record is weak evidence.
export function seedRecord(row) {
  if (!row || typeof row !== 'object' || row.kb_id === undefined || typeof row.title !== 'string' || !row.title.trim()) {
    throw new Error('a seed row needs kb_id and title');
  }
  const finding = [row.title.trim(), part('Symptom', row.symptom), part('Wrong first guess', row.wrong_first_guess),
    part('Root cause', row.root_cause), part('Fix', row.fix)].filter(Boolean).join('\n');
  return {
    source: 'seed', project: typeof row.project === 'string' && row.project.trim() ? row.project.trim() : 'unknown',
    task: row.title.trim(), task_text_ref: `kb:${row.kb_id}`, model: null, caught_by: 'operator', finding,
    tags: [row.kind, row.pattern].filter(v => typeof v === 'string' && v.trim()).map(v => v.split(/\s+/).slice(0, 6).join(' ')),
    // One KB document can hold several mistakes, so the key names the document and the mistake.
    client_ok: true, key: `seed:${String(row.kb_id).replace(/[^A-Za-z0-9_.-]+/g, '-')}:${hash12(row.title.trim())}`,
  };
}

export function importSeed(file, { now = () => new Date(), mirror = null } = {}) {
  let rows;
  try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read the catalogue ${file}: ${e.message}`); }
  if (!Array.isArray(rows)) throw new Error('the catalogue must be a JSON array');
  const result = { rows: rows.length, added: 0, duplicates: 0, skipped: [], ...(mirror ? { unmirrored: 0 } : {}) };
  // Rows already in the ledger under the older key (one per document) are recognised by their document and title.
  // Such a row is sent again under the key it already has, so it counts as a repeat and a missing KB copy is retried.
  const known = new Map(currentMistakes().mistakes.filter(m => m.source === 'seed' && m.key).map(m => [`${m.task_text_ref}|${m.task}`, m.key]));
  rows.forEach((row, i) => {
    try {
      const fresh = seedRecord(row);
      const record = { ...fresh, key: known.get(`${fresh.task_text_ref}|${fresh.task}`) ?? fresh.key };
      const r = recordMistake(record, { now: now(), mirror });
      known.set(`${record.task_text_ref}|${record.task}`, record.key);
      if (r.duplicate) result.duplicates += 1; else result.added += 1;
      if (mirror && !r.mirrored) result.unmirrored += 1;
    } catch (e) {
      result.skipped.push({ row: i, reason: e.message });
    }
  });
  return result;
}
