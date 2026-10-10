// Резолвер v2: проверяет прогнозы по реальным результатам ESPN.
// Проверяет все матчи за последние 3 дня, которые уже должны были сыграть.
// Источники: data/predictions.json (free) + data/archive/*.json + VIP-фид из KV воркера.
// PRO-прогнозы в публичный репозиторий больше не пишутся, поэтому их резолвер
// забирает с бэкенда админ-роутом — иначе история PRO терялась бы и проходимость
// VIP считалась бы по неполным данным.
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

// VIP-прогнозы лежат в KV воркера (в репозиторий не попадают). Забираем их
// админ-ключом за те же 3 дня, что и публичные, — иначе PRO-история не резолвится
// и статистика VIP считалась бы только по бесплатным прогнозам.
const workerUrl = (process.env.PXAX_WORKER_URL || '').replace(/\/+$/, '');
const adminKey = process.env.PXAX_ADMIN_KEY || '';
if (workerUrl && adminKey) {
  for (let i = 0; i < 4; i++) {
    const day = new Date(mskNow - i * 86400e3).toISOString().slice(0, 10);
    try {
      const res = await fetchJson(`${workerUrl}/api/admin/pro-feed?key=${encodeURIComponent(adminKey)}&date=${day}`);
      const feed = res?.feed;
      if (feed && Array.isArray(feed.predictions) && feed.predictions.length) {
        sources.push({ file: `kv:pro:${day}`, data: feed });
      }
    } catch (e) { console.warn('pro-feed fetch skip', day, String(e).slice(0, 120)); }
  }
} else {
  console.log('resolver: PXAX_WORKER_URL/PXAX_ADMIN_KEY не заданы — PRO-прогнозы из KV не подтянуты');
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

      // Предсезонные матчи помечаем, но из статистики исключаем: модель считает
      // силу команд по таблицам регулярного сезона, а в preseason играют ротацией.
      // Такие строки уже успели попасть в историю до фильтра в генераторе — их
      // нельзя оставлять в проходимости, иначе цифра врёт в обе стороны.
      const preseason = j.header?.season?.type === 1;

      const base = {
        date: matchDate, id: p.id, kind: p.tier === 'pro' ? 'pro' : 'free',
        // lgKey нужен домашнему фактору по лигам: он считается из решённой
        // истории по лиге, а не одной константой на все лиги. Это не платный
        // сигнал (лига видна в карточке), поэтому пишем и в публичные данные.
        sport: p.sport, lgKey: p.lgKey, league: p.lgName, home: p.home, away: p.away,
        market: p.market, confidence: p.confidence,
        // modelProb нужен калибровке (Brier), а odds — трекеру ставок.
        // edge и value не пишем: перевес над линией — это платный сигнал PRO,
        // а results.json лежит в публичном репозитории. Внутри резолвера они
        // по-прежнему есть (читаются из VIP-фида), просто не уходят в файл.
        modelProb: p.modelProb ?? null, odds: p.odds ?? null,
        ...(preseason ? { preseason: true } : {}),
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
// preseason-строки в калибровку не идут: модель там не работает, и Brier бы портился
const scored = hist.filter(x => !x.preseason && (x.result === 'hit' || x.result === 'miss') && Number.isFinite(x.modelProb));
let summary = null;
// Порог надёжности отделён от факта записи: файл пишем всегда, даже когда данных
// мало. Раньше при выборке меньше 20 файл не перезаписывался, и в репозитории
// оставался старый расчёт — уже вместе с preseason — как будто он актуальный.
const RELIABLE_N = 20;
if (scored.length) {
  const brier = scored.reduce((a, x) => a + Math.pow(x.modelProb - (x.result === 'hit' ? 1 : 0), 2), 0) / scored.length;
  const buckets = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const b = scored.filter(x => x.modelProb >= lo && x.modelProb < hi);
    const win = b.length ? b.filter(x => x.result === 'hit').length / b.length : null;
    return { lo, hi, n: b.length, predicted: (lo + hi) / 2, actual: win };
  });
  summary = { n: scored.length, brier: +brier.toFixed(4), buckets };
  writeFileSync('data/calibration.json', JSON.stringify({
    generated: new Date().toISOString(),
    ...summary,
    reliable: scored.length >= RELIABLE_N,
    note: `preseason-матчи исключены; выборка ${scored.length} наблюдений${scored.length >= RELIABLE_N ? '' : ` — меньше ${RELIABLE_N}, цифры ориентировочные`}`,
  }, null, 2));
}

const hits = results.filter(x => x.result === 'hit').length;
console.log(`OK: resolved ${added} new results (${hits} hit) for matches after ${cutoffDate}; history ${hist.length}${summary ? `; brier ${summary.brier} (n=${summary.n})` : ''}`);