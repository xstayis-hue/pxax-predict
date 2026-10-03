// Генератор прогнозов на реальных данных ESPN (бесплатный API, без ключа).
// Запускается GitHub Actions раз в день. Модель: rules-v1.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

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
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const dateStr = new Date(mskNow).toISOString().slice(0, 10);
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');

async function scoreboard(key, ds) {
  // без dates-параметра ESPN отдаёт ближайший тур (с рекордами); для лиг США можно запросить конкретный день
  const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard${ds ? `?dates=${ds}` : ''}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  return j.events ?? [];
}

// разбор рекорда "W-D-L" (футбол) / "W-L" или "W-L-OT" (США)
function parseRec(c) {
  const s = c.records?.[0]?.summary;
  if (!s) return null;
  const p = s.split('-').map(Number);
  if (p.some(isNaN)) return null;
  let w, d = 0, l;
  if (p.length === 3) { [w, d, l] = p; }
  else if (p.length === 2) { [w, l] = p; }
  else return null;
  const g = w + d + l;
  if (g < 1) return null; // начало сезона: принимаем даже 1 игру
  return { w, d, l, g, s };
}

// сила команды: доля набранных очков со сжатием к 50% при малой выборке
// (шринк: 1 игра учитывается на 1/3, 5 игр — на 5/7 и т.д.)
function strength(type, r) {
  const raw = type === 'soccer' ? (3 * r.w + r.d) / (3 * r.g) : r.w / r.g;
  return 0.5 + (raw - 0.5) * (r.g / (r.g + 2));
}

function fmtTime(iso) {
  const t = new Date(new Date(iso).getTime() + 3 * 3600e3);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} МСК`;
}

const preds = [];
for (const lg of LEAGUES) {
  try {
    // лиги США: дефолтный скорборд + по дням (сегодня/завтра), дедуп по id
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
    let taken = 0;
    for (const e of events) {
      if (taken >= 5) break; // до 5 сигналов с лиги за прогон
      // окно свежести: старт минимум через 6 часов и не позже чем через 48 часов
      const t = new Date(e.date).getTime();
      if (t < Date.now() + 6 * 3600e3 || t > Date.now() + 48 * 3600e3) continue;
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away || e.status?.type?.state !== 'pre') continue;
      const rh = parseRec(home), ra = parseRec(away);
      if (!rh || !ra) continue;

      const sh = strength(lg.type, rh) * 1.1; // домашнее преимущество
      const sa = strength(lg.type, ra);
      let market, prob, note;
      if (lg.type === 'soccer') {
        let pX = Math.max(0.12, 0.26 - 0.35 * Math.abs(sh - sa) / (sh + sa));
        let p1 = (1 - pX) * sh / (sh + sa);
        let p2 = (1 - pX) - p1;
        const opts = [
          { m: 'П1', p: p1 },
          { m: 'П2', p: p2 },
          { m: 'Х2', p: pX + p2 },
        ].sort((a, b) => b.p - a.p);
        market = opts[0].m; prob = opts[0].p;
        note = `Форма: ${home.team.displayName} ${rh.s} (очков/матч ${(3 * rh.w + rh.d) / rh.g > 0 ? ((3 * rh.w + rh.d) / rh.g).toFixed(2) : '-'}) против ${away.team.displayName} ${ra.s} (${((3 * ra.w + ra.d) / ra.g).toFixed(2)}). Модель с домашним фактором даёт ${(prob * 100).toFixed(0)}% на ${market}.`;
      } else {
        const p1 = sh / (sh + sa);
        market = p1 >= 0.5 ? 'П1' : 'П2';
        prob = Math.max(p1, 1 - p1);
        note = `Баланс сил: ${home.team.displayName} ${rh.s} против ${away.team.displayName} ${ra.s}. Процент побед выше у фаворита, модель учитывает домашнюю площадку: ${(prob * 100).toFixed(0)}%.`;
      }
      prob = Math.min(0.78, Math.max(0.4, prob));
      preds.push({
        id: `${e.id}`,
        lgKey: lg.key, lgName: lg.name, sport: lg.sport, type: lg.type,
        home: home.team.displayName, away: away.team.displayName,
        homeLogo: home.team.logo || home.team.logos?.[0]?.href || null,
        awayLogo: away.team.logo || away.team.logos?.[0]?.href || null,
        time: fmtTime(e.date),
        matchDate: e.date,
        market,
        confidence: Math.round(prob * 100),
        note,
      });
      taken++;
    }
  } catch (err) {
    console.warn('league skip:', lg.key, String(err));
  }
}

// архивируем предыдущий день, чтобы не терять неразрешённые прогнозы
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

// сортируем по уверенности: самые уверенные -> VIP, остальные -> free
preds.sort((a, b) => b.confidence - a.confidence);
const n = preds.length;
const proCount = n ? Math.min(5, Math.max(2, n - 3)) : 0;
preds.forEach((p, i) => { p.tier = i < proCount ? 'pro' : 'free'; });

mkdirSync('data', { recursive: true });
writeFileSync('data/predictions.json', JSON.stringify({
  date: dateStr,
  generated: new Date().toISOString(),
  model: 'rules-v1 @ ESPN data',
  predictions: preds,
}, null, 2));
console.log(`OK: ${n} predictions (pro=${proCount}, free=${n - proCount}) for ${dateStr}`);
