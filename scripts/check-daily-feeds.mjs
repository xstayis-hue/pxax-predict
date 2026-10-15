import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_DECIMAL_ODDS } from './daily-tiers.mjs';

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
assert.equal(Number(publicFeed.freeCount ?? publicFeed.count), publicFeed.predictions.length, 'public freeCount must match public prediction array');
assert.equal(Number(publicFeed.proCount), Number(proFeed.proCount ?? proFeed.count), 'public proCount must match companion PRO feed');
assert.equal(Number(proFeed.count), proFeed.predictions.length, 'PRO count must match PRO predictions');
assert.equal(Number(proFeed.proCount ?? proFeed.count), proFeed.predictions.length, 'private PRO count must match private predictions');
assert.ok(publicFeed.predictions.every(p => Number(p.confidence) >= 55), 'Free predictions must respect the 55% model threshold');
assert.ok(publicFeed.predictions.every(p => p.odds == null || (Number.isFinite(Number(p.odds)) && Number(p.odds) >= MIN_DECIMAL_ODDS)), `Free odds must be at least ${MIN_DECIMAL_ODDS.toFixed(2)} when provided`);
assert.ok(proFeed.predictions.length <= Number(proFeed.limits?.pro ?? 5) && proFeed.predictions.every(p => p.tier === 'pro'), 'PRO feed must respect tier and configured cap');
assert.ok(proFeed.predictions.length <= 5 && proFeed.predictions.every(p => Number(p.confidence) >= 60 && p.value === true && Number.isFinite(Number(p.odds)) && Number(p.odds) >= MIN_DECIMAL_ODDS), `PRO feed must contain at most five qualified value predictions with odds >= ${MIN_DECIMAL_ODDS.toFixed(2)}`);
assert.ok(publicFeed.predictions.every(p => !p.tier || p.tier === 'free'), 'public feed must not contain PRO tier predictions');
const freeIds = new Set(publicFeed.predictions.map(p => String(p.id)));
const proIds = new Set(proFeed.predictions.map(p => String(p.id)));
assert.equal(Number(publicFeed.freeCount ?? publicFeed.count), freeIds.size, 'free count must equal unique free match IDs');
assert.equal(Number(publicFeed.proCount), proIds.size, 'PRO count must equal unique private match IDs');
assert.ok([...proIds].every(id => !freeIds.has(id)), 'a match cannot appear in both tiers');
for (const [feed, key] of [[publicFeed, 'free'], [proFeed, 'pro']]) {
  const target = Number(feed.targets?.[key] ?? 3);
  const shortfall = Number(feed.shortfall?.[key] ?? Math.max(0, target - feed.predictions.length));
  const limit = Number(feed.limits?.[key] ?? 5);
  assert.ok(feed.predictions.length <= limit, `${key} feed exceeds its configured limit`);
  assert.equal(shortfall, Math.max(0, target - feed.predictions.length), `${key} shortfall must reflect actual output`);
}
console.log(`Daily feeds valid for ${publicFeed.date}: free=${publicFeed.count}, pro=${proFeed.count}, shortfalls free=${publicFeed.shortfall?.free ?? Math.max(0, 3 - publicFeed.count)}, pro=${proFeed.shortfall?.pro ?? Math.max(0, 3 - proFeed.count)}`);
