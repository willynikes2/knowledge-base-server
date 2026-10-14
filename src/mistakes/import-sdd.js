// src/mistakes/import-sdd.js — import the review findings of a subagent build from its ledger folder
// (.superpowers/sdd/<build>/): one mistake per finding in each fix brief. Safe to run again.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import { recordMistake } from './store.js';

const BRIEF = /^(?:task-(\d+)|final)-fix(?:es)?(\d*)\.md$/;
// "## 1. Title", "## A. Title", "## R2. Title" or "## Ruling: title" starts a finding. Other headings (Parked, Tests, Done when) do not.
const HEADING = /^(?:(?:\d+|[A-Z]\d*)\.\s+\S|Ruling:\s*\S)/;
// The older style: "C1. **Title.** details" paragraphs under severity headings.
const ITEM = /^([A-Z]\d+)\.\s+\*\*(.+?)\*\*/;
const MAX_TEXT = 1500;

const hash12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const firstPath = (s) => s.match(/`([\w./-]+\/[\w./-]+\.\w+|[\w-]+\.(?:js|ts|tsx|jsx|mjs|py|md|json|sh|yml|yaml|css|html))`/)?.[1] ?? null;

// A ledger folder, or a folder of ledger folders.
export function ledgerDirs(dir) {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
  if (existsSync(join(root, 'progress.md'))) return [root];
  return readdirSync(root).map(n => join(root, n)).filter(p => statSync(p).isDirectory() && existsSync(join(p, 'progress.md'))).sort();
}

export function findingsInBrief(md) {
  const sections = md.split(/^##\s+/m).slice(1).map(s => { const nl = s.indexOf('\n'); return { title: (nl < 0 ? s : s.slice(0, nl)).trim(), body: nl < 0 ? '' : s.slice(nl + 1).trim() }; });
  const headed = sections.filter(s => HEADING.test(s.title));
  if (headed.length) return headed.map(s => ({ title: s.title, text: clip(`${s.title}\n${s.body}`.trim()) }));
  const items = []; let current = null;
  for (const line of md.split('\n')) {
    const m = line.match(ITEM);
    if (m) { current = { title: `${m[1]}. ${m[2].replace(/\.$/, '')}`, lines: [line] }; items.push(current); }
    else if (/^##\s/.test(line)) current = null;
    else if (current) current.lines.push(line);
  }
  return items.map(i => ({ title: i.title, text: clip(i.lines.join('\n').trim()) }));
}

// The commit that fixed a round, read from progress.md: { sha, range }. range is true when the ledger names several
// commits (a..b); sha is then the last one. null when the ledger does not say.
export function fixCommit(progress, taskNumber, round) {
  const sha = '([0-9a-f]{7,40})(?:\\.\\.([0-9a-f]{7,40}))?';
  const tries = taskNumber === null
    ? (round > 1
      ? [`^(?:- )?Final[- ]fix${round}\\b[^\\n]*?[Ii]mplemented ${sha}`]
      : [`^(?:- )?Final[- ]fix(?:es)?\\b(?!\\d)[^\\n]*?[Ii]mplemented ${sha}`, `^(?:- )?Fix wave committed ${sha}`])
    : [`^(?:- )?Task ${taskNumber}: fix round ${round}(?:/\\d+)? implemented ${sha}`, `^(?:- )?Task ${taskNumber}: fix round ${round}(?:/\\d+)?[^\\n]*?commits ${sha}`];
  for (const t of tries) { const m = progress.match(new RegExp(t, 'm')); if (m) return { sha: m[2] ?? m[1], range: Boolean(m[2]) }; }
  return null;
}

export function parseSddLedger(dir) {
  const progress = readFileSync(join(dir, 'progress.md'), 'utf8');
  const planFile = join(dir, 'plan-path');
  const plan = (existsSync(planFile) ? readFileSync(planFile, 'utf8').trim() : '') || progress.match(/^# SDD ledger — plan:\s*(\S+)/m)?.[1] || null;
  const model = progress.match(/Implementers?:\s*([\w.-]+)/i)?.[1] ?? null;
  const findings = [];
  for (const name of readdirSync(dir).sort()) {
    const m = name.match(BRIEF);
    if (!m) continue;
    const taskNumber = m[1] ? Number(m[1]) : null;
    const round = m[2] ? Number(m[2]) : 1;
    const commit = fixCommit(progress, taskNumber, round);
    for (const f of findingsInBrief(readFileSync(join(dir, name), 'utf8'))) {
      findings.push({ task: taskNumber === null ? 'FINAL' : `T${taskNumber}`, taskNumber, round, title: f.title, text: f.text, file: firstPath(f.text), fixCommit: commit?.sha ?? null, fixRange: commit?.range ?? false, brief: name });
    }
  }
  return { plan, model, findings };
}

// The diff and the test file of a fix commit, when the commit can still be read from `repo`. null fields otherwise.
export function commitEvidence(repo, sha, { run = execFileSync } = {}) {
  const git = (args) => run('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  try {
    const files = git(['show', '--format=', '--name-only', sha]).split('\n').map(s => s.trim()).filter(Boolean);
    const diff = git(['show', '--format=', '--no-color', sha]);
    const guard = files.find(f => /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$|\.spec\.[a-z]+$|_test\.[a-z]+$/.test(f)) ?? null;
    return { diff: diff.trim() ? diff : null, guardTest: guard };
  } catch {
    return { diff: null, guardTest: null };
  }
}

// repo: where the fix commits can be read (defaults to the folder that holds .superpowers). clientOk must be true:
// a build for a client is only imported with the client's permission.
export function importSdd(dir, { project, clientOk = false, repo = null, now = () => new Date(), mirror = null, evidence = commitEvidence } = {}) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('a project name is required (--project=<name>)');
  if (clientOk !== true) throw new Error("refused: pass --client-ok only when the code owner allows keeping these records (always fine for the operator's own projects)");
  const result = { ledgers: 0, added: 0, duplicates: 0, weak: 0, ...(mirror ? { unmirrored: 0 } : {}) };
  const keyProject = project.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  for (const ledger of ledgerDirs(dir)) {
    result.ledgers += 1;
    const { plan, model, findings } = parseSddLedger(ledger);
    const gitRepo = repo ?? resolve(ledger, '..', '..', '..');
    const cache = new Map();
    for (const f of findings) {
      // A range names several commits; the last one's diff alone would be misleading evidence, so none is kept.
      const single = f.fixCommit && !f.fixRange;
      if (single && !cache.has(f.fixCommit)) cache.set(f.fixCommit, evidence(gitRepo, f.fixCommit));
      const ev = single ? cache.get(f.fixCommit) : { diff: null, guardTest: null };
      const r = recordMistake({
        source: 'sdd', project: project.trim(), task: f.task, model, caught_by: 'review',
        task_text_ref: plan && f.taskNumber !== null ? `${plan}#task-${f.taskNumber}` : plan,
        finding: f.text, file: f.file, fix_commit: f.fixCommit, fix_diff: ev.diff, guard_test: ev.guardTest,
        tags: [], client_ok: true, key: `sdd:${keyProject}:${f.task}:fix${f.round}:${hash12(f.text)}`,
      }, { now: now(), mirror });
      if (r.duplicate) result.duplicates += 1; else { result.added += 1; if (!f.fixCommit) result.weak += 1; }
      if (mirror && !r.mirrored) result.unmirrored += 1;
    }
  }
  return result;
}
