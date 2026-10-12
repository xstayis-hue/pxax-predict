import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publicFeed = JSON.parse(readFileSync('data/predictions.json', 'utf8'));
const proFeed = JSON.parse(readFileSync('data/pro-feed.json', 'utf8'));
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() + 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const generated = [new Date(publicFeed.generated || '').getTime(), new Date(proFeed.generated || '').getTime()];
assert.equal(publicFeed.date, proFeed.date, 'public and PRO feeds must have the same date');
assert.ok([today, yesterday].includes(publicFeed.date), 'feed date must be today or yesterday by Moscow date');
assert.ok(generated.every(Number.isFinite), 'both feeds need generated timestamps');
assert.ok(Math.abs(generated[0] - generated[1]) <= 60_000, 'public and PRO feeds must be generated together');
assert.ok(Array.isArray(publicFeed.predictions) && Array.isArray(proFeed.predictions), 'both feeds need prediction arrays');
assert.equal(Number(publicFeed.count), publicFeed.predictions.length, 'public count must match public predictions');
assert.equal(Number(proFeed.count), proFeed.predictions.length, 'PRO count must match PRO predictions');
assert.ok(publicFeed.predictions.every(p => Number(p.confidence) >= 55), 'Free predictions must respect the 55% model threshold');
assert.ok(proFeed.predictions.every(p => p.tier === 'pro'), 'PRO feed must contain only PRO tier predictions');
assert.ok(proFeed.predictions.length <= 3 && proFeed.predictions.every(p => Number(p.confidence) >= 60 && p.value === true), 'PRO feed must contain at most three qualified value predictions');
assert.ok(publicFeed.predictions.every(p => !p.tier || p.tier === 'free'), 'public feed must not contain PRO tier predictions');
const freeIds = new Set(publicFeed.predictions.map(p => String(p.id)));
assert.ok(proFeed.predictions.every(p => !freeIds.has(String(p.id))), 'a match cannot appear in both tiers');
for (const [feed, key] of [[publicFeed, 'free'], [proFeed, 'pro']]) {
  const target = Number(feed.targets?.[key] ?? 3);
  const shortfall = Number(feed.shortfall?.[key] ?? Math.max(0, target - feed.predictions.length));
  assert.equal(shortfall, Math.max(0, target - feed.predictions.length), `${key} shortfall must reflect actual output`);
}
console.log(`Daily feeds valid for ${publicFeed.date}: free=${publicFeed.count}, pro=${proFeed.count}, shortfalls free=${publicFeed.shortfall?.free ?? Math.max(0, 3 - publicFeed.count)}, pro=${proFeed.shortfall?.pro ?? Math.max(0, 3 - proFeed.count)}`);
