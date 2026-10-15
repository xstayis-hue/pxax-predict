import assert from 'node:assert/strict';
import { sortByKickoff } from '../scripts/daily-tiers.mjs';

const input = [
  { id: 'late', matchDate: '2026-10-17T18:00:00Z' },
  { id: 'tomorrow-night', matchDate: '2026-10-16T21:00:00Z' },
  { id: 'tomorrow-early', matchDate: '2026-10-16T09:00:00Z' },
  { id: 'invalid', matchDate: 'bad-date' },
];
const ordered = sortByKickoff(input);
assert.deepEqual(ordered.map(p => p.id), ['tomorrow-early', 'tomorrow-night', 'late', 'invalid']);
assert.deepEqual(input.map(p => p.id), ['late', 'tomorrow-night', 'tomorrow-early', 'invalid'], 'sorting does not mutate feed input');
console.log('Kickoff ordering checks passed');
