import assert from 'node:assert/strict';
import { evaluateArchivedPredictions } from '../scripts/backtest-evaluator.mjs';

const predictions = [
  { id: '1', market: 'П1', modelProb: 0.7, odds: 1.8, matchDate: '2026-10-01T12:00:00Z', snapshotGenerated: '2026-10-01T10:00:00Z' },
  { id: '2', market: 'ТБ 2.5', modelProb: 0.6, odds: 1.9, matchDate: '2026-10-02T12:00:00Z', snapshotGenerated: '2026-10-02T10:00:00Z' },
  { id: '3', market: 'П2', modelProb: 0.8, matchDate: '2026-10-03T12:00:00Z', snapshotGenerated: '2026-10-03T10:00:00Z' },
  { id: '4', market: 'П1', modelProb: 0.9, matchDate: '2026-10-04T12:00:00Z', snapshotGenerated: '2026-10-04T10:00:00Z' },
  { id: '5', market: 'ТБ 2.25', modelProb: 0.65, odds: 1.9, matchDate: '2026-10-05T12:00:00Z', snapshotGenerated: '2026-10-05T10:00:00Z' },
];
const results = [
  { id: '1', date: '2026-10-01', score: '2:1', result: 'hit', kind: 'free' },
  { id: '2', date: '2026-10-02', score: '1:1', result: 'miss', kind: 'free' },
  { id: '3', date: '2026-10-03', score: '0:2', result: 'hit', kind: 'free' },
  { id: '4', date: '2026-10-04', score: '1:0', result: 'hit', kind: 'free', preseason: true },
  { id: '5', date: '2026-10-05', score: '1:1', result: 'half_loss', kind: 'free' },
];
const report = evaluateArchivedPredictions(predictions, results);
assert.equal(report.mode, 'archived-production');
assert.equal(report.resolved, 4);
assert.equal(report.signals, 3);
assert.equal(report.hits, 2);
assert.equal(report.losses, 1.5);
assert.equal(report.hitRate, 0.5714);
assert.equal(report.brier, 0.1633);
assert.equal(report.halfResults, 1);
assert.equal(report.roi, -23.33);
assert.equal(report.coverage.includesPro, false);
console.log('8 archived evaluation checks passed');
