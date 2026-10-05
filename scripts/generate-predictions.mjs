// Генератор прогнозов v2 — вероятностная модель на данных ESPN (бесплатный API, без ключа).
// Запускается GitHub Actions каждые 2 часа. Модель: pxax-v2.
//
// Что нового против rules-v1:
//  - сила атаки/обороны считается по голам за/против из таблиц ESPN, а не по W-D-L;
//  - футбол: распределение счёта -> честные вероятности П1/X/П2, ТБ/ТМ 2.5, форы;
//  - НХЛ/НБА: распределение счёта с домашним фактором;
//  - читаем реальные коэффициенты ESPN (moneyline/total) и считаем value (edge);
//  - free = самые надёжные прогнозы, pro = value-ставки (там где есть линия).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { scoreMatrix, outcomesFromMatrix, outcomesFromNormal, xgBlend } from './model.mjs';

const LEAGUES = [
  { key: 'soccer/eng.1', sport: '⚽', name: 'EPL', type: 'soccer' },
  { key: 'soccer/esp.1', sport: '⚽', name: 'La Liga', type: 'soccer' },
  { key: 'soccer/ita.1', sport: '⚽', name: 'Серия А', type: 'soccer' },
  { key: 'soccer/ger.1', sport: '⚽', name: 'Бундеслига', type: 'soccer' },
  { key: 'soccer/fra.1', sport: '⚽', name: 'Ligue 1', type: 'soccer' },
  { key: 'soccer/eng.2', sport: '⚽', name: 'Championship', type: 'soccer' },
  { key: 'soccer/esp.2', sport: '⚽', name: 'La Liga 2', type: 'soccer' },
  { key: 'soccer/ger.2', sport: '⚽', name: '2. Бундеслига', type: 'soccer' },
  { key: 'soccer/ned.1', sport: '⚽', name: 'Эредивизи', type: 'soccer' },
  { key: 'soccer/por.1', sport: '⚽', name: 'Португалия', type: 'soccer' },
  { key: 'soccer/bra.1', sport: '⚽', name: 'Бразилия · Серия A', type: 'soccer' },
  { key: 'soccer/arg.1', sport: '⚽', name: 'Аргентина', type: 'soccer' },
  { key: 'soccer/usa.1', sport: '⚽', name: 'MLS', type: 'soccer' },
  { key: 'soccer/mex.1', sport: '⚽', name: 'Лига MX', type: 'soccer' },
  { key: 'soccer/uefa.champions', sport: '⚽', name: 'Лига чемпионов', type: 'soccer' },
  { key: 'soccer/uefa.europa', sport: '⚽', name: 'Лига Европы', type: 'soccer' },
  { key: 'basketball/nba', sport: '🏀', name: 'NBA', type: 'us' },
  { key: 'hockey/nhl', sport: '🏒', name: 'NHL', type: 'us' },
];

// средняя результативность лиги (голы на обе команды) — ориентир для распределения счёта.
// обновляется по факту сезонных таблиц, это лишь стартовое значение для начала сезона.
const LEAGUE_AVG_GOALS = {
  'soccer/eng.1': 2.7, 'soccer/esp.1': 2.5, 'soccer/ita.1': 2.6, 'soccer/ger.1': 3.1,
  'soccer/fra.1': 2.7, 'soccer/eng.2': 2.6, 'soccer/esp.2': 2.4, 'soccer/ger.2': 2.8,
  'soccer/ned.1': 3.1, 'soccer/por.1': 2.6, 'soccer/bra.1': 2.5, 'soccer/arg.1': 2.3,
  'soccer/usa.1': 2.9, 'soccer/mex.1': 2.7, 'soccer/uefa.champions': 2.9, 'soccer/uefa.europa': 2.8,
  'hockey/nhl': 6.0, 'basketball/nba': 224, // NBA — суммарные очки обеих команд
};
const HOME_ADV_GOALS = { // множитель ожидания хозяев
  soccer: 1.15, us: 1.08,
};
// ожидаемый счёт для подписи (своя единица для каждого спорта)
const SCORE_LABEL = { soccer: 'Ожидаемые голы', hockey: 'Ожидаемые шайбы', basketball: 'Ожидаемые очки' };
const WINDOW_MIN_H = 6, WINDOW_MAX_H = 48, PER_LEAGUE = 6;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const dateStr = new Date(mskNow).toISOString().slice(0, 10);
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');

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
async function scoreboard(key, ds) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard${ds ? `?dates=${ds}` : ''}`;
  const j = await fetchJson(url);
  return j.events ?? [];
}
// таблица лиги: голы за/против и игры на команду -> сила атаки/обороны.
// возвращает Map<teamId, {gf,ga,gp,att,def}> либо null, если API не отдал таблицу
async function leagueStats(key, type) {
  try {
    const sport = key.split('/')[0]; // soccer | hockey | basketball — берём из ключа
    const league = key.split('/')[1];
    // текущий сезон может быть в самом начале (0-2 игры) — тогда берём прошлый:
    // таблица прошлого сезона — куда лучший предиктор, чем пустая.
    let j = await fetchJson(`https://site.api.espn.com/apis/v2/sports/${sport}/${league}/standings`);
    let entries = j.children?.flatMap(c => c.standings?.entries || []) || j.standings?.entries || [];
    const gpOf = (e) => {
      const s = (e.stats || []).find(x => x.name === 'gamesPlayed');
      if (s && Number(s.value) > 0) return Number(s.value);
      const w = (e.stats || []).find(x => x.name === 'wins')?.value;
      const l = (e.stats || []).find(x => x.name === 'losses')?.value;
      return Number(w || 0) + Number(l || 0);
    };
    const medGp = () => {
      const a = entries.map(gpOf).filter(Number.isFinite).sort((x, y) => x - y);
      return a.length ? a[Math.floor(a.length / 2)] : 0;
    };
    if (!entries.length || medGp() < 3) {
      const prev = await fetchJson(`https://site.api.espn.com/apis/v2/sports/${sport}/${league}/standings?season=${new Date().getFullYear() - 1}`);
      const pe = prev.children?.flatMap(c => c.standings?.entries || []) || [];
      if (pe.length) { entries = pe; j = prev; }
    }
    if (!entries.length) return null;
    const stat = (e, n) => {
      const s = (e.stats || []).find(x => x.name === n || x.abbreviation === n);
      return s ? Number(s.value ?? s.displayValue) : NaN;
    };
    const rows = [];
    for (const e of entries) {
      let gp = gpOf(e);
      // NBA отдаёт готовые средние очки за/против; остальные — тоталы за сезон
      let gf = stat(e, 'avgPointsFor'), ga = stat(e, 'avgPointsAgainst');
      if (!Number.isFinite(gf) || !Number.isFinite(ga)) {
        gf = stat(e, 'pointsFor') / gp;
        ga = stat(e, 'pointsAgainst') / gp;
      }
      if (!Number.isFinite(gp) || gp < 1 || !Number.isFinite(gf) || !Number.isFinite(ga)) continue;
      rows.push({ id: String(e.team?.id), name: e.team?.displayName, gf, ga, gp });
    }
    if (rows.length < 4) return null;
    const avgFor = rows.reduce((a, r) => a + r.gf, 0) / rows.length;
    const avgAg = rows.reduce((a, r) => a + r.ga, 0) / rows.length;
    // в начале сезона таблицы шумные: шринк сильнее и множители зажаты,
    // иначе пара матчей даёт «ожидаемые 7 шайб»
    const K = type === 'soccer' ? 6 : 10;
    const clamp = (v) => Math.max(0.6, Math.min(1.55, v));
    const m = new Map();
    for (const r of rows) {
      const k = r.gp / (r.gp + K);
      const att = clamp(1 + ((r.gf / avgFor) - 1) * k);
      const def = clamp(1 + ((r.ga / avgAg) - 1) * k);
      m.set(r.id, { ...r, att, def, avgFor, avgAg });
    }
    return m;
  } catch (e) { return null; }
}

// ---------- Understat xG: форма последних 5 игр для футбола ----------
// ключ ESPN -> slug Understat. Поддерживаются только лиги, которые реально есть на Understat;
// остальные (2-е дивизионы, еврокубки, MLS, Лига MX, Бразилия, Аргентина и т.д.)
// остаются на гoал-форме из таблиц ESPN — это не ошибка, а fallback.
const XG_LEAGUES = {
  'soccer/eng.1': 'EPL', 'soccer/esp.1': 'La_Liga', 'soccer/ita.1': 'Serie_A',
  'soccer/ger.1': 'Bundesliga', 'soccer/fra.1': 'Ligue_1',
};
const normName = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
// названия Understat иногда короче ESPN-имени (Wolves vs Wolverhampton Wanderers и т.п.)
// ключ — нормализованное ESPN-имя, значение — нормализованный заголовок Understat
const XG_NAME_ALIAS = {
  'rb leipzig': 'rasenballsport leipzig',
  'athletic bilbao': 'athletic club',
  'wolverhampton wanderers': 'wolves',
  'hull city': 'hull',
};
// ESPN часто даёт префиксы клубов («AFC Bournemouth», «AS Roma») — срезаем их и ищем снова
const XG_STRIP_TOKENS = ['afc', 'cfc', 'cf', 'fc', 'sc', 'sv', 'as', 'ssc', 'tsg', 'vfb'];
// Фетчим данные лиги один раз: Map(нормализованное название -> {title, hist: [{ms, xg, xga}]})
// hist содержит только завершённые матчи (без lookahead’а по дате).
async function leagueXg(key) {
  const slug = XG_LEAGUES[key];
  if (!slug) return null;
  const d = new Date(Date.now() + 3 * 3600e3);
  // сезон топ-5 лиг начинается в июле: июль+ -> текущий год, иначе -> предыдущий
  const season = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  let j;
  try {
    const res = await fetch(`https://understat.com/getLeagueData/${slug}/${season}`, {
      headers: {
        ...UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://understat.com/league/${slug}/${season}`,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    j = await res.json();
  } catch (e) {
    console.warn('understat skip:', key, String(e));
    return null;
  }
  const out = new Map();
  for (const t of Object.values(j.teams || {})) {
    const hist = (t.history || [])
      .filter(h => h && h.result && h.result !== '-' && Number.isFinite(Number(h.xG)))
      .map(h => ({ ms: new Date(String(h.date).replace(' ', 'T')).getTime(), xg: Number(h.xG), xga: Number(h.xGA) }))
      .filter(h => Number.isFinite(h.ms));
    if (!hist.length) continue;
    const m = { title: t.title, hist };
    const k = normName(t.title);
    if (k && !out.has(k)) out.set(k, m);
    const alias = XG_NAME_ALIAS[k];
    if (alias && !out.has(alias)) out.set(alias, m);
  }
  if (out.size < 4) { console.warn('understat: мало команд в', key, out.size); return null; }
  return out;
}
// Последние 5 завершённых игр перед матчем -> {xf, xa}; плюс средние по лиге {lf, la}.
function xgForm(map, espnNames, matchIso) {
  const matchMs = new Date(matchIso).getTime();
  const pick = (name) => {
    const e = normName(name);
    if (!e || !map) return null;
    if (map.has(e)) return map.get(e);
    const alias = XG_NAME_ALIAS[e];
    if (alias && map.has(alias)) return map.get(alias);
    // префикс: любая сторона короче («Leeds» vs «Leeds United»); берём самое длинное совпадение
    const scan = (s) => {
      let best = null;
      for (const [u, m] of map) {
        if (u.length < 5 || s.length < 5) continue;
        if (s.startsWith(u) || u.startsWith(s)) {
          const len = Math.min(s.length, u.length);
          if (!best || len > best.len) best = { m, len };
        }
      }
      return best ? best.m : null;
    };
    let hit = scan(e);
    if (hit) return hit;
    // срезаем клубные префиксы ESPN-имени: «AFC Bournemouth» -> «Bournemouth», «AS Roma» -> «Roma»
    const parts = e.split(' ');
    while (parts.length > 1 && XG_STRIP_TOKENS.includes(parts[0])) {
      parts.shift();
      const s = parts.join(' ');
      if (map.has(s)) return map.get(s);
      hit = scan(s);
      if (hit) return hit;
    }
    return null;
  };
  const snap = (m) => {
    if (!m) return null;
    const hist = m.hist.filter(h => h.ms < matchMs);
    if (hist.length < 3) return null; // мало сыгранного — форма не считается
    const last5 = hist.slice(0, 5);
    return { n: last5.length, xf: last5.reduce((a, h) => a + h.xg, 0) / last5.length, xa: last5.reduce((a, h) => a + h.xga, 0) / last5.length };
  };
  const home = snap(pick(espnNames[0]));
  const away = snap(pick(espnNames[1]));
  if (!home || !away) return null;
  // лига — по тем же последним 5 матчам всех команд (в этом же окне, без lookahead’а)
  const league = [];
  const seen = new Set();
  for (const m of map.values()) {
    if (seen.has(m.title)) continue;
    seen.add(m.title);
    const s = snap(m);
    if (s) league.push(s);
  }
  if (league.length < 4) return null;
  return { home, away, L: { lf: league.reduce((a, s) => a + s.xf, 0) / league.length, la: league.reduce((a, s) => a + s.xa, 0) / league.length } };
}

// ---------- ESPN-травмы: короткая заметка в ноте матча ----------
const INJ_STATUS_RU = {
  Out: 'не выйдет', Doubtful: 'сомнителен', 'Day to day': 'сомнителен',
  Probable: 'вероятно выйдет', Unknown: 'статус неясен', Injured: 'травма',
};
// Map(teamId или нормализованное название -> ['Игрок (статус)', ...]) — до 3 на команду
async function leagueInjuries(key) {
  try {
    const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${key}/injuries`);
    const m = new Map();
    for (const t of j.injuries || []) {
      const items = (t.injuries || [])
        .filter(i => i && i.athlete && (i.athlete.displayName || i.athlete.shortName))
        .slice(0, 3)
        .map(i => `${i.athlete.displayName || i.athlete.shortName}${INJ_STATUS_RU[i.status] ? ` (${INJ_STATUS_RU[i.status]})` : ''}`);
      if (!items.length) continue;
      if (t.id != null) m.set(String(t.id), items);
      const k = normName(t.displayName);
      if (k && !m.has(k)) m.set(k, items);
    }
    return m;
  } catch (e) { return null; }
}
const injFor = (map, teamId, displayName) =>
  (map && (map.get(String(teamId)) || map.get(normName(displayName)))) || null;

// Распределение счёта / нормальное приближение — в scripts/model.mjs (общий с backtest.mjs)

// американский коэффициент -> десятичный и неявная вероятность
function americanToDecimal(am) {
  const n = Number(am);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}
// убираем маржу из имплайд-вероятностей пропорционально
function devig(probs) {
  const s = probs.reduce((a, b) => a + (b || 0), 0);
  if (!s) return probs.map(() => 0);
  return probs.map(p => (p || 0) / s);
}

function fmtTime(iso) {
  const t = new Date(new Date(iso).getTime() + 3 * 3600e3);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} МСК`;
}
const ru = n => n.toFixed(2).replace('.', ',');
const pct = n => Math.round(n * 100);

function parseOdds(comp) {
  const o = comp?.odds?.[0];
  if (!o) return null;
  const ml = (side) => americanToDecimal(o.moneyline?.[side]?.close?.odds ?? o.moneyline?.[side]?.open?.odds);
  const dec = { home: ml('home'), draw: ml('draw'), away: ml('away') };
  const totalLine = Number(o.overUnder) || null;
  const over = americanToDecimal(o.total?.over?.close?.odds ?? o.total?.over?.open?.odds);
  const under = americanToDecimal(o.total?.under?.close?.odds ?? o.total?.under?.open?.odds);
  dec.over = over; dec.under = under;
  if (!dec.home && !dec.away && !over) return null;
  // снимаем маржу: сравнивать модель надо с «честной» вероятностью линии, иначе любой фаворит выглядит value
  const sov = devig([dec.home ? 1 / dec.home : 0, dec.draw ? 1 / dec.draw : 0, dec.away ? 1 / dec.away : 0]);
  const tov = devig([over ? 1 / over : 0, under ? 1 / under : 0]);
  return {
    provider: o.provider?.name || 'ESPN',
    dec, totalLine,
    implied: { p1: sov[0], px: sov[1], p2: sov[2], over: tov[0], under: tov[1] },
  };
}
// чистый edge по вероятности: модель против честной (devig) вероятности линии
function edgeOf(modelProb, fairProb) {
  if (!fairProb) return null;
  return modelProb / fairProb - 1;
}

const preds = [];
for (const lg of LEAGUES) {
  try {
    let events;
    if (lg.type === 'us') {
      const m = new Map();
      for (const e of [
        ...(await scoreboard(lg.key)),
        ...(await scoreboard(lg.key, ymd(Date.now() + 3 * 3600e3))),
        ...(await scoreboard(lg.key, ymd(Date.now() + 3 * 3600e3 + 86400e3))),
      ]) m.set(String(e.id), e);
      events = [...m.values()];
    } else {
      events = await scoreboard(lg.key);
    }
    const stats = await leagueStats(lg.key, lg.type);
    const xgMap = lg.type === 'soccer' ? await leagueXg(lg.key) : null;
    const injMap = await leagueInjuries(lg.key);
    let taken = 0;
    for (const e of events) {
      if (taken >= PER_LEAGUE) break;
      const t = new Date(e.date).getTime();
      if (t < Date.now() + WINDOW_MIN_H * 3600e3 || t > Date.now() + WINDOW_MAX_H * 3600e3) continue;
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away || e.status?.type?.state !== 'pre') continue;

      // вид спорта: soccer | hockey | basketball
      const kind = lg.key.split('/')[0];
      const avgTotal = LEAGUE_AVG_GOALS[lg.key] || (kind === 'soccer' ? 2.7 : 6.0);
      const hs = stats?.get(String(home.team.id));
      const as = stats?.get(String(away.team.id));
      let lh, la; // ожидаемые голы/шайбы/очки одной команды
      let statsUsed = false;
      if (hs && as) {
        const avg = (hs.avgFor + hs.avgAg + as.avgFor + as.avgAg) / 4;
        lh = Math.max(0.2, avg * hs.att * as.def * HOME_ADV_GOALS[lg.type]);
        la = Math.max(0.15, avg * as.att * hs.def);
        // сезонный ориентир лиги: сглаживает шумную таблицу начала сезона
        const anchor = avgTotal / 2;
        const pull = kind === 'basketball' ? 0.35 : 0.5;
        lh = lh * (1 - pull) + anchor * pull * HOME_ADV_GOALS[lg.type];
        la = la * (1 - pull) + anchor * pull;
        statsUsed = true;
      } else {
        // фолбэк — по рекордам из скорборда
        const rec = c => { const s = c.records?.[0]?.summary; if (!s) return null; const p = s.split('-').map(Number); return p.some(isNaN) ? null : p; };
        const rh = rec(home), ra = rec(away);
        if (!rh || !ra) continue;
        const winRate = (p, soccer) => { const [w, d = 0, l] = p; const g = w + d + l; return g ? (soccer ? (3 * w + d) / (3 * g) : w / g) : 0.5; };
        const ph = winRate(rh, kind === 'soccer'), pa = winRate(ra, kind === 'soccer');
        const share = (ph * 1.1) / (ph * 1.1 + pa);
        lh = avgTotal * share; la = avgTotal * (1 - share);
      }

      // xG-форма Understat: поправка к ожиданию по последним 5 завершённым матчам (без lookahead’а)
      let xgInfo = null;
      if (kind === 'soccer' && xgMap) {
        const xf = xgForm(xgMap, [home.team.displayName, away.team.displayName], e.date);
        if (xf) {
          const hb = xgBlend(xf.home, xf.L), ab = xgBlend(xf.away, xf.L);
          // атака дома + «продуваемость» гостей; атака гостей + оборона дома
          lh = lh * (hb.att * 0.5 + ab.def * 0.5);
          la = la * (ab.att * 0.5 + hb.def * 0.5);
          xgInfo = xf;
        }
      }

      const odds = parseOdds(comp);
      let oc;
      if (kind === 'basketball') {
        // очки — почти непрерывная величина: нормальное приближение вместо дискретного распределения
        oc = outcomesFromNormal(lh, la, odds?.totalLine || 224);
      } else {
        const mtx = scoreMatrix(lh, la);
        oc = outcomesFromMatrix(mtx);
        if (kind === 'hockey') {
          // ничья в основное время решается в OT: делим её ~55/45 в пользу хозяев
          const tie = oc.px;
          oc.p1 += tie * 0.55;
          oc.p2 += tie * 0.45;
          oc.px = 0;
        }
      }
      const totalLine = odds?.totalLine || 2.5;

      // собираем кандидатов рынков: {m, p, dec, i}
      // клиент сравнивает модельную вероятность с честной (devig) вероятностью линии
      const imp = odds?.implied;
      // двойной шанс: честная вероятность из двух честных вероятностей
      const dcImplied =
        imp && imp.px != null && imp.p2 != null ? imp.px + imp.p2 : null;
      const cand = [];
      if (kind === 'soccer') {
        cand.push({ m: 'П1', p: oc.p1, dec: odds?.dec.home, i: imp?.p1 });
        cand.push({ m: 'Х', p: oc.px, dec: odds?.dec.draw, i: imp?.px });
        cand.push({ m: 'П2', p: oc.p2, dec: odds?.dec.away, i: imp?.p2 });
        cand.push({ m: 'Х2', p: oc.px + oc.p2, dec: doubleChance(odds?.dec.draw, odds?.dec.away), i: dcImplied });
        cand.push({ m: 'ТБ 2.5', p: oc.over, dec: odds?.dec.over, i: imp?.over });
        cand.push({ m: 'ТМ 2.5', p: oc.under, dec: odds?.dec.under, i: imp?.under });
      } else if (kind === 'hockey') {
        cand.push({ m: 'П1', p: oc.p1, dec: odds?.dec.home, i: imp?.p1 });
        cand.push({ m: 'П2', p: oc.p2, dec: odds?.dec.away, i: imp?.p2 });
      } else {
        // баскетбол: тотал по линии ESPN, если она есть
        cand.push({ m: 'П1', p: oc.p1, dec: odds?.dec.home, i: imp?.p1 });
        cand.push({ m: 'П2', p: oc.p2, dec: odds?.dec.away, i: imp?.p2 });
        if (oc.over != null && odds?.dec.over) cand.push({ m: `ТБ ${totalLine}`, p: oc.over, dec: odds.dec.over, i: imp?.over });
        if (oc.under != null && odds?.dec.under) cand.push({ m: `ТМ ${totalLine}`, p: oc.under, dec: odds.dec.under, i: imp?.under });
      }
      for (const c of cand) c.edge = edgeOf(c.p, c.i);

      // лучший рынок: при наличии честной вероятности линии — максимальный edge;
      // без линии — максимальная вероятность (не ниже 50%)
      const withLine = cand.filter(c => c.i != null && c.p >= 0.45);
      const pool = withLine.length ? withLine : cand.filter(c => c.p >= 0.5);
      if (!pool.length) continue;
      pool.sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1) || b.p - a.p);
      const best = pool[0];
      // второй по величине рынок — для карточки (например, тотал)
      const second = cand.filter(c => c.m !== best.m && c.p >= 0.5).sort((a, b) => b.p - a.p)[0];

      // value-порог 5%: меньше — это шум, а не перевес (маржа линии уже снята devig)
      const value = best.edge != null && best.edge > 0.05;
      cand.forEach(c => { c.edgePct = c.edge != null ? Math.round(c.edge * 100) : null; });

      const homeRec = home.records?.[0]?.summary || '';
      const awayRec = away.records?.[0]?.summary || '';
      const extra = second && second.m !== best.m ? ` Дополнительно модель видит «${second.m}» с вероятностью ${pct(second.p)}%.` : '';
      const valTxt = best.edge != null
        ? (best.edge > 0.01
            ? ` Линия ${ru(best.dec)} недооценивает исход: перевес модели +${Math.round(best.edge * 100)}%.`
            : ` Линия ${ru(best.dec)} примерно совпадает с моделью.`)
        : '';
      // травмы из ESPN (если у лиги есть актуальный список) и xG-форма из Understat
      const injParts = [];
      const injH = injFor(injMap, home.team.id, home.team.displayName);
      const injA = injFor(injMap, away.team.id, away.team.displayName);
      if (injH) injParts.push(`${home.team.displayName} — ${injH.join(', ')}`);
      if (injA) injParts.push(`${away.team.displayName} — ${injA.join(', ')}`);
      const injNote = injParts.length ? ` Травмы: ${injParts.join('; ')}.` : '';
      const xgNote = xgInfo
        ? ` xG за последние ${xgInfo.home.n} игр: ${home.team.displayName} ${ru(xgInfo.home.xf)} за / ${ru(xgInfo.home.xa)} против, ${away.team.displayName} ${ru(xgInfo.away.xf)} / ${ru(xgInfo.away.xa)}.`
        : '';
      const modelLbl = statsUsed ? (xgInfo ? 'таблица лиги + xG-форма' : 'таблица лиги') : 'форма';
      const note = `${SCORE_LABEL[kind] || 'Ожидаемый счёт'}: ${ru(lh)} : ${ru(la)} (модель ${modelLbl}). `
        + `Исходы: П1 ${pct(oc.p1)}%${oc.px ? ` · Х ${pct(oc.px)}%` : ''} · П2 ${pct(oc.p2)}%. `
        + `Модель даёт ${pct(best.p)}% на «${best.m}».${valTxt}${extra}${injNote}${xgNote}`;

      preds.push({
        id: `${e.id}`,
        lgKey: lg.key, lgName: lg.name, sport: lg.sport, type: lg.type,
        home: home.team.displayName, away: away.team.displayName,
        homeLogo: home.team.logo || home.team.logos?.[0]?.href || null,
        awayLogo: away.team.logo || away.team.logos?.[0]?.href || null,
        time: fmtTime(e.date),
        matchDate: e.date,
        market: best.m,
        confidence: pct(best.p),
        modelProb: +best.p.toFixed(3),
        odds: best.dec || null,
        impliedProb: best.i != null ? +best.i.toFixed(3) : null,
        edge: best.edge != null ? +best.edge.toFixed(3) : null,
        value: !!value,
        expected: { home: +lh.toFixed(2), away: +la.toFixed(2) },
        markets: cand
          .filter(c => c.p >= 0.45)
          .sort((a, b) => b.p - a.p)
          .map(c => ({ market: c.m, prob: pct(c.p), odds: c.dec || null, edge: c.edgePct })),
        record: `${homeRec} / ${awayRec}`,
        note,
      });
      taken++;
    }
  } catch (err) {
    console.warn('league skip:', lg.key, String(err));
  }
}

// двойной шанс: 1/(1/dec1 + 1/dec2)
function doubleChance(d1, d2) {
  if (!d1 || !d2) return null;
  return 1 / (1 / d1 + 1 / d2);
}

if (!preds.length) {
  console.error('FAIL: 0 predictions — вероятно, ESPN недоступен. Прежние data/predictions.json не тронуты.');
  process.exit(1);
}

// архивируем предыдущий день
if (existsSync('data/predictions.json')) {
  try {
    const old = JSON.parse(readFileSync('data/predictions.json', 'utf8'));
    if (old.date && old.date !== dateStr) {
      mkdirSync('data/archive', { recursive: true });
      writeFileSync(`data/archive/${old.date}.json`, JSON.stringify(old, null, 2));
      console.log(`archived predictions for ${old.date}`);
    }
  } catch (e) { console.warn('archive skip:', String(e)); }
}

// порог уверенности: ниже него прогноз не показываем вовсе.
// free — не ниже 55%, pro (value) — не ниже 60%: слабые сигналы только портят доверие.
const FREE_MIN = 55, PRO_MIN = 60;
const pool = preds.filter(p => p.confidence >= FREE_MIN);
if (!pool.length) {
  console.error(`FAIL: 0 predictions with confidence >= ${FREE_MIN}% — все сигналы ниже порога. Прежние данные не тронуты.`);
  process.exit(1);
}

// тарификация: PRO = value-ставки (реальный перевес над линией), FREE = самые надёжные.
// в PRO попадают только value-ставки с уверенностью >= PRO_MIN; остальное — бесплатно.
const valueBets = pool.filter(p => p.value && p.confidence >= PRO_MIN).sort((a, b) => b.edge - a.edge);
const proCount = Math.min(5, Math.max(2, Math.round(pool.length * 0.4)));
const proIds = new Set(valueBets.slice(0, proCount).map(p => p.id));
// если value-ставок мало — добираем самыми уверенными (но не ниже PRO_MIN)
for (const p of pool.filter(p => !proIds.has(p.id) && p.confidence >= PRO_MIN).sort((a, b) => b.confidence - a.confidence)) {
  if (proIds.size >= proCount) break;
  proIds.add(p.id);
}
const final = pool
  .map(p => ({ ...p, tier: proIds.has(p.id) ? 'pro' : 'free' }))
  .sort((a, b) => b.confidence - a.confidence);

// «Ставка дня» (PRO): экспресс из 2–3 сильных сигналов.
// Условия честности: только уверенность >= 70% у каждой ноги, минимум 2 ноги.
// Приоритет — value-рынки (есть линия и перевес), потом по уверенности.
function pickBetOfTheDay(pool) {
  const strong = pool.filter(p => p.confidence >= 70);
  if (strong.length < 2) return null;
  const ranked = [...strong].sort((a, b) =>
    (Number(b.value) - Number(a.value)) ||
    ((b.edge ?? -9) - (a.edge ?? -9)) ||
    (b.confidence - a.confidence));
  const legs = ranked.slice(0, 3);
  const legOdds = (p) => (p.odds && p.odds > 1) ? p.odds : 1 / p.modelProb;
  return {
    legs: legs.map(p => ({
      id: p.id, home: p.home, away: p.away, market: p.market,
      odds: +legOdds(p).toFixed(2), confidence: p.confidence,
      sport: p.sport, league: p.lgName, value: !!p.value,
    })),
    combinedOdds: +legs.reduce((a, p) => a * legOdds(p), 1).toFixed(2),
    combinedProb: +legs.reduce((a, p) => a * p.modelProb, 1).toFixed(3),
    minConfidence: Math.min(...legs.map(p => p.confidence)),
  };
}
const botd = pickBetOfTheDay(final);

mkdirSync('data', { recursive: true });
writeFileSync('data/predictions.json', JSON.stringify({
  date: dateStr,
  generated: new Date().toISOString(),
  model: 'pxax-v2 @ ESPN standings + odds',
  count: final.length,
  valueCount: final.filter(p => p.value).length,
  thresholds: { freeMin: FREE_MIN, proMin: PRO_MIN, value: 0.05 },
  botd,
  predictions: final,
}, null, 2));
console.log(`OK: ${final.length} predictions (pro=${final.filter(p => p.tier === 'pro').length}, free=${final.filter(p => p.tier === 'free').length}, value=${final.filter(p => p.value).length}${botd ? `, bet-of-the-day: ${botd.legs.length} legs @ ${botd.combinedOdds}` : ''}) for ${dateStr} [free>=${FREE_MIN}%, pro>=${PRO_MIN}%]`);