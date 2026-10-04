// Резолвер v2: проверяет прогнозы по реальным результатам ESPN.
// Проверяет все матчи за последние 3 дня, которые уже должны были сыграть.
// Источники: data/predictions.json + data/archive/*.json
// Поддерживает рынки: П1, Х, П2, Х2, ТБ/ТМ (любая линия), Ф1/Ф2 -1.5.
// Сохраняет модельную вероятность, коэффициент и перевес — для калибровки.
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const cutoffDate = new Date(mskNow - 72 * 3600e3).toISOString().slice(0, 10);

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

// рынок -> вердикт по счёту. Возвращает 'hit' | 'miss' | null (незнакомый рынок)
function grade(market, hs, as) {
  const m = (market || '').trim();
  const total = (prefix) => {
    const num = Number(m.replace(',', '.').match(/(\d+(?:\.\d+)?)/)?.[1]);
    if (!Number.isFinite(num)) return null;
    return prefix === 'over' ? hs + as > num : hs + as < num;
  };
  switch (m) {
    case 'П1': return hs > as ? 'hit' : 'miss';
    case 'П2': return as > hs ? 'hit' : 'miss';
    case 'Х': return hs === as ? 'hit' : 'miss';
    case 'Х2': return as >= hs ? 'hit' : 'miss';
    case '1Х': return hs >= as ? 'hit' : 'miss';
    case 'Ф1 -1.5': return hs - as >= 2 ? 'hit' : 'miss';
    case 'Ф2 -1.5': return as - hs >= 2 ? 'hit' : 'miss';
    default: {
      if (/^ТБ/i.test(m)) { const r = total('over'); return r == null ? null : (r ? 'hit' : 'miss'); }
      if (/^ТМ/i.test(m)) { const r = total('under'); return r == null ? null : (r ? 'hit' : 'miss'); }
      return null;
    }
  }
}

// собираем файлы с прогнозами (текущий + архив)
const sources = [];
const checkFile = (file) => {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(p.predictions)) return;
    const hasRecent = p.predictions.some(pred => {
      const matchDate = pred.matchDate ? pred.matchDate.slice(0, 10) : null;
      return matchDate && matchDate >= cutoffDate;
    });
    if (hasRecent) sources.push({ file, data: p });
  } catch (e) { console.warn('bad file', file, e); }
};
if (existsSync('data/predictions.json')) checkFile('data/predictions.json');
if (existsSync('data/archive')) {
  for (const f of readdirSync('data/archive')) {
    if (f.endsWith('.json')) checkFile(`data/archive/${f}`);
  }
}
if (!sources.length) { console.log(`no predictions with matches after ${cutoffDate}`); process.exit(0); }

const results = [];
const processedIds = new Set();

for (const src of sources) {
  for (const p of src.data.predictions) {
    const matchDate = p.matchDate ? p.matchDate.slice(0, 10) : null;
    if (!matchDate || matchDate < cutoffDate) continue;
    // ключ — id матча (id уникален для события; один матч не должен дублироваться)
    const key = String(p.id);
    if (processedIds.has(key)) continue;
    processedIds.add(key);

    try {
      const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${p.lgKey}/summary?event=${p.id}`);
      const comp = j.header?.competitions?.[0];
      if (!comp) continue;

      const base = {
        date: matchDate, id: p.id, kind: p.tier === 'pro' ? 'pro' : 'free',
        sport: p.sport, league: p.lgName, home: p.home, away: p.away,
        market: p.market, confidence: p.confidence,
        modelProb: p.modelProb ?? null, odds: p.odds ?? null, edge: p.edge ?? null, value: !!p.value,
      };

      const desc = (comp.status?.type?.description || '').toLowerCase();
      if (/cancel|postpon|abandon|suspend|forfeit/.test(desc)) {
        results.push({ ...base, score: '—', result: 'push' });
        continue;
      }
      if (comp.status?.type?.state !== 'post') continue;

      const H = comp.competitors.find(c => c.homeAway === 'home');
      const A = comp.competitors.find(c => c.homeAway === 'away');
      const hs = Number(H?.score), as = Number(A?.score);
      if (isNaN(hs) || isNaN(as)) continue;

      const r = grade(p.market, hs, as);
      results.push({ ...base, score: `${hs}:${as}`, result: r || 'push' });
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
let added = 0;
for (const r of results) {
  const k = r.date + ':' + r.id;
  if (seen.has(k)) continue;
  seen.add(k); hist.push(r); added++;
}
hist.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
hist = hist.slice(-800);
writeFileSync(file, JSON.stringify(hist, null, 2));

// --- честная калибровка по накопленной истории (Brier + reliability) ---
const scored = hist.filter(x => (x.result === 'hit' || x.result === 'miss') && Number.isFinite(x.modelProb));
let summary = null;
if (scored.length >= 20) {
  const brier = scored.reduce((a, x) => a + Math.pow(x.modelProb - (x.result === 'hit' ? 1 : 0), 2), 0) / scored.length;
  const buckets = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const b = scored.filter(x => x.modelProb >= lo && x.modelProb < hi);
    const win = b.length ? b.filter(x => x.result === 'hit').length / b.length : null;
    return { lo, hi, n: b.length, predicted: (lo + hi) / 2, actual: win };
  });
  summary = { n: scored.length, brier: +brier.toFixed(4), buckets };
  writeFileSync('data/calibration.json', JSON.stringify({ generated: new Date().toISOString(), ...summary }, null, 2));
}

const hits = results.filter(x => x.result === 'hit').length;
console.log(`OK: resolved ${added} new results (${hits} hit) for matches after ${cutoffDate}; history ${hist.length}${summary ? `; brier ${summary.brier} (n=${summary.n})` : ''}`);