import assert from 'node:assert/strict';
import { clampExpectedGoals } from '../scripts/model.mjs';
import { applySoccerLowScoreGuard, normalizeScoreProbabilities } from '../scripts/score-adjustments.mjs';

const broken = { p1: 0, px: 0.06, p2: 0.94, over: 0.61, under: 0.45 };
const normalized = normalizeScoreProbabilities(broken);
assert.ok(Math.abs(normalized.p1 + normalized.px + normalized.p2 - 1) < 1e-12);
assert.ok(Math.abs(normalized.over + normalized.under - 1) < 1e-12);
const fixed = applySoccerLowScoreGuard({ p1: 0, px: 0.06, p2: 0.94, over: 0.61, under: 0.45 }, 0.35, 0.35);
assert.ok(fixed.p1 >= 0.03);
assert.ok(Math.abs(fixed.p1 + fixed.px + fixed.p2 - 1) < 1e-12);
assert.deepEqual(clampExpectedGoals(0, 2.9, 'soccer'), [0.35, 2.9]);
assert.deepEqual(clampExpectedGoals(90, 0, 'soccer'), [4.5, 0.35]);
assert.deepEqual(clampExpectedGoals(10, -3, 'hockey'), [7, 1]);
assert.deepEqual(clampExpectedGoals(220, 0, 'basketball'), [175, 60]);
console.log('8 score bounds and probability checks passed');
