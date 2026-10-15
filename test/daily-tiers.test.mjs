import assert from 'node:assert/strict';
import { assignDailyTiers, MIN_DECIMAL_ODDS } from '../scripts/daily-tiers.mjs';
import { normalizeScoreProbabilities, applySoccerLowScoreGuard } from '../scripts/score-adjustments.mjs';
import { clampExpectedGoals } from '../scripts/model.mjs';

const scores = normalizeScoreProbabilities({ p1: 0, px: 0.06, p2: 0.94, over: 0.61, under: 0.45 });
assert.ok(Math.abs(scores.p1 + scores.px + scores.p2 - 1) < 1e-12);
assert.ok(Math.abs(scores.over + scores.under - 1) < 1e-12);
assert.ok(scores.over >= 0 && scores.over <= 1 && scores.under >= 0 && scores.under <= 1);
assert.deepEqual(applySoccerLowScoreGuard({ p1: 0, px: 0.06, p2: 0.94, over: 0.61, under: 0.45 }, 0.35, 0.35).p1, 0.03);
assert.deepEqual(clampExpectedGoals(0, 2.9, 'soccer'), [0.35, 2.9]);
assert.deepEqual(clampExpectedGoals(90, 0, 'soccer'), [4.5, 0.35]);
assert.deepEqual(clampExpectedGoals(10, -3, 'hockey'), [7, 1]);
assert.deepEqual(clampExpectedGoals(220, 0, 'basketball'), [175, 60]);

const valid = Array.from({ length: 10 }, (_, i) => ({ id: `valid${i}`, confidence: 70 - i, value: i < 5, edge: 0.15 - i * 0.01, odds: 1.8 }));
const slots = assignDailyTiers(valid);
assert.equal(slots.free.length, 5);
assert.equal(slots.pro.length, 5);
assert.deepEqual(slots.shortfall, { free: 0, pro: 0 });
assert.equal(new Set([...slots.free, ...slots.pro].map(p => p.id)).size, 10);
assert.ok(slots.pro.every(p => p.value && p.confidence >= 60 && p.odds >= MIN_DECIMAL_ODDS));
assert.equal(MIN_DECIMAL_ODDS, 1.4);
const belowOdds = assignDailyTiers([
  { id: 'low', confidence: 80, value: true, edge: 0.2, odds: 1.39 },
  { id: 'minimum', confidence: 70, value: true, edge: 0.1, odds: 1.4 },
  { id: 'free-low', confidence: 75, value: false, odds: 1.2 },
]);
assert.deepEqual(belowOdds.free.map(p => p.id), ['minimum']);
assert.equal(belowOdds.pro.length, 0);
assert.deepEqual(belowOdds.shortfall, { free: 2, pro: 3 });
const noValues = assignDailyTiers(valid.map(p => ({ ...p, value: false })));
assert.equal(noValues.free.length, 5);
assert.equal(noValues.pro.length, 0);
assert.deepEqual(noValues.shortfall, { free: 0, pro: 3 });
const fiveFreeThreePro = assignDailyTiers(Array.from({length:8},(_,i)=>({id:`mix${i}`,confidence:70-i,value:i<3,edge:0.1,odds:2})));
assert.equal(fiveFreeThreePro.free.length,5);
assert.equal(fiveFreeThreePro.pro.length,3);
const tooFew = assignDailyTiers(valid.slice(0, 4));
assert.deepEqual(tooFew.shortfall, { free: 0, pro: 2 });
const weak = assignDailyTiers([{ id: 'weak', confidence: 54, value: true }]);
assert.deepEqual(weak.shortfall, { free: 3, pro: 3 });
console.log('3–5 score and tier allocation checks passed');
