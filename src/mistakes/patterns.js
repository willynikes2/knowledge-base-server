// src/mistakes/patterns.js — patterns (the wiki layer): one vault note per pattern, patterns/<slug>.md.
// The frontmatter is the source of truth. The body is a readable copy, rewritten on every save.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { InputError } from './store.js';

export const STATUSES = ['draft', 'approved', 'rejected', 'retired'];
export const GROUPS = ['teach', 'test'];
export const MAX_RULE_WORDS = 60;
export const STALE_DAYS = 90;
const ID = /^pt_([a-z0-9][a-z0-9-]*)$/;

export const vaultPath = () => process.env.OBSIDIAN_VAULT_PATH || join(homedir(), 'knowledgebase');
export const patternsDir = (vault) => join(vault, 'patterns');
export const countWords = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
export const slugify = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

const fail = (message) => { throw new InputError(message); };
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// Throws an Error naming the first thing that is wrong. Returns the pattern with defaults filled in.
export function validatePattern(p) {
  if (!p || typeof p !== 'object') fail('the pattern must be an object');
  if (typeof p.id !== 'string' || !ID.test(p.id)) fail('id must look like pt_<slug>');
  if (!isText(p.name)) fail('name is required');
  if (!STATUSES.includes(p.status)) fail(`status must be one of ${STATUSES.join(', ')}`);
  if (!isText(p.rule)) fail('rule is required');
  if (countWords(p.rule) > MAX_RULE_WORDS) fail(`rule has ${countWords(p.rule)} words; the limit is ${MAX_RULE_WORDS}`);
  const group = p.group ?? null;
  if (group !== null && !GROUPS.includes(group)) fail('group must be teach, test or empty');
  if ((p.status === 'approved' || p.status === 'retired') && group === null) fail(`a pattern that is ${p.status} needs a group`);
  if (!Array.isArray(p.evidence) || p.evidence.some(e => typeof e !== 'string')) fail('evidence must be a list of mistake ids');
  if (!Array.isArray(p.tags ?? [])) fail('tags must be a list');
  if (!isText(p.bad)) fail('a bad example is required');
  if (!isText(p.good)) fail('a good example is required');
  return {
    id: p.id, name: p.name.trim(), status: p.status, group, rule: p.rule.trim(),
    tags: (p.tags ?? []).map(String), evidence: [...p.evidence],
    bad_from: p.bad_from ?? null, bad: p.bad, good_from: p.good_from ?? null, good: p.good,
    created: p.created ?? null, approved_at: p.approved_at ?? null, updated: p.updated ?? null,
  };
}

const body = (p) => [
  `# ${p.name}`,
  '',
  `**Rule:** ${p.rule}`,
  '',
  `Status: ${p.status}${p.group ? ` (${p.group} group)` : ''}. Evidence: ${p.evidence.join(', ') || 'none'}.`,
  '',
  `## Bad${p.bad_from ? ` (from ${p.bad_from})` : ''}`,
  '',
  p.bad,
  '',
  `## Good${p.good_from ? ` (from ${p.good_from})` : ''}`,
  '',
  p.good,
  '',
  '_This text is generated from the fields above it. Change a pattern with `kb patterns set-status`, not by editing this text._',
  '',
].join('\n');

export function writePattern(vault, input) {
  const p = validatePattern(input);
  const dir = patternsDir(vault);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${p.id.slice(3)}.md`);
  const data = { title: `Pattern: ${p.name}`, type: 'pattern', ...p };
  writeFileSync(`${file}.tmp`, matter.stringify(body(p), data));
  renameSync(`${file}.tmp`, file);
  return p;
}

// Every readable pattern, plus the notes that could not be used and why. A broken note never stops the others.
export function listPatterns(vault) {
  const dir = patternsDir(vault);
  if (!existsSync(dir)) return { patterns: [], skipped: [] };
  const patterns = []; const skipped = [];
  for (const name of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    try {
      const { data } = matter(readFileSync(join(dir, name), 'utf8'));
      const p = validatePattern(data);
      if (p.id !== `pt_${name.slice(0, -3)}`) fail(`id ${p.id} does not match the file name`);
      patterns.push(p);
    } catch (e) {
      skipped.push({ file: name, reason: String(e?.message ?? e).split('\n')[0] });
    }
  }
  return { patterns, skipped };
}

export function getPattern(vault, id) {
  return listPatterns(vault).patterns.find(p => p.id === id) ?? null;
}

export function uniqueSlug(vault, name) {
  const baseSlug = slugify(name) || 'pattern';
  let slug = baseSlug;
  for (let n = 2; existsSync(join(patternsDir(vault), `${slug}.md`)); n += 1) slug = `${baseSlug}-${n}`;
  return slug;
}

// Half the approved patterns are taught to agents; the other half are held back so a later replay can test them on
// agents that never saw them. The smaller group gets the next pattern; a tie is settled by the slug, not by chance.
export function assignGroup(patterns, slug) {
  const count = (g) => patterns.filter(p => p.group === g).length;
  const teach = count('teach'); const test = count('test');
  if (teach !== test) return teach < test ? 'teach' : 'test';
  return createHash('sha256').update(slug).digest()[0] % 2 === 0 ? 'teach' : 'test';
}

// approve: draft → approved. edit: draft → approved with a new rule. reject: draft → rejected. retire: approved → retired.
export function setStatus(vault, id, action, { now = new Date(), rule = null } = {}) {
  const { patterns } = listPatterns(vault);
  const p = patterns.find(x => x.id === id);
  if (!p) fail(`no readable pattern ${id}`);
  const today = now.toISOString();
  const needs = (status) => { if (p.status !== status) fail(`cannot ${action} ${id}: it is ${p.status}, not ${status}`); };
  if (action === 'approve' || action === 'edit') {
    needs('draft');
    if (action === 'edit') { if (!isText(rule)) fail('edit needs the new rule text'); p.rule = rule.trim(); }
    p.status = 'approved';
    p.group = assignGroup(patterns.filter(x => x.id !== id), id.slice(3)); // fixed here, never changed again
    p.approved_at = today;
  } else if (action === 'reject') {
    needs('draft');
    p.status = 'rejected';
  } else if (action === 'retire') {
    needs('approved');
    p.status = 'retired';
  } else {
    fail(`unknown action ${action}`);
  }
  p.updated = today;
  return writePattern(vault, p);
}

// Approved teach patterns that no task has received for 90 days. Test-group patterns are never delivered, so they are
// never stale. Nothing is retired automatically: the operator decides on the next approval page.
export function stalePatterns(patterns, deliveries, now = new Date()) {
  const lastUsed = new Map();
  for (const d of deliveries) for (const id of d.patterns ?? []) if (!lastUsed.has(id) || d.at > lastUsed.get(id)) lastUsed.set(id, d.at);
  const cutoff = now.getTime() - STALE_DAYS * 86_400_000;
  return patterns.filter(p => p.status === 'approved' && p.group === 'teach')
    .filter(p => { const t = Date.parse(lastUsed.get(p.id) ?? p.approved_at ?? ''); return Number.isFinite(t) && t < cutoff; });
}
