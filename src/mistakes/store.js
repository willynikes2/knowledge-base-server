// src/mistakes/store.js — the append-only mistake ledger (raw layer).
// Records are never edited: a correction is a new record whose `supersedes` names the old one.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { redactSecrets } from './redact.js';

export const SOURCES = ['swarm', 'sdd', 'factory', 'manual', 'seed'];
export const MAX_DIFF_BYTES = 4096;
const CAUGHT_BY = /^(review(:[\w.-]{1,60})?|test|operator)$/;
const KEY = /^[A-Za-z0-9_.:/#@-]{1,300}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MISTAKE_ID = /^mk_[0-9A-HJKMNP-TV-Z]{26}$/;
const PATTERN_ID = /^pt_[a-z0-9][a-z0-9-]*$/;

// Resolved on every call so a test (or the operator) can point KB_MISTAKES_HOME somewhere else.
export const mistakesHome = () => process.env.KB_MISTAKES_HOME || join(homedir(), '.knowledge-base', 'mistakes');
export const ledgerPath = () => join(mistakesHome(), 'ledger.jsonl');

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = now; let time = '';
  for (let i = 0; i < 10; i += 1) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = randomBytes(16); let rand = '';
  for (let i = 0; i < 16; i += 1) rand += B32[bytes[i] % 32];
  return time + rand;
}

// One appendFileSync per record keeps a record on one line even with several writers (O_APPEND).
// A file whose last byte is not a newline was cut off mid-write; the new record starts on its own line.
export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  let prefix = '';
  if (existsSync(file)) {
    const fd = openSync(file, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size > 0) { const last = Buffer.alloc(1); readSync(fd, last, 0, 1, size - 1); if (last[0] !== 0x0a) prefix = '\n'; }
    } finally { closeSync(fd); }
  }
  appendFileSync(file, `${prefix}${JSON.stringify(obj)}\n`);
}

export function readJsonl(file) {
  if (!existsSync(file)) return { rows: [], bad: 0 };
  const rows = []; let bad = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { rows, bad };
}

// Thrown for input the caller can correct. Anything else (a full disk, a locked file) is a plain Error.
export class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const text = (value, name, max, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') { if (required) fail(`${name} is required`); return null; }
  if (typeof value !== 'string') fail(`${name} must be a string`);
  const clean = redactSecrets(value).trim();
  if (!clean) { if (required) fail(`${name} is required`); return null; }
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

// The key decides whether a record is a repeat, so it is compared exactly: never trimmed, cut or redacted.
// A key that would need any of that is refused, so two different keys can never become the same one.
const keyOf = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !KEY.test(value)) fail('key may use letters, digits and _ . : / # @ - only (at most 300 characters)');
  return value;
};

function truncateBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  const marker = '\n[truncated]';
  let out = s.slice(0, max);
  while (Buffer.byteLength(out) + Buffer.byteLength(marker) > max) out = out.slice(0, -64);
  return out + marker;
}

export function normaliseTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) fail('tags must be an array of strings');
  const out = [];
  for (const raw of tags) {
    const tag = String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 10);
}

// Returns a complete record or throws an Error whose message says which field is wrong.
export function validateMistake(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('the record must be an object');
  if (!SOURCES.includes(input.source)) fail(`source must be one of ${SOURCES.join(', ')}`);
  if (input.client_ok !== true) {
    fail(input.client_ok === false
      ? "client_ok is false: records from client jobs need the client's permission"
      : 'client_ok is required (true only when the code owner allows keeping this record)');
  }
  if (typeof input.caught_by !== 'string' || !CAUGHT_BY.test(input.caught_by)) fail('caught_by must be review, review:<model>, test or operator');
  const fixCommit = input.fix_commit ?? null;
  if (fixCommit !== null && (typeof fixCommit !== 'string' || !COMMIT.test(fixCommit))) fail('fix_commit must be a 7-40 character lowercase hex commit id');
  const line = input.line ?? null;
  if (line !== null && (!Number.isInteger(line) || line < 0)) fail('line must be a whole number of 0 or more');
  const pattern = input.pattern ?? null;
  if (pattern !== null && (typeof pattern !== 'string' || !PATTERN_ID.test(pattern))) fail('pattern must look like pt_<slug>');
  const supersedes = input.supersedes ?? null;
  if (supersedes !== null && (typeof supersedes !== 'string' || !MISTAKE_ID.test(supersedes))) fail('supersedes must be a mistake id (mk_…)');
  const fixDiff = input.fix_diff ?? null;
  if (fixDiff !== null && typeof fixDiff !== 'string') fail('fix_diff must be a string');
  return {
    id: `mk_${ulid(now.getTime())}`,
    at: now.toISOString(),
    source: input.source,
    project: text(input.project, 'project', 100, { required: true }),
    task: text(input.task, 'task', 200, { required: true }),
    task_text_ref: text(input.task_text_ref, 'task_text_ref', 300),
    model: text(input.model, 'model', 100),
    caught_by: input.caught_by,
    finding: text(input.finding, 'finding', 2000, { required: true }),
    file: text(input.file, 'file', 300),
    line,
    fix_commit: fixCommit,
    // Redact first: a secret that straddles the 4 KB cut would otherwise survive as a fragment.
    fix_diff: fixDiff === null || !fixDiff.trim() ? null : truncateBytes(redactSecrets(fixDiff), MAX_DIFF_BYTES),
    guard_test: text(input.guard_test, 'guard_test', 300),
    tags: normaliseTags(input.tags),
    pattern,
    supersedes,
    client_ok: true,
    evidence: fixCommit ? 'strong' : 'weak',
    key: keyOf(input.key),
  };
}

// Appends one record. `key` makes a writer safe to re-run: a second record with the same key is not written.
// `mirror(record)` copies it into the KB as a searchable document; the ledger is the source of truth, so a failed
// mirror is reported, never fatal.
export function recordMistake(input, { now = new Date(), mirror = null } = {}) {
  const record = validateMistake(input, { now });
  const { rows } = readJsonl(ledgerPath());
  if (record.key) {
    const same = rows.find(r => r.key === record.key);
    // A repeat is not written again, but its KB copy is made now if an earlier attempt failed (the copy is made once).
    if (same) return { id: same.id, duplicate: true, mirrored: copy(mirror, same) };
  }
  if (record.supersedes && !rows.some(r => r.id === record.supersedes)) fail(`supersedes names an unknown record: ${record.supersedes}`);
  appendJsonl(ledgerPath(), record);
  return { id: record.id, duplicate: false, mirrored: copy(mirror, record) };
}

function copy(mirror, record) {
  if (!mirror) return false;
  try { mirror(record); return true; } catch { return false; }
}

// The ledger as it stands today: every record that no later record supersedes.
export function currentMistakes() {
  const { rows, bad } = readJsonl(ledgerPath());
  const replaced = new Set(rows.map(r => r.supersedes).filter(Boolean));
  return { mistakes: rows.filter(r => !replaced.has(r.id)), bad };
}
