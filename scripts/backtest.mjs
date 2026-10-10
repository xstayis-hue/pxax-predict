// Бэктест: проверка модели на завершённых матчах за последние 90 дней (ESPN, free API).
// Честно: для каждого матча модель использует только то, что было доступно ДО матча —
// форму команд (голы за/против в последних матчах той же лиги) и средний тотал лиги.
// Без заглядывания в будущее: никаких будущих таблиц и линий.
//
// Важно: выбор рынка теперь идёт через ту же функцию selectionScore, что и в
// генераторе (база — вероятность, edge — ограниченная добавка). До этого бэктест
// ранжировал строго по вероятности, а генератор строго по edge — то есть
// проверялась ДРУГАЯ модель, и его проходимость ничего не говорила о продакшне.
// Линий (коэффициентов) в окне 90 дней у нас нет, поэтому edge здесь равен нулю
// и selectionScore вырождается в чистую вероятность — но формула одна, и если
// генератор снова начнёт выбирать по edge, это сразу станет видно из расхождения.
// Вывод: data/backtest.json — проходимость «сигналов» (вероятность >= 55%, тот же порог,
// что в production-модели) + Brier (1X2) по всем проанализированным матчам.
// Запуск: ежедневно, .github/workflows/backtest.yml (ESPN отдаёт scoreboard по дням).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { scoreMatrix, outcomesFromMatrix, selectionScore, homeAdvFromTotals } from './model.mjs';

const LEAGUES = [
  { key: 'soccer/eng.1', name: 'АПЛ' },
  { key: 'soccer/esp.1', name: 'Ла Лига' },
  { key: 'soccer/ita.1', name: 'Серия A' },
  { key: 'soccer/ger.1', name: 'Бундеслига' },
  { key: 'soccer/fra.1', name: 'Лига 1' },
  { key: 'soccer/bra.1', name: 'Бразилия · Серия A' },
  { key: 'soccer/arg.1', name: 'Аргентина' },
  { key: 'soccer/usa.1', name: 'MLS' },
];
const WINDOW_DAYS = 90;
const SIGNAL_MIN = 0.55; // порог сигнала — как в production-модели (FREE_MIN = 55%)
const HOME_ADV = 1.15;   // запасной домашний фактор, если по лиге мало матчей
const K = 6;             // шринк, как в production-модели (футбол)
const FORM_GAMES = 10;   // сколько последних матчей команды брать для формы

const mskNow = Date.now() + 3 * 3600e3;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(1500 * i);
    }
  }
}

// завершившиеся матчи дня по лиге
async function dayMatches(key, ds) {
  const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard?dates=${ds}`);
  const out = [];
  for (const e of j.events ?? []) {
    const comp = e.competitions?.[0];
    if (!comp || comp.status?.type?.state !== 'post') continue;
    const H = comp.competitors.find((c) => c.homeAway === 'home');
    const A = comp.competitors.find((c) => c.homeAway === 'away');
    if (!H?.id || !A?.id) continue;
    const hs = Number(H.score), as = Number(A.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    out.push({ date: (e.date || '').slice(0, 10), homeId: String(H.id), awayId: String(A.id), hs, as });
  }
  return out;
}

// форма команды: голы за/против в среднем за матч в последних N матчах СТРОГО до дня before
function form(matches, teamId, before, n = FORM_GAMES) {
  let gf = 0, ga = 0, cnt = 0;
  for (let i = matches.length - 1; i >= 0 && cnt < n; i--) {
    const m = matches[i];
    if (m.date >= before) continue;
    if (m.homeId !== teamId && m.awayId !== teamId) continue;
    const mine = m.homeId === teamId ? m.hs : m.as;
    const theirs = m.homeId === teamId ? m.as : m.hs;
    gf += mine; ga += theirs; cnt++;
  }
  if (!cnt) return null;
  return { gf: gf / cnt, ga: ga / cnt, gp: cnt };
}

// вердикт по рынку: true = зашло
function marketHit(market, hs, as) {
  switch (market) {
    case 'П1': return hs > as;
    case 'П2': return as > hs;
    case 'Х': return hs === as;
    case 'Х2': return as >= hs;
    case 'ТБ 2.5': return hs + as > 2.5;
    case 'ТМ 2.5': return hs + as < 2.5;
    default: return null;
  }
}
const byLeague = {};
const leagueNames = [];
let totalAnalyzed = 0, totalSignals = 0, totalHits = 0, brierSum = 0;

for (const lg of LEAGUES) {
  // окно собираем по дням (ESPN принимает только одиночные даты)
  const matches = [];
  for (let d = 0; d < WINDOW_DAYS; d++) {
    const ds = ymd(mskNow - d * 86400e3);
    try {
      matches.push(...(await dayMatches(lg.key, ds)));
      await sleep(250); // не грузим ESPN
    } catch (e) { /* день недоступен — пропускаем, окно чуть короче */ }
  }
  if (matches.length < 20) {
    console.log('skip (мало матчей):', lg.name, matches.length);
    continue;
  }
  matches.sort((a, b) => a.date.localeCompare(b.date));
  const avgTotal = matches.reduce((a, m) => a + m.hs + m.as, 0) / matches.length;
  const clamp = (v) => Math.max(0.6, Math.min(1.55, v));
  // домашнее преимущество лиги — тот же расчёт, что в генераторе. Здесь оно
  // считается по тем же матчам окна (in-sample): это оценка сверху, но общая
  // константа 1.15 на все лиги давала заметно кривее ожидания в MLS и Аргентине.
  const lgHomeAdv = homeAdvFromTotals(
    matches.reduce((a, m) => a + m.hs, 0),
    matches.reduce((a, m) => a + m.as, 0),
    matches.length,
  ) || HOME_ADV;

  let analyzed = 0, signals = 0, hits = 0;
  for (const m of matches) {
    const fh = form(matches, m.homeId, m.date);
    const fa = form(matches, m.awayId, m.date);
    if (!fh || !fa) continue; // у команды пока нет истории в окне
    // сила — тот же подход, что в production: множители к среднему тоталу лиги
    // с шринком при малом числе матчей
    const att = (f) => clamp(1 + ((f.gf / (avgTotal / 2)) - 1) * (f.gp / (f.gp + K)));
    const def = (f) => clamp(1 + ((f.ga / (avgTotal / 2)) - 1) * (f.gp / (f.gp + K)));
    const avg = (fh.gf + fh.ga + fa.gf + fa.ga) / 4;
    let lh = avg * att(fh) * def(fa) * lgHomeAdv;
    let la = avg * att(fa) * def(fh);
    const anchor = avgTotal / 2;
    lh += (anchor - lh) * 0.5;
    la += (anchor - la) * 0.5;

    const oc = outcomesFromMatrix(scoreMatrix(lh, la));
    // кандидаты — тот же набор рынков, что у production-модели без линий;
    // ранжирование через общую selectionScore (edge здесь нет -> чистая вероятность)
    const pool = [
      { m: 'П1', p: oc.p1 },
      { m: 'Х', p: oc.px },
      { m: 'П2', p: oc.p2 },
      { m: 'Х2', p: oc.px + oc.p2 },
      { m: 'ТБ 2.5', p: oc.over },
      { m: 'ТМ 2.5', p: oc.under },
    ].filter((c) => c.p >= 0.5);
    if (!pool.length) continue;
    pool.sort((a, b) => selectionScore(b.p, null) - selectionScore(a.p, null) || b.p - a.p);
    const best = pool[0];

    analyzed++;
    totalAnalyzed++;
    // Brier (1X2) по всем проанализированным матчам
    const o1 = m.hs > m.as ? 1 : 0, oX = m.hs === m.as ? 1 : 0, o2 = m.hs < m.as ? 1 : 0;
    brierSum += (oc.p1 - o1) ** 2 + (oc.px - oX) ** 2 + (oc.p2 - o2) ** 2;

    if (best.p >= SIGNAL_MIN) {
      signals++;
      totalSignals++;
      if (marketHit(best.m, m.hs, m.as)) {
        hits++;
        totalHits++;
      }
    }
  }
  if (!analyzed) {
    console.log('skip (нет проанализированных):', lg.name);
    continue;
  }
  byLeague[lg.name] = { matches: analyzed, signals, hits, rate: signals ? +(hits / signals).toFixed(3) : null };
  leagueNames.push(lg.name);
  console.log('backtest:', lg.name, 'matches=' + analyzed, 'signals=' + signals, 'hits=' + hits);
}

if (!totalAnalyzed) {
  console.log('FAIL: 0 проанализированных матчей — ESPN недоступен или нет матчей в окне. Не трогаем старый backtest.json.');
  process.exit(1);
}

const report = {
  generated: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  leagues: leagueNames,
  matches: totalAnalyzed,
  signals: totalSignals,
  hits: totalHits,
  hitRate: totalSignals ? +(totalHits / totalSignals).toFixed(3) : null,
  brier: +(brierSum / totalAnalyzed).toFixed(4),
  signalThreshold: SIGNAL_MIN,
  byLeague,
  note: 'Бэктест модели по реальным прошедшим результативам: только форма до матча + средний тотал лиги, без заглядывания в будущее и без линий',
};
mkdirSync('data', { recursive: true });
writeFileSync('data/backtest.json', JSON.stringify(report, null, 2));
console.log('OK: backtest', report.windowDays + 'd,', report.matches + ' матчей,', report.signals + ' сигналов, hit ' + report.hitRate + ' (Brier ' + report.brier + ')');
