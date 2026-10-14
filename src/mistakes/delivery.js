// src/mistakes/delivery.js — hand an agent the few approved patterns that match its task (the use layer).
import { join } from 'path';
import { appendJsonl, mistakesHome, readJsonl } from './store.js';
import { listPatterns } from './patterns.js';

export const MAX_PATTERNS = 3;
export const MIN_SCORE = 3;
export const deliveriesPath = () => join(mistakesHome(), 'deliveries.jsonl');
export const readDeliveries = () => readJsonl(deliveriesPath()).rows;

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'when', 'its', 'has', 'have',
  'into', 'must', 'never', 'always', 'each', 'one', 'all', 'any', 'can', 'use', 'src', 'test', 'tests', 'task', 'file', 'files',
  'add', 'new', 'should', 'does', 'will', 'then', 'than', 'only', 'before', 'after', 'instead']);

// Lower-case words of 3+ letters, plural "s" dropped, common words removed. File paths split on every separator.
export function tokens(text) {
  const out = new Set();
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

// A tag word found in the task counts 2; a word of the name or rule counts 1.
export function scorePattern(pattern, words) {
  const tagWords = tokens(pattern.tags.join(' '));
  let score = 0;
  for (const w of tagWords) if (words.has(w)) score += 2;
  for (const w of tokens(`${pattern.name} ${pattern.rule}`)) if (!tagWords.has(w) && words.has(w)) score += 1;
  return score;
}

export function pitfallsMarkdown(patterns) {
  if (!patterns.length) return '';
  const lines = ['## Known pitfalls', '', 'Earlier reviews caught these mistakes on similar work. Do not repeat them:', ''];
  for (const p of patterns) {
    lines.push(`- **${p.name}.** ${p.rule}`, '', '  Done right:', '', ...p.good.trim().split('\n').map(l => `      ${l}`), '');
  }
  return lines.join('\n').trimEnd();
}

// At most 3 approved teach-group patterns, best match first; none when nothing reaches the minimum score.
// Every non-empty delivery is logged, so unused patterns can be found later.
export function patternsFor({ task_text, files = [], run = null, task = null }, { vault, now = new Date() }) {
  const words = new Set([...tokens(task_text), ...tokens((Array.isArray(files) ? files : []).join(' '))]);
  const picked = listPatterns(vault).patterns
    .filter(p => p.status === 'approved' && p.group === 'teach')
    .map(p => ({ p, score: scorePattern(p, words) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    .slice(0, MAX_PATTERNS)
    .map(x => ({ id: x.p.id, name: x.p.name, rule: x.p.rule, good: x.p.good }));
  if (picked.length) appendJsonl(deliveriesPath(), { at: now.toISOString(), run, task, patterns: picked.map(p => p.id) });
  return { patterns: picked, markdown: pitfallsMarkdown(picked) };
}
