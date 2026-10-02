// Резолвер: проверяет вчерашние прогнозы по реальным результатам ESPN (summary по id события).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const yest = new Date(mskNow - 86400e3).toISOString().slice(0, 10);

if (!existsSync('data/predictions.json')) { console.log('no predictions.json'); process.exit(0); }
const pred = JSON.parse(readFileSync('data/predictions.json', 'utf8'));
if (pred.date !== yest) { console.log(`predictions are for ${pred.date}, not for ${yest} — skip`); process.exit(0); }
if (pred.resolved) { console.log('already resolved'); process.exit(0); }

const results = [];
for (const p of pred.predictions) {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${p.lgKey}/summary?event=${p.id}`, { headers: UA });
    if (!res.ok) continue;
    const j = await res.json();
    const comp = j.header?.competitions?.[0];
    if (!comp || comp.status?.type?.state !== 'post') continue; // ещё не сыгран
    const H = comp.competitors.find(c => c.homeAway === 'home');
    const A = comp.competitors.find(c => c.homeAway === 'away');
    const hs = Number(H?.score), as = Number(A?.score);
    if (isNaN(hs) || isNaN(as)) continue;
    let r;
    switch (p.market) {
      case 'П1': r = hs > as ? 'hit' : 'miss'; break;
      case 'П2': r = as > hs ? 'hit' : 'miss'; break;
      case 'Х2': r = as >= hs ? 'hit' : 'miss'; break;
      case 'Ф1 -1.5': r = hs - as >= 2 ? 'hit' : 'miss'; break;
      case 'ТБ 2.5': r = hs + as > 2.5 ? 'hit' : 'miss'; break;
      case 'ТМ 2.5': r = hs + as < 2.5 ? 'hit' : 'miss'; break;
      default: r = 'miss';
    }
    results.push({
      date: yest, id: p.id, kind: p.tier === 'pro' ? 'pro' : 'free',
      sport: p.sport, league: p.lgName, home: p.home, away: p.away,
      market: p.market, odds: p.odds, confidence: p.confidence,
      score: `${hs}:${as}`, result: r,
    });
  } catch (err) {
    console.warn('skip', p.id, String(err));
  }
}

// накапливаем историю
const file = 'data/results.json';
let hist = [];
if (existsSync(file)) {
  try { hist = JSON.parse(readFileSync(file, 'utf8')); } catch { hist = []; }
}
const seen = new Set(hist.map(x => x.date + ':' + x.id));
for (const r of results) if (!seen.has(r.date + ':' + r.id)) hist.push(r);
hist = hist.slice(-400);
writeFileSync(file, JSON.stringify(hist, null, 2));

// помечаем прогнозы разрешёнными (частично разрешённые будут дожаты на следующий день)
if (results.length === pred.predictions.length) {
  pred.resolved = true;
  writeFileSync('data/predictions.json', JSON.stringify(pred, null, 2));
}

const hits = results.filter(x => x.result === 'hit').length;
console.log(`OK: resolved ${results.length}/${pred.predictions.length} (${hits} hit) for ${yest}`);
