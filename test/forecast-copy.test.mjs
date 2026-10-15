import assert from 'node:assert/strict';
import { proValueExplanation } from '../scripts/forecast-copy.mjs';

assert.equal(
  proValueExplanation(true, 0.21, 0.74, 0.61),
  ' Value-сигнал PRO: вероятность модели 74% против справедливой вероятности линии 61% (расчётный перевес +21%).',
);
assert.equal(proValueExplanation(false, 0.21, 0.74, 0.61), '');
assert.equal(proValueExplanation(true, null, 0.74, 0.61), '');
assert.equal(proValueExplanation(true, 0.21, 0.74, null), '');
console.log('PRO-only value explanation checks passed');
