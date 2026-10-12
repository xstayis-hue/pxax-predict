import assert from 'node:assert/strict';
import { quotaStatus, visibleHistoryCount } from '../scripts/history-ui.mjs';

assert.equal(quotaStatus(5, 3), '5 / 3');
assert.equal(quotaStatus(3, 3), '3 / 3');
assert.equal(quotaStatus(2, 3), '2 / 3 · недобор 1');
const ids = ['1', '2', '3', '4'];
const visible = ['1', '2', '3'];
const shown = Math.min(3, ids.filter(id => visible.includes(id)).length);
assert.equal(quotaStatus(shown, 3), '3 / 3');
const rows = [
  { id: 1, kind: 'free', date: '2026-10-12' },
  { id: 2, kind: 'pro', date: '2026-10-12' },
  { id: 3, kind: 'free', date: '2026-10-11', preseason: true },
  { id: 4, kind: 'free', date: '2026-10-05' },
  { id: 5, kind: 'pro', date: '2026-09-28' },
];
assert.equal(visibleHistoryCount(rows, 'all', '2026-09-29'), 3);
assert.equal(visibleHistoryCount(rows, 'free', '2026-09-29'), 2);
assert.equal(visibleHistoryCount(rows, 'pro', '2026-09-29'), 1);
console.log('7 quota labels and history counts passed');
