// src/mistakes/summary.js — the numbers shown by `kb mistakes stats`, the API and the dashboard.
import { currentMistakes } from './store.js';
import { listPatterns, vaultPath } from './patterns.js';
import { oneShotSeries } from './metrics.js';

const tally = (items, key) => items.reduce((acc, x) => { acc[x[key]] = (acc[x[key]] ?? 0) + 1; return acc; }, {});

export function learningSummary({ vault = vaultPath() } = {}) {
  const { mistakes, bad } = currentMistakes();
  const { patterns, skipped } = listPatterns(vault);
  return {
    mistakes: { total: mistakes.length, unreadable_lines: bad, by_source: tally(mistakes, 'source'), by_evidence: tally(mistakes, 'evidence') },
    patterns: { ...tally(patterns, 'status'), teach: patterns.filter(p => p.status === 'approved' && p.group === 'teach').length,
      test: patterns.filter(p => p.status === 'approved' && p.group === 'test').length, unreadable_notes: skipped.length },
    one_shot: oneShotSeries(),
  };
}
