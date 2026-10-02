// Резолвер: проверяет прогнозы за вчера по реальным результатам ESPN.
// Источники: data/predictions.json (если за вчера) + data/archive/*.json
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const yest = new Date(mskNow - 86400e3).toISOString().slice(0, 10);

// собираем файлы с прогнозами за вчера
const sources = [];
if (existsSync('data/predictions.json')) {
  try {
    const p = JSON.parse(readFileSync('data/predictions.json', 'utf8'));
    if (p.date === yest) sources.push({ file: 'data/predictions.json', data: p });
  } catch (e) { console.warn('bad predictions.json'); }
}
if (existsSync('data/archive')) {
  for (const f of readdirSync('data/archive')) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(`data/archive/${f}`, 'utf8'));
      if (p.date === yest) sources.push({ file: `data/archive/${f}`, data: p });
    } catch (e) { console.warn('bad archive file', f); }
  }
}
if (!sources.length) { console.log(`no predictions for ${yest}`); process.exit(0); }

const results = [];
for (const src of sources) {
  if (src.data.resolved) continue;
  for (const p of src.data.predictions) {
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
  // помечаем источник разрешённым
  src.data.resolved = true;
  writeFileSync(src.file, JSON.stringify(src.data, null, 2));
}

// накапливаем историю
const file = 'data/results.json';
let hist = [];
if (existsSync(file)) {
  try { hist = JSON.parse(readFileSync(file, 'utf8')); } catch { hist = []; }
}
const seen = new Set(hist.map(x => x.date + ':' + x.id));
for (const r of results) if (!seen.has(r.date + ':' + r.id)) hist.push(r);
hist.sort((a, b) => a.date.localeCompare(b.date));
hist = hist.slice(-400);
writeFileSync(file, JSON.stringify(hist, null, 2));

const hits = results.filter(x => x.result === 'hit').length;
console.log(`OK: resolved ${results.length} new results (${hits} hit) for ${yest}; total history ${hist.length}`);
