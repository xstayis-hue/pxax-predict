import assert from 'node:assert/strict';
import { gradeMarket, settleTotal } from '../scripts/settlement.mjs';
import { isValidBasketballTotalLine, outcomesFromNormal } from '../scripts/model.mjs';

const cases = [
  ['ТБ 2.5', 2, 1, 'hit'],
  ['ТБ 2.5', 1, 1, 'miss'],
  ['ТБ 3', 1, 2, 'push'],
  ['ТМ 3', 1, 2, 'push'],
  ['ТБ 2.25', 1, 1, 'half_loss'],
  ['ТБ 2.25', 1, 2, 'hit'],
  ['ТБ 2.75', 1, 2, 'half_win'],
  ['ТМ 2.75', 1, 2, 'half_loss'],
  ['ТБ 2,5', 2, 1, 'hit'],
];
for (const [market, home, away, expected] of cases) {
  assert.equal(gradeMarket(market, home, away)?.result, expected, `${market}, ${home}:${away}`);
}
assert.equal(settleTotal('ТБ 2.25', 1, 1, 2).profitUnits, -0.5);
assert.equal(settleTotal('ТБ 2.75', 1, 2, 2).profitUnits, 0.5);
assert.equal(settleTotal('ТБ 3', 1, 2, 1.9).profitUnits, 0);
assert.equal(settleTotal('ТБ 2.5', 2, 1).profitUnits, null);
assert.equal(gradeMarket('ТБ 2.5', 'bad', 1), null);
assert.equal(gradeMarket('unknown', 1, 1), null);

assert.equal(isValidBasketballTotalLine(220.5, 1.91, 1.91), true);
assert.equal(isValidBasketballTotalLine(null, 1.91, 1.91), false);
assert.equal(isValidBasketballTotalLine(0, 1.91, 1.91), false);
assert.equal(isValidBasketballTotalLine(220, 1.91, null), false);
assert.equal(isValidBasketballTotalLine(500, 1.91, 1.91), false);
assert.equal(outcomesFromNormal(110, 108, null).over, null);
assert.equal(outcomesFromNormal(110, 108, 220).over != null, true);

console.log(`${cases.length + 15} settlement and NBA line checks passed`);
