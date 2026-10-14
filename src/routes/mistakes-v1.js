// src/routes/mistakes-v1.js — /api/v1 routes for the mistake ledger. The swarm writes through these.
import { Router } from 'express';
import { InputError, recordMistake } from '../mistakes/store.js';
import { mirrorMistake } from '../mistakes/mirror.js';
import { patternsFor } from '../mistakes/delivery.js';
import { vaultPath } from '../mistakes/patterns.js';
import { recordRun } from '../mistakes/metrics.js';
import { learningSummary } from '../mistakes/summary.js';

const router = Router();

// Input the caller can correct is a 400 with the reason; anything else is a 500.
const answer = (res, work) => {
  try { work(); } catch (err) { res.status(err instanceof InputError ? 400 : 500).json({ error: err.message }); }
};

// POST /mistakes — append one record. 201 when written, 200 when its key was already recorded.
router.post('/mistakes', (req, res) => answer(res, () => {
  const result = recordMistake(req.body, { mirror: mirrorMistake });
  res.status(result.duplicate ? 200 : 201).json(result);
}));

// POST /patterns/for — the known pitfalls for one task.
router.post('/patterns/for', (req, res) => answer(res, () => {
  const { task_text, files, run, task } = req.body || {};
  if (typeof task_text !== 'string' || !task_text.trim()) throw new InputError('Missing required field: task_text');
  res.json(patternsFor({ task_text, files, run: typeof run === 'string' ? run : null, task: typeof task === 'string' ? task : null }, { vault: vaultPath() }));
}));

// POST /runs — one row per run and model, for the one-shot rate.
router.post('/runs', (req, res) => answer(res, () => {
  const result = recordRun(req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
}));

// GET /mistakes/metrics — counts and the one-shot rate by model.
router.get('/mistakes/metrics', (req, res) => answer(res, () => res.json(learningSummary())));

export default router;
