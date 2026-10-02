// Генератор прогнозов на реальных данных ESPN (бесплатный API, без ключа).
// Запускается GitHub Actions раз в день. Модель: rules-v1.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const LEAGUES = [
  { key: 'soccer/eng.1', sport: '⚽', name: 'EPL', type: 'soccer' },
  { key: 'soccer/esp.1', sport: '⚽', name: 'La Liga', type: 'soccer' },
  { key: 'soccer/ita.1', sport: '⚽', name: 'Серия А', type: 'soccer' },
  { key: 'soccer/ger.1', sport: '⚽', name: 'Бундеслига', type: 'soccer' },
  { key: 'soccer/fra.1', sport: '⚽', name: 'Ligue 1', type: 'soccer' },
  { key: 'basketball/nba', sport: '🏀', name: 'NBA', type: 'us' },
  { key: 'hockey/nhl', sport: '🏒', name: 'NHL', type: 'us' },
];
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const mskNow = Date.now() + 3 * 3600e3;
const dateStr = new Date(mskNow).toISOString().slice(0, 10);
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');

async function scoreboard(key) {
  // без dates-параметра: ESPN отдаёт сегодняшние + ближайшие события (с рекордами)
  const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard`;
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
  if (g < 5) return null;
  return { w, d, l, g, s };
}

// сила команды: доля набранных очков
function strength(type, r) {
  if (type === 'soccer') return (3 * r.w + r.d) / (3 * r.g);
  return r.w / r.g;
}

function fmtTime(iso) {
  const t = new Date(new Date(iso).getTime() + 3 * 3600e3);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} МСК`;
}

const preds = [];
for (const lg of LEAGUES) {
  try {
    const events = await scoreboard(lg.key);
    let taken = 0;
    for (const e of events) {
      if (taken >= 2) break;
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
        time: fmtTime(e.date),
        market, odds: (0.93 / prob).toFixed(2),
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
