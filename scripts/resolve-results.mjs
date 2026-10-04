// Резолвер: проверяет прогнозы по реальным результатам ESPN.
// Проверяет все матчи за последние 2 дня, которые уже должны были сыграть.
// Источники: data/predictions.json + data/archive/*.json
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
// проверяем матчи за последние 2 дня (48 часов)
const cutoffDate = new Date(mskNow - 48 * 3600e3).toISOString().slice(0, 10);

// fetch с таймаутом и ретраями — сетевые сбои не должны терять результаты
async function fetchJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

// собираем все файлы с прогнозами (текущий + архив) и отбираем те, где есть матчи в нужном окне
const sources = [];
const checkFile = (file) => {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(p.predictions)) return;
    // проверяем, есть ли в этом файле матчи за последние 48 часов
    const hasRecent = p.predictions.some(pred => {
      const matchDate = pred.matchDate ? pred.matchDate.slice(0, 10) : null;
      return matchDate && matchDate >= cutoffDate;
    });
    if (hasRecent) {
      sources.push({ file, data: p });
    }
  } catch (e) { console.warn('bad file', file, e); }
};

if (existsSync('data/predictions.json')) {
  checkFile('data/predictions.json');
}
if (existsSync('data/archive')) {
  for (const f of readdirSync('data/archive')) {
    if (!f.endsWith('.json')) continue;
    checkFile(`data/archive/${f}`);
  }
}
if (!sources.length) { console.log(`no predictions with matches after ${cutoffDate}`); process.exit(0); }

const results = [];
const processedIds = new Set(); // чтобы не обрабатывать один прогноз дважды

for (const src of sources) {
  for (const p of src.data.predictions) {
    // пропускаем матчи старше 48 часов
    const matchDate = p.matchDate ? p.matchDate.slice(0, 10) : null;
    if (!matchDate || matchDate < cutoffDate) continue;

    // пропускаем уже обработанные
    const key = p.date + ':' + p.id;
    if (processedIds.has(key)) continue;
    processedIds.add(key);

    try {
      const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${p.lgKey}/summary?event=${p.id}`);
      const comp = j.header?.competitions?.[0];
      if (!comp) continue;

      const desc = (comp.status?.type?.description || '').toLowerCase();
      // отмена/перенос — это не «мисс», а возврат (push), иначе портим статистику
      if (/cancel|postpon|abandon|suspend|forfeit/.test(desc)) {
        results.push({
          date: matchDate, id: p.id, kind: p.tier === 'pro' ? 'pro' : 'free',
          sport: p.sport, league: p.lgName, home: p.home, away: p.away,
          market: p.market, confidence: p.confidence,
          score: '—', result: 'push',
        });
        continue;
      }

      if (comp.status?.type?.state !== 'post') continue; // ещё не сыгран

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
        default: r = 'push'; // незнакомый рынок — возврат, а не автоматический «мисс»
      }
      results.push({
        date: matchDate, id: p.id, kind: p.tier === 'pro' ? 'pro' : 'free',
        sport: p.sport, league: p.lgName, home: p.home, away: p.away,
        market: p.market, confidence: p.confidence,
        score: `${hs}:${as}`, result: r,
      });
    } catch (err) {
      console.warn('skip', p.id, String(err));
    }
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
hist.sort((a, b) => a.date.localeCompare(b.date));
hist = hist.slice(-400);
writeFileSync(file, JSON.stringify(hist, null, 2));

const hits = results.filter(x => x.result === 'hit').length;
console.log(`OK: resolved ${results.length} new results (${hits} hit) for matches after ${cutoffDate}; total history ${hist.length}`);
