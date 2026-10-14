// src/mistakes/metrics.js — one row per run and model: how many tasks passed their first review (the one-shot rate).
import { join } from 'path';
import { InputError, appendJsonl, mistakesHome, readJsonl } from './store.js';

export const RUN_SOURCES = ['swarm', 'sdd'];
export const runsPath = () => join(mistakesHome(), 'runs.jsonl');

const fail = (message) => { throw new InputError(message); };
const whole = (value, name) => { if (!Number.isInteger(value) || value < 0) fail(`${name} must be a whole number of 0 or more`); return value; };
const label = (value, name) => { if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`); return value.trim().slice(0, 200); };

export function validateRun(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('the run must be an object');
  if (!RUN_SOURCES.includes(input.source)) fail(`source must be one of ${RUN_SOURCES.join(', ')}`);
  const attempted = whole(input.attempted, 'attempted');
  const firstPass = whole(input.first_pass, 'first_pass');
  if (firstPass > attempted) fail('first_pass cannot be more than attempted');
  const delivered = input.patterns_delivered ?? [];
  if (!Array.isArray(delivered) || delivered.some(p => typeof p !== 'string')) fail('patterns_delivered must be a list of pattern ids');
  const row = {
    at: now.toISOString(), source: input.source, project: label(input.project, 'project'), run: label(input.run, 'run'),
    model: label(input.model, 'model'), attempted, first_pass: firstPass, fix_rounds: whole(input.fix_rounds ?? 0, 'fix_rounds'),
    patterns_delivered: [...new Set(delivered)],
  };
  return { ...row, key: `${row.source}:${row.project}:${row.run}:${row.model}` };
}

// A run is written once per model: sending it again changes nothing.
export function recordRun(input, { now = new Date() } = {}) {
  const row = validateRun(input, { now });
  if (readJsonl(runsPath()).rows.some(r => r.key === row.key)) return { key: row.key, duplicate: true };
  appendJsonl(runsPath(), row);
  return { key: row.key, duplicate: false };
}

const rate = (firstPass, attempted) => (attempted > 0 ? Math.round((firstPass / attempted) * 1000) / 1000 : null);

// Per model: its runs in time order and its totals. A run with no tasks has a rate of null, never 0 or 1.
export function oneShotSeries() {
  const byModel = new Map();
  for (const r of readJsonl(runsPath()).rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push({ at: r.at, source: r.source, project: r.project, run: r.run, attempted: r.attempted, first_pass: r.first_pass,
      fix_rounds: r.fix_rounds, patterns_delivered: r.patterns_delivered?.length ?? 0, rate: rate(r.first_pass, r.attempted) });
  }
  return [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([model, runs]) => {
    const attempted = runs.reduce((n, r) => n + r.attempted, 0);
    const firstPass = runs.reduce((n, r) => n + r.first_pass, 0);
    return { model, runs, attempted, first_pass: firstPass, rate: rate(firstPass, attempted) };
  });
}
