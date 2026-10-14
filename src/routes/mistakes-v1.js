// src/routes/mistakes-v1.js — /api/v1 routes for the mistake ledger. The swarm writes through these.
import { Router } from 'express';
import { InputError, recordMistake } from '../mistakes/store.js';
import { mirrorMistake } from '../mistakes/mirror.js';
import { patternsFor } from '../mistakes/delivery.js';
import { vaultPath } from '../mistakes/patterns.js';
import { recordRun } from '../mistakes/metrics.js';
import { learningSummary } from '../mistakes/summary.js';

const router = Router();

// Input the caller can correct is a 400 with the reason. Anything else is a 500 with a plain message: the real one
// can name files and folders of this machine, so it goes to the server log only.
const answer = (res, work) => {
  try { work(); } catch (err) {
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    console.error('[mistakes]', err);
    return res.status(500).json({ error: 'The server could not complete this request.' });
  }
};

// These routes write the ledger and its logs, so only the swarm's own key may use them. Other API keys and
// signed-in connector users are refused; people record and correct mistakes locally (the kb CLI, the local MCP tool).
const swarmOnly = (req, res, next) => (req.apiService === 'swarm' ? next() : res.status(403).json({ error: 'This route is for the swarm key (KB_API_KEY_SWARM) only.' }));
router.use(['/mistakes', '/patterns/for', '/runs'], swarmOnly);
const short = (value) => (typeof value === 'string' ? value.slice(0, 200) : null);

// POST /mistakes — append one record. 201 when written, 200 when its key was already recorded.
router.post('/mistakes', (req, res) => answer(res, () => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw new InputError('the record must be an object');
  // A record sent here is always a swarm record, and it cannot hide an existing one.
  if (body.supersedes !== undefined && body.supersedes !== null) throw new InputError('supersedes cannot be set over HTTP; record a correction with the kb CLI or the local MCP tool');
  const result = recordMistake({ ...body, source: 'swarm' }, { mirror: mirrorMistake });
  res.status(result.duplicate ? 200 : 201).json(result);
}));

// POST /patterns/for — the known pitfalls for one task.
router.post('/patterns/for', (req, res) => answer(res, () => {
  const { task_text, files, run, task } = req.body || {};
  if (typeof task_text !== 'string' || !task_text.trim()) throw new InputError('Missing required field: task_text');
  res.json(patternsFor({ task_text, files, run: short(run), task: short(task) }, { vault: vaultPath() }));
}));

// POST /runs — one row per run and model, for the one-shot rate.
router.post('/runs', (req, res) => answer(res, () => {
  const result = recordRun(req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
}));

// GET /mistakes/metrics — counts and the one-shot rate by model.
router.get('/mistakes/metrics', (req, res) => answer(res, () => res.json(learningSummary())));

export default router;
