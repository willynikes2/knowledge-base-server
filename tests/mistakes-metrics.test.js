// tests/mistakes-metrics.test.js
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oneShotSeries, recordRun, runsPath, validateRun } from '../src/mistakes/metrics.js';
import { readJsonl } from '../src/mistakes/store.js';

const run = (extra = {}) => ({ source: 'swarm', project: 'browser-agent-demo', run: 'live-demo', model: 'claude-sonnet', attempted: 6, first_pass: 4, fix_rounds: 2, patterns_delivered: [], ...extra });

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'kb-metrics-')); process.env.KB_MISTAKES_HOME = home; });
afterEach(() => { delete process.env.KB_MISTAKES_HOME; rmSync(home, { recursive: true, force: true }); });

describe('validateRun', () => {
  it('builds the row and its key', () => {
    const r = validateRun(run({ patterns_delivered: ['pt_a', 'pt_a', 'pt_b'] }), { now: new Date('2026-10-14T00:00:00Z') });
    assert.strictEqual(r.key, '["swarm","browser-agent-demo","live-demo","claude-sonnet"]');
    assert.deepStrictEqual(r.patterns_delivered, ['pt_a', 'pt_b']);
    assert.strictEqual(r.at, '2026-10-14T00:00:00.000Z');
  });

  it('names the field that is wrong', () => {
    assert.throws(() => validateRun(run({ source: 'manual' })), /source must be one of swarm, sdd/);
    assert.throws(() => validateRun(run({ attempted: 2, first_pass: 3 })), /first_pass cannot be more than attempted/);
    assert.throws(() => validateRun(run({ attempted: 1.5 })), /attempted must be a whole number/);
    assert.throws(() => validateRun(run({ first_pass: -1 })), /first_pass must be a whole number/);
    assert.throws(() => validateRun(run({ model: ' ' })), /model is required/);
    assert.throws(() => validateRun(run({ patterns_delivered: 'pt_a' })), /patterns_delivered must be a list/);
    assert.throws(() => validateRun([]), /must be an object/);
  });

  it('defaults fix_rounds to 0', () => {
    const { fix_rounds: _omit, ...noRounds } = run();
    assert.strictEqual(validateRun(noRounds).fix_rounds, 0);
  });
});

describe('recordRun', () => {
  it('writes a run once per model', () => {
    assert.strictEqual(recordRun(run()).duplicate, false);
    assert.strictEqual(recordRun(run({ first_pass: 6 })).duplicate, true);
    assert.strictEqual(recordRun(run({ model: 'codex' })).duplicate, false);
    assert.strictEqual(readJsonl(runsPath()).rows.length, 2);
  });
});

describe('oneShotSeries', () => {
  it('is empty with no runs', () => {
    assert.deepStrictEqual(oneShotSeries(), []);
  });

  it('groups by model, orders runs by time and totals the rate', () => {
    recordRun(run({ run: 'second', attempted: 4, first_pass: 4 }), { now: new Date('2026-10-20T00:00:00Z') });
    recordRun(run({ run: 'first', attempted: 6, first_pass: 3 }), { now: new Date('2026-10-13T00:00:00Z') });
    recordRun(run({ run: 'first', model: 'codex', attempted: 2, first_pass: 1 }), { now: new Date('2026-10-13T00:00:00Z') });
    const series = oneShotSeries();
    assert.deepStrictEqual(series.map(s => s.model), ['claude-sonnet', 'codex']);
    assert.deepStrictEqual(series[0].runs.map(r => [r.run, r.rate]), [['first', 0.5], ['second', 1]]);
    assert.deepStrictEqual([series[0].attempted, series[0].first_pass, series[0].rate], [10, 7, 0.7]);
    assert.strictEqual(series[1].rate, 0.5);
  });

  it('gives a run with no tasks a rate of null, not 0', () => {
    recordRun(run({ attempted: 0, first_pass: 0 }));
    const [s] = oneShotSeries();
    assert.strictEqual(s.runs[0].rate, null);
    assert.strictEqual(s.rate, null);
  });
});
