// src/cli/mistakes-cli.js — `kb mistakes …` and `kb patterns …`
import { readFileSync } from 'fs';
import { currentMistakes, recordMistake } from '../mistakes/store.js';
import { mirrorMistake } from '../mistakes/mirror.js';
import { importSdd } from '../mistakes/import-sdd.js';
import { importSeed } from '../mistakes/import-seed.js';
import { recordRun } from '../mistakes/metrics.js';
import { learningSummary } from '../mistakes/summary.js';
import { STATUSES, listPatterns, vaultPath } from '../mistakes/patterns.js';
import { draftPatterns, unassignedMistakes } from '../mistakes/draft.js';
import { applyReply, writeApprovalPage } from '../mistakes/approval.js';

export const MISTAKES_USAGE = `Usage: kb mistakes <command>
  import-sdd <ledger-dir> --project=<name> --client-ok [--repo=<path>]   Import a subagent build's review findings
  import-seed <catalogue.json>                                            Import the mined-mistakes catalogue (weak evidence)
  record <record.json>                                                    Record one mistake from a JSON file
  record-run <run.json>                                                   Record a run's first-pass numbers
  list [--unassigned] [--json]                                            List current mistakes
  stats [--json]                                                          Counts and the one-shot rate by model`;

export const PATTERNS_USAGE = `Usage: kb patterns <command>
  draft [--dry-run]            Propose patterns from mistakes that repeat (calls a model)
  list [--status=<status>]     List patterns (${STATUSES.join(', ')})
  page [--out=<file.html>]     Write the approval page and remember its numbering
  set-status "<reply>"         Apply a reply, e.g. "approve 1 and 3, edit 2: <rule>, reject 4"`;

const flag = (args, name) => args.includes(`--${name}`);
const option = (args, name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const positional = (args) => args.filter(a => !a.startsWith('--'));
const usage = (text) => { throw new Error(`\n${text}`); };
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read JSON from ${file}: ${e.message}`); }
};
const pct = (rate) => (rate === null ? 'n/a' : `${Math.round(rate * 100)}%`);

// Pattern notes are vault notes; reindexing makes a new or changed one searchable. Never fatal.
async function reindexVault(vault) {
  try { const { indexVault } = await import('../vault/indexer.js'); await indexVault(vault); } catch { /* the note is saved; search catches up on the next reindex */ }
}

export async function mistakesCmd(args, { log = console.log, mirror = mirrorMistake } = {}) {
  const [sub, target] = positional(args);
  switch (sub) {
    case 'import-sdd': {
      if (!target) usage(MISTAKES_USAGE);
      const r = importSdd(target, { project: option(args, 'project'), clientOk: flag(args, 'client-ok'), repo: option(args, 'repo'), mirror });
      return log(`Imported ${r.added} mistakes from ${r.ledgers} ledger(s); ${r.duplicates} were already there; ${r.weak} have no fix commit (weak evidence).`);
    }
    case 'import-seed': {
      if (!target) usage(MISTAKES_USAGE);
      const r = importSeed(target, { mirror });
      log(`Imported ${r.added} of ${r.rows} catalogue rows; ${r.duplicates} were already there; ${r.skipped.length} skipped.`);
      for (const s of r.skipped) log(`  row ${s.row}: ${s.reason}`);
      return undefined;
    }
    case 'record': {
      if (!target) usage(MISTAKES_USAGE);
      return log(JSON.stringify(recordMistake(readJson(target), { mirror })));
    }
    case 'record-run': {
      if (!target) usage(MISTAKES_USAGE);
      return log(JSON.stringify(recordRun(readJson(target))));
    }
    case 'list': {
      const { mistakes, bad } = currentMistakes();
      const shown = flag(args, 'unassigned') ? unassignedMistakes(mistakes, listPatterns(vaultPath()).patterns) : mistakes;
      if (flag(args, 'json')) return log(JSON.stringify(shown, null, 2));
      for (const m of shown) log(`${m.id}  ${m.at.slice(0, 10)}  ${m.source.padEnd(6)} ${m.evidence.padEnd(6)} ${m.project} / ${m.task}: ${m.finding.replace(/\s+/g, ' ').slice(0, 90)}`);
      log(`${shown.length} mistake(s)${bad ? `; ${bad} unreadable line(s) in the ledger` : ''}.`);
      return undefined;
    }
    case 'stats': {
      const s = learningSummary();
      if (flag(args, 'json')) return log(JSON.stringify(s, null, 2));
      log(`Mistakes: ${s.mistakes.total} (${Object.entries(s.mistakes.by_source).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); strong evidence ${s.mistakes.by_evidence.strong ?? 0}, weak ${s.mistakes.by_evidence.weak ?? 0}.`);
      log(`Patterns: ${s.patterns.draft ?? 0} draft, ${s.patterns.approved ?? 0} approved (${s.patterns.teach} taught, ${s.patterns.test} held back), ${s.patterns.rejected ?? 0} rejected, ${s.patterns.retired ?? 0} retired.`);
      if (s.mistakes.unreadable_lines || s.patterns.unreadable_notes) log(`Unreadable: ${s.mistakes.unreadable_lines} ledger line(s), ${s.patterns.unreadable_notes} pattern note(s).`);
      if (!s.one_shot.length) log('One-shot rate: no runs recorded yet.');
      for (const m of s.one_shot) log(`One-shot rate, ${m.model}: ${pct(m.rate)} (${m.first_pass} of ${m.attempted} tasks passed their first review, ${m.runs.length} run(s)).`);
      return undefined;
    }
    default:
      return usage(MISTAKES_USAGE);
  }
}

export async function patternsCmd(args, { log = console.log, llm = undefined, reindex = reindexVault } = {}) {
  const [sub, target] = positional(args);
  const vault = vaultPath();
  switch (sub) {
    case 'draft': {
      const dryRun = flag(args, 'dry-run');
      const r = await draftPatterns({ vault, dryRun, ...(llm ? { llm } : {}) });
      if (!r.sent) return log('Nothing to sort: fewer than 2 tasks have unassigned mistakes.');
      log(`Sorted ${r.sent} unassigned mistakes: ${r.drafted.length} draft(s)${dryRun ? ' (dry run, nothing written)' : ''}, ${r.skipped.length} suggestion(s) refused.`);
      for (const d of r.drafted) log(`  draft ${d.id} — ${d.name} (${d.evidence} mistakes)`);
      for (const s of r.skipped) log(`  refused "${s.name}": ${s.reason}`);
      if (r.drafted.length && !dryRun) { await reindex(vault); log('Next: kb patterns page'); }
      return undefined;
    }
    case 'list': {
      const status = option(args, 'status');
      if (status && !STATUSES.includes(status)) throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
      const { patterns, skipped } = listPatterns(vault);
      for (const p of patterns.filter(x => !status || x.status === status)) log(`${p.id}  ${p.status}${p.group ? `/${p.group}` : ''}  ${p.name} — ${p.rule}`);
      for (const s of skipped) log(`unreadable ${s.file}: ${s.reason}`);
      return undefined;
    }
    case 'page': {
      const r = writeApprovalPage({ vault, outFile: option(args, 'out') });
      return log(`Wrote ${r.file}: ${r.drafts} new pattern(s), ${r.stale} unused, ${r.skipped} unreadable note(s).`);
    }
    case 'set-status': {
      if (!target) usage(PATTERNS_USAGE);
      const out = applyReply(positional(args).slice(1).join(' '), { vault });
      for (const o of out) log(`${o.n}. ${o.id}: ${o.status}${o.status === 'approved' ? ` (${o.group === 'teach' ? 'taught to agents' : 'held back for testing'})` : ''}`);
      await reindex(vault);
      return undefined;
    }
    default:
      return usage(PATTERNS_USAGE);
  }
}
