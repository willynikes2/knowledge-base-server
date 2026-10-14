// src/mistakes/approval.js — the page the operator reads to approve drafts, and the reply that applies their decision.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { currentMistakes, mistakesHome } from './store.js';
import { MAX_RULE_WORDS, STALE_DAYS, countWords, listPatterns, setStatus, stalePatterns } from './patterns.js';
import { readDeliveries } from './delivery.js';

export const approvalMapPath = () => join(mistakesHome(), 'approval-latest.json');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

const CSS = `:root{--bg:#f7f8fa;--panel:#ffffff;--text:#1a2230;--muted:#5b6676;--line:#d9dee6;--accent:#0d6e5c;--warn:#8a5a00;--code:#f0f2f5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0b1020;--panel:#141b2b;--text:#f1f5f9;--muted:#9aa7b8;--line:#263147;--accent:#42d6b0;--warn:#f0b24a;--code:#0f1524}}
:root[data-theme="dark"]{--bg:#0b1020;--panel:#141b2b;--text:#f1f5f9;--muted:#9aa7b8;--line:#263147;--accent:#42d6b0;--warn:#f0b24a;--code:#0f1524}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:32px 0 8px}
.muted{color:var(--muted)}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.n{display:inline-block;min-width:2em;font-weight:700;color:var(--accent)}.rule{font-size:1.05rem;margin:8px 0}
pre{background:var(--code);border-radius:6px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:.85rem;margin:6px 0}
table{width:100%;border-collapse:collapse;font-size:.85rem}td,th{text-align:left;vertical-align:top;padding:6px 8px 6px 0;border-top:1px solid var(--line)}
.scroll{overflow-x:auto}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;margin-right:4px;font-size:.8rem}
.how{border-left:4px solid var(--accent)}.warn{color:var(--warn)}code{background:var(--code);padding:1px 4px;border-radius:4px}`;

function draftCard(n, p, byId) {
  const rows = p.evidence.map(id => { const m = byId.get(id); return m
    ? `<tr><td>${esc(m.project)}</td><td>${esc(m.task)}</td><td>${esc(m.evidence)}${m.fix_commit ? ` · <code>${esc(m.fix_commit.slice(0, 7))}</code>` : ''}</td><td>${esc(clip(m.finding, 220))}</td></tr>`
    : `<tr><td colspan="4" class="muted">${esc(id)} is no longer in the ledger</td></tr>`; }).join('');
  return `<div class="card"><h3><span class="n">${n}.</span> ${esc(p.name)}</h3>
<p class="rule">${esc(p.rule)}</p>
<p class="muted">${countWords(p.rule)} of ${MAX_RULE_WORDS} words · ${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('') || 'no tags'}</p>
<p><strong>The mistake</strong> <span class="muted">(from a real review)</span></p><pre>${esc(p.bad)}</pre>
<p><strong>Done right</strong> <span class="muted">(from the real fix)</span></p><pre>${esc(p.good)}</pre>
<p><strong>Seen ${p.evidence.length} times</strong></p>
<div class="scroll"><table><tr><th>Project</th><th>Task</th><th>Evidence</th><th>What the reviewer found</th></tr>${rows}</table></div></div>`;
}

// Numbers on the page are the numbers used in the reply: drafts first, then the unused patterns.
export function buildApprovalPage({ drafts, stale, mistakes, skipped = [], lastUsed = new Map(), now = new Date() }) {
  const byId = new Map(mistakes.map(m => [m.id, m]));
  const items = [...drafts.map(p => ({ id: p.id, kind: 'draft' })), ...stale.map(p => ({ id: p.id, kind: 'stale' }))].map((x, i) => ({ n: i + 1, ...x }));
  const date = now.toISOString().slice(0, 10);
  const draftHtml = drafts.length
    ? drafts.map((p, i) => draftCard(i + 1, p, byId)).join('\n')
    : '<p class="muted">No new patterns to review.</p>';
  const staleHtml = stale.length ? `<h2>Not used for ${STALE_DAYS} days</h2><p class="muted">These approved patterns matched no task lately. Retire one if it no longer helps; otherwise leave it.</p>
${stale.map((p, i) => `<div class="card"><h3><span class="n">${drafts.length + i + 1}.</span> ${esc(p.name)}</h3><p class="rule">${esc(p.rule)}</p>
<p class="muted">Approved ${esc(String(p.approved_at ?? '').slice(0, 10))} · last given to a task: ${esc(lastUsed.get(p.id)?.slice(0, 10) ?? 'never')}</p></div>`).join('\n')}` : '';
  const skippedHtml = skipped.length ? `<h2 class="warn">Notes that could not be read</h2><div class="card"><ul>${skipped.map(s => `<li><code>${esc(s.file)}</code>: ${esc(s.reason)}</li>`).join('')}</ul></div>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pattern approvals</title><style>${CSS}</style></head><body><main>
<h1>Pattern approvals</h1><p class="muted">${esc(date)} · ${drafts.length} new · ${stale.length} unused</p>
<div class="card how"><strong>How to reply.</strong> Use the numbers below, for example:<br><code>approve 1 and 3, edit 2: &lt;your wording of the rule&gt;, reject 4${stale.length ? `, retire ${drafts.length + 1}` : ''}</code>
<p class="muted">Approve: agents may be given this rule. Edit: approve it with your wording (at most ${MAX_RULE_WORDS} words). Reject: never propose it again from these mistakes. Anything you leave out stays as it is. Half of the approved patterns are held back from agents, so a later test can measure whether patterns help.</p></div>
<h2>New patterns</h2>
${draftHtml}
${staleHtml}
${skippedHtml}
</main></body></html>
`;
  return { html, mapping: { at: now.toISOString(), items } };
}

export function writeApprovalPage({ vault, now = new Date(), outFile = null }) {
  const { patterns, skipped } = listPatterns(vault);
  const deliveries = readDeliveries();
  const lastUsed = new Map();
  for (const d of deliveries) for (const id of d.patterns ?? []) if (!lastUsed.has(id) || d.at > lastUsed.get(id)) lastUsed.set(id, d.at);
  const drafts = patterns.filter(p => p.status === 'draft');
  const stale = stalePatterns(patterns, deliveries, now);
  const { html, mapping } = buildApprovalPage({ drafts, stale, mistakes: currentMistakes().mistakes, skipped, lastUsed, now });
  mkdirSync(mistakesHome(), { recursive: true });
  const file = outFile ?? join(mistakesHome(), `approval-${now.toISOString().slice(0, 10)}.html`);
  writeFileSync(file, html);
  writeFileSync(`${approvalMapPath()}.tmp`, `${JSON.stringify(mapping, null, 2)}\n`);
  renameSync(`${approvalMapPath()}.tmp`, approvalMapPath());
  return { file, drafts: drafts.length, stale: stale.length, skipped: skipped.length };
}

// "approve 1 and 3, edit 2: <rule>, reject 4, retire 5" → [{ action, n, rule? }]. An action word only counts when a
// number follows it, so a rule may contain the words approve, reject, retire or edit.
export function parseReply(text) {
  const s = String(text ?? '');
  const marks = [...s.matchAll(/\b(approve|reject|retire|edit)\s+(?=\d)/gi)].map(m => ({ action: m[1].toLowerCase(), end: m.index + m[0].length, start: m.index }));
  if (!marks.length) throw new Error('no decision found; write for example "approve 1 and 3, edit 2: <new rule>, reject 4"');
  if (s.slice(0, marks[0].start).trim()) throw new Error(`cannot read "${s.slice(0, marks[0].start).trim()}" before the first decision`);
  const out = [];
  marks.forEach((mark, i) => {
    const segment = s.slice(mark.end, marks[i + 1]?.start ?? s.length);
    if (mark.action === 'edit') {
      const m = segment.match(/^(\d+)\s*:\s*([\s\S]*)$/);
      const rule = m?.[2].replace(/(?:\s*[,;]|\s+and)?\s*$/i, '').trim();
      if (!m || !rule) throw new Error('edit needs one number, a colon and the new rule, for example "edit 2: Check the result before using it."');
      out.push({ action: 'edit', n: Number(m[1]), rule });
    } else {
      if (!/^[\d\s,;&.]*(?:and[\d\s,;&.]*)*$/i.test(segment)) throw new Error(`cannot read "${segment.trim()}" after ${mark.action}`);
      for (const n of segment.match(/\d+/g) ?? []) out.push({ action: mark.action, n: Number(n) });
    }
  });
  const seen = new Set();
  for (const d of out) { if (seen.has(d.n)) throw new Error(`number ${d.n} is used twice`); seen.add(d.n); }
  return out;
}

// Applies a reply against the numbers of the latest page. Everything is checked first; nothing changes if any part is wrong.
export function applyReply(text, { vault, now = new Date() }) {
  if (!existsSync(approvalMapPath())) throw new Error('no approval page has been made yet; run "kb patterns page" first');
  const { items } = JSON.parse(readFileSync(approvalMapPath(), 'utf8'));
  const decisions = parseReply(text);
  const { patterns } = listPatterns(vault);
  const plan = decisions.map(d => {
    const item = items.find(x => x.n === d.n);
    if (!item) throw new Error(`there is no number ${d.n} on the latest page`);
    const p = patterns.find(x => x.id === item.id);
    if (!p) throw new Error(`number ${d.n} (${item.id}) can no longer be read`);
    const wanted = d.action === 'retire' ? 'approved' : 'draft';
    if (p.status !== wanted) throw new Error(`cannot ${d.action} number ${d.n} (${p.name}): it is ${p.status}, not ${wanted}`);
    if (d.action === 'edit' && countWords(d.rule) > MAX_RULE_WORDS) throw new Error(`the new rule for number ${d.n} has ${countWords(d.rule)} words; the limit is ${MAX_RULE_WORDS}`);
    return { ...d, id: item.id };
  });
  return plan.map(d => { const p = setStatus(vault, d.id, d.action, { now, rule: d.rule ?? null }); return { n: d.n, id: d.id, action: d.action, status: p.status, group: p.group }; });
}
