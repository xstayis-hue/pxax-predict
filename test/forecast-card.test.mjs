import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const historyUi = readFileSync(new URL('../history-ui.js', import.meta.url), 'utf8');
const orderUi = readFileSync(new URL('../forecast-order.js', import.meta.url), 'utf8');
const scriptSrc = html.match(/<script src="history-ui\.js[^\"]*"><\/script>\s*<script src="forecast-order\.js[^\"]*"><\/script>\s*<script src="app\.js[^\"]*"><\/script>/)?.[0];
assert.ok(scriptSrc, 'index must load history UI before app');

const sandbox = {
  window: { PxaxHistoryUi: { quotaStatus: () => '', visibleHistoryCount: () => 0 } },
  document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  localStorage: { getItem() { return null; }, setItem() {} },
  Intl, Date, Math, URL, console, setTimeout, setInterval, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(historyUi, sandbox);
vm.runInContext(orderUi, sandbox);

const start = app.indexOf('function matchDateInfo(iso)');
const end = app.indexOf('\n// русская плюрализация', start);
assert.ok(start >= 0 && end > start, 'matchDateInfo must exist');
const dayLogic = app.slice(start, end);
vm.runInContext(`${dayLogic}; globalThis.matchDateInfo = matchDateInfo;`, sandbox);
const pluralStart = app.indexOf('function plural(n, one, few, many)');
const pluralEnd = app.indexOf('\nfunction collectStats', pluralStart);
assert.ok(pluralStart >= 0 && pluralEnd > pluralStart, 'plural helper must exist');
vm.runInContext(`${app.slice(pluralStart, pluralEnd)}; globalThis.plural = plural;`, sandbox);

const originalNow = Date.now;
const baseUtc = Date.parse('2026-10-15T12:00:00Z');
for (const { now, kickoff, days, rel } of [
  { now: '2026-10-15T12:00:00Z', kickoff: '2026-10-15T18:00:00Z', days: 0, rel: 'today' },
  { now: '2026-10-15T12:00:00Z', kickoff: '2026-10-16T12:00:00Z', days: 1, rel: 'tomorrow' },
  { now: '2026-10-15T12:00:00Z', kickoff: '2026-10-18T12:00:00Z', days: 3, rel: null },
  { now: '2026-10-15T20:30:00Z', kickoff: '2026-10-16T00:30:00Z', days: 1, rel: 'tomorrow' },
]) {
  const currentTime = Date.parse(now);
  sandbox.Date = class extends Date { static now() { return currentTime; } };
  const result = sandbox.matchDateInfo(kickoff);
  assert.equal(result.days, days, `calendar-day distance for ${kickoff}`);
  assert.equal(result.rel, rel, `relative date label for ${kickoff}`);
  if (currentTime === baseUtc) assert.equal(result.hours, (Date.parse(kickoff) - currentTime) / 3600000);
}
sandbox.Date = Date;
Date.now = originalNow;

assert.match(app, /mdi\.rel === 'today'[\s\S]*mdi\.rel === 'tomorrow'[\s\S]*через \$\{mdi\.days\}/);
assert.match(app, /Pro-разбор:/);
const publicBuilder = readFileSync(new URL('../scripts/generate-predictions.mjs', import.meta.url), 'utf8');
assert.match(publicBuilder, /proValueTxt \|\| valTxt/);
assert.match(publicBuilder, /note: String\(rest\.note \|\| ''\)/);
console.log('Moscow date labels and separate PRO value explanation checks passed');
