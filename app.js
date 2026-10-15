/* ================= Telegram SDK ================= */
const { quotaStatus, visibleHistoryCount } = window.PxaxHistoryUi;
const tg = window.Telegram?.WebApp;
const isTg = !!tg;
if (tg) { try { tg.expand(); tg.disableVerticalSwipes?.(); tg.setHeaderColor?.('#0a0d16'); tg.setBackgroundColor?.('#0a0d16'); } catch(e) {} }
const user = tg?.initDataUnsafe?.user;

/* Вид спорта приходит из data/*.json — эмодзи оставляем на карточках прогнозов,
   штриховые иконки используем в фильтрах, истории и небольших UI-элементах. */
function ic(name, cls) {
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
/* Вид спорта приходит из data/*.json эмодзи — сопоставляем с иконкой и русским именем */
const SPORTS = {
  '⚽': ['soccer', 'Футбол'], '🏀': ['basketball', 'Баскетбол'],
  '🏒': ['hockey', 'Хоккей'], '🎮': ['cyber', 'Киберспорт'],
};
function sportIcon(s) { return ic(SPORTS[s] ? SPORTS[s][0] : 'trophy'); }
function sportName(s) { return SPORTS[s] ? SPORTS[s][1] : 'Спорт'; }
// Эмодзи вида спорта используются в карточках прогнозов и фоновом водяном знаке.
function sportEmoji(s) { return SPORTS[s] ? s : '🏆'; }

/* Тактильный отклик: на ощупь Mini App отличается от веб-страницы не меньше, чем
   визуально. На старых клиентах HapticFeedback отсутствует — глушим. */
function haptic(kind) {
  try {
    const h = tg && tg.HapticFeedback; if (!h) return;
    if (kind === 'impact') h.impactOccurred('light');
    else if (kind === 'medium') h.impactOccurred('medium');
    else if (kind === 'success') h.notificationOccurred('success');
    else if (kind === 'error') h.notificationOccurred('error');
    else h.selectionChanged();
  } catch (e) {}
}

/* ================= реальные данные (GitHub Actions -> data/*.json) ================= */
const REAL = { loaded: false, status: 'loading', error: null, proError: null, date: null, free: [], pro: [], results: null, backtest: null, botd: null, lastUpdate: null, proCount: 0, botdLegs: 0 };
// отпечатки загруженных файлов — чтобы автообновление не перерисовывало UI, когда данные не изменились
let feedFingerprint = null, resultsFp = null, backtestFp = null, proFp = null;
function resultsFingerprint(j) { return j.map(r => r.id + '|' + r.result).join(';'); }
function historyCountForFilter(filter) {
  return visibleHistoryCount(REAL.results,
    filter,
    dayKey(new Date(Date.now() - CONFIG.STAT_DAYS * 86400000)));
}
function feedFresh(d) {
  const generated = new Date(d?.generated || '').getTime();
  const age = Date.now() - generated;
  const feedDay = Date.parse(`${d.date}T00:00:00Z`);
  const todayDay = Date.parse(`${today}T00:00:00Z`);
  const priorDay = Number.isFinite(feedDay) && todayDay - feedDay === 86400e3;
  if (!Array.isArray(d?.predictions) || !d?.date || !Number.isFinite(generated) || generated > Date.now() + 5 * 60 * 1000
    || age > 30 * 3600 * 1000 || (d.date !== today && !priorDay)) return null;
  if (d.date !== today || age > 6 * 3600 * 1000) return 'grace';
  const targetPro = Number(d.targets?.pro);
  const targetFree = Number(d.targets?.free);
  const limitPro = Number(d.limits?.pro);
  const limitFree = Number(d.limits?.free);
  const freeCount = Number(d.freeCount ?? d.count);
  const proCount = Number(d.proCount);
  const shortfallPro = Number(d.shortfall?.pro);
  const shortfallFree = Number(d.shortfall?.free);
  if ([targetPro, targetFree, limitPro, limitFree, freeCount, proCount, shortfallPro, shortfallFree].some(value => !Number.isFinite(value))) return 'legacy';
  if (targetPro !== 3 || targetFree !== 3 || limitPro !== 5 || limitFree !== 5
    || freeCount < 0 || freeCount > limitFree || proCount < 0 || proCount > limitPro
    || freeCount !== d.predictions.length || shortfallFree !== Math.max(0, 3 - freeCount)
    || shortfallPro !== Math.max(0, 3 - proCount)) return 'legacy';
  return 'fresh';
}
function availablePredictions(predictions) {
  const now = Date.now();
  return predictions.filter(p => {
    const kickoff = new Date(p.matchDate || '').getTime();
    return Number.isFinite(kickoff) && kickoff > now && kickoff <= now + 72 * 3600 * 1000;
  });
}
async function loadReal() {
  REAL.status = 'loading';
  try {
    const r = await fetch('data/predictions.json?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) {
      REAL.status = 'error';
      REAL.error = `Ошибка загрузки прогнозов (HTTP ${r.status})`;
      throw new Error('HTTP ' + r.status);
    }
    const d = await r.json();
    if (!d || !Array.isArray(d.predictions) || !d.date) throw new Error('bad_feed');
    const freshness = feedFresh(d);
    feedFingerprint = (d.generated || '') + '|' + (d.date || '');
    REAL.loaded = true;
    REAL.lastUpdate = d.generated || null;
    if (freshness) {
      REAL.status = freshness;
      REAL.feedTargets = d.targets || { free: 3, pro: 3 };
      REAL.feedLimits = d.limits || { free: 5, pro: 5 };
      const visibleFree = availablePredictions(d.predictions.filter(p => !p.tier || p.tier === 'free'));
      const publishedProCount = freshness === 'fresh' ? Math.min(REAL.feedLimits.pro, Number(d.proCount) || 0) : 0;
      const freeCount = Number(d.freeCount ?? d.count);
      const legacySchema = freshness === 'legacy';
      REAL.feedShortfall = {
        free: freshness === 'fresh' ? Number(d.shortfall.free) : Math.max(0, 3 - Math.min(3, visibleFree.length)),
        pro: freshness === 'fresh' ? Number(d.shortfall.pro) : 3,
      };
      REAL.error = freshness === 'grace' ? `Показываем предыдущий выпуск за ${d.date}; ждём новый выпуск.`
        : legacySchema ? `Обнаружена старая структура ленты (${freeCount} кандидатов, ${publishedProCount} PRO-сигналов); ждём публикации обновлённой квоты.` : null;
      REAL.date = d.date;
      REAL.free = visibleFree;
      REAL.proCount = publishedProCount;
      proTotalToday = publishedProCount;
      REAL.botdLegs = Number(d.botdLegs) || 0;
    } else {
      REAL.status = 'stale';
      REAL.date = d.date;
      REAL.error = `Данные прогнозов устарели: ${d.date}`;
      REAL.free = [];
    }
  } catch (e) {
    REAL.status = 'error';
    REAL.error = 'Не удалось загрузить реальные прогнозы';
    console.warn('Failed to load predictions:', e);
  }
  try {
    const r = await fetch('data/results.json?v=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length) { REAL.results = j; resultsFp = resultsFingerprint(j); }
    }
  } catch (e) { console.warn('Failed to load results:', e); }
  try {
    const r = await fetch('data/backtest.json?v=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.mode === 'archived-production' && j.signals > 0) { REAL.backtest = j; backtestFp = j.evaluationWindowDays + ':' + j.resolved + ':' + j.signals; }
    }
  } catch (e) { /* бэктест — необязательный бонус */ }
}

/* ================= settings ================= */
const CONFIG = {
  VERSION: '0.9.5', // версия приложения для отслеживания обновлений
  SUBSCRIBE_URL: 'https://t.me/pxaxbetai_bot',
  /* Адрес бэкенда оплаты. Держим его здесь, потому что мини-апп — один файл без сборки.
     Сейчас это Cloudflare Worker (worker/ в репозитории) — у него постоянный адрес,
     в отличие от прежнего cloudflared-туннеля, который менялся при каждом перезапуске
     и из-за этого «отваливалась» оплата. Пока адрес не вписан, кнопки оплаты уводят
     в чат бота. */
  API_BASE: 'https://pxaxbet-payments.xstayis.workers.dev',
  FREE_DAILY: 5,   // максимум отображаемых Free прогнозов; фактическая квота приходит из feed.targets
  PRO_DAILY: 5,    // максимум отображаемых PRO прогнозов; фактическая квота приходит из feed.targets
  STAT_DAYS: 14,   // окно статистики и списка истории (должны совпадать)
  // Минимум решённых прогнозов у каждого вида, чтобы сравнивать Базовый и VIP.
  // Меньше — разница объясняется случайностью, и писать «заходят чаще» нельзя.
  MIN_CMP_N: 20,
  // --- банк бота (раздел в разработке, ещё не открыт) ---
  // Считается по data/results.json: плоская ставка на каждый сигнал с линией.
  // Пока BANK_ENABLED=false — вкладки нет вовсе и прямой переход на view-bank
  // ничего не открывает. Раздел сначала обкатываем на своих (тест в браузере,
  // сравнение с бэктестом), и только потом включаем флагом.
  BANK_ENABLED: false,
  BANK_START: 1000,   // стартовый баланс, условные единицы
  BANK_STAKE: 10,     // размер ставки, условные единицы (плоская схема)
  // Ниже этого числа ставок банк не публикуем даже у себя: на коротком отрезке
  // итог целиком в разбросе, и цифра вводит в заблуждение.
  BANK_MIN_BETS: 40,
  // --- партнёрская программа ---
  PARTNER_URL: 'https://r1wjvzfr.life/?p=gfuv',
  PROMO: 'PXAXBET2026',
  // --- экосистема PXAX ---
  ECOSYSTEM_LINKS: {
    pxaxai: 'https://t.me/PxAxAi_bot',
    predict: 'https://t.me/pxaxbetai_bot',
    phxcoin: 'https://t.me/phxcryptocoin_bot',
    vph: 'https://t.me/Vphoenixx_bot',
  },
};

// партнёрская ссылка с суб-метками: sub1 = id прогноза, sub2 = экран
function betLink(p) {
  return CONFIG.PARTNER_URL + '&sub1=' + encodeURIComponent(p.id) +
         '&sub2=' + (p.kind === 'pro' ? 'pro' : 'free');
}
function betBtn(p) {
  return `<a class="bet-btn" data-plink="${betLink(p)}" href="${betLink(p)}" rel="noopener">${ic('external')} Сделать ставку в БК</a>`;
}
// «Я поставил» — личная отметка в трекере ставок (localStorage, без сервера)
function myBetBtn(p, isHistory) {
  if (!p || !p.id || !p.kind || isHistory) return '';
  const on = !!loadBets()[String(p.id)];
  return `<button class="mybet-btn${on ? ' on' : ''}" data-bid="${p.id}">${on ? ic('check') + ' Ставка отмечена' : ic('receipt') + ' Я поставил'}</button>`;
}

function dayKey(d = new Date()) {
  // всё приложение живёт по МСК (как генератор и аудитория) — иначе после полуночи даты разъезжаются с data/*.json
  return new Date((d instanceof Date ? d.getTime() : d) + 3 * 3600e3).toISOString().slice(0, 10);
}
// дата матчасти: только цифры в чипе + относительность (сегодня/завтра/скорость) отдельным тегом
function matchDateInfo(iso) {
  if (!iso) return { chip: '', rel: null, hours: null };
  const ms = new Date(iso).getTime();
  const d = new Date(ms + 3 * 3600e3); // -> МСК
  const dm = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const hours = (ms - Date.now()) / 3600e3;
  const dd = d.toISOString().slice(0, 10);
  const todayMsk = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const tomorrowMsk = new Date(Date.now() + 3 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  let rel = null;
  if (dd === todayMsk) rel = 'today';
  else if (dd === tomorrowMsk) rel = 'tomorrow';
  return { chip: `${dm} · `, rel, hours };
}
// русская плюрализация: plural(5, 'прогноз', 'прогноза', 'прогнозов')
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function collectStats(days, onlyKind) {
  // 'all' — это не вид прогноза, а отсутствие фильтра: раньше строка ниже
  // сравнивала r.kind с 'all' и отбрасывала всё, поэтому на вкладке
  // «Статистика» всегда было 0/0/0, хотя данные есть
  if (onlyKind === 'all') onlyKind = null;
  // реальные результаты (если есть) — приоритет над моком
  if (REAL.results) {
    let hits = 0, miss = 0, total = 0, preSkip = 0;
    const cutoff = dayKey(new Date(Date.now() - days * 86400000));
    for (const r of REAL.results) {
      if (r.date < cutoff) continue;
      if (onlyKind && r.kind !== onlyKind) continue;
      // preseason-матчи в статистику не берём: модель считает силу команд по
      // таблицам регулярного сезона, а в предсезонке играют ротацией — такие
      // результаты искажали проходимость в обе стороны. Но их число считаем
      // (preSkip) и показываем отдельной строкой: иначе выходило, что часть
      // отданных подписчику PRO-прогнозов просто исчезала из статистики.
      if (r.preseason) { preSkip++; continue; }
      total++;
      if (r.result === 'hit') hits++;
      else if (r.result === 'half_win') hits += 0.5;
      else if (r.result === 'miss') miss++;
      else if (r.result === 'half_loss') miss += 0.5;
    }
    return { hits, miss, total, preSkip, rate: (hits + miss) ? Math.round(hits / (hits + miss) * 100) : 0 };
  }
  const hits = 0, miss = 0, total = 0;
  return { hits, miss, total, preSkip: 0, rate: 0 };
}
/* ================= user state ================= */
let statFilter = 'all'; // all | free | pro
let historyVisibleCount = 20;
const HISTORY_PAGE_SIZE = 20;
let historyFingerprint = null;
let sportFilter = 'all'; // all | вид спорта из данных
function applySportFilter(list) {
  if (sportFilter === 'all') return list;
  return list.filter(p => p.sport === sportFilter);
}
// строим панель фильтра по видам спорта из доступных прогнозов
function renderSportFilter() {
  const el = document.getElementById('sportFilter');
  if (!el) return;
  const all = [...freeToday, ...proToday];
  const sports = [...new Set(all.map(p => p.sport))];
  if (sports.length < 2) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const items = [{ k: 'all', t: 'Все', icon: '' },
    ...sports.map(s => ({ k: s, t: sportName(s), icon: sportIcon(s) }))];
  if (!items.some(i => i.k === sportFilter)) sportFilter = 'all';
  el.innerHTML = items.map(i =>
    `<button class="sf-btn ${i.k === sportFilter ? 'on' : ''}" data-sf="${i.k}">${i.icon}${i.t}</button>`).join('');
  el.querySelectorAll('.sf-btn').forEach(b => {
    b.onclick = () => { sportFilter = b.dataset.sf; haptic(); render(); };
  });
}
/* Кеш статуса PRO для офлайн-старта. Источник правды — ответ сервера
   (`/api/status` перезаписывает это значение при каждой загрузке), поэтому
   подмена строки в localStorage открывает VIP-экраны только до ответа сервера.
   Отдельно стоит помнить: прогнозы PRO лежат в публичном data/predictions.json,
   так что пейвол здесь — витрина, а не защита контента (см. README, «Что дальше»). */
const store = {
  get pro() { return localStorage.getItem('pxax_pro') === '1'; },
  set pro(v) { localStorage.setItem('pxax_pro', v ? '1' : '0'); },
};
/* ================= личный трекер ставок (только localStorage) =================
   Пользователь отмечает «Я поставил» на карточке. П/Л считается после того,
   как матч появится в data/results.json: win = (kэф-1)·stake, miss = -stake, push = 0.
   Коэффициент — из results.json (храним и свой на момент отметки — запасной). */
const BETS_KEY = 'pxax_bets_v2';
const STAKE_KEY = 'pxax_stake';
function loadBets() {
  try { const j = JSON.parse(localStorage.getItem(BETS_KEY)); return (j && typeof j === 'object') ? j : {}; }
  catch (e) { return {}; }
}
function saveBets(b) { try { localStorage.setItem(BETS_KEY, JSON.stringify(b)); } catch (e) {} }
function currentStake() {
  const s = Math.round(+localStorage.getItem(STAKE_KEY));
  return Number.isFinite(s) && s >= 1 ? s : 100;
}
// отметить/снять отметку; id = id прогноза (id события ESPN)
function toggleBet(p) {
  if (!p || !p.id || !p.kind) return;
  const b = loadBets();
  const key = String(p.id);
  if (b[key]) {
    delete b[key];
    saveBets(b);
    haptic();
    toast('Ставка снята с отслеживания');
  } else {
    b[key] = {
      date: p.matchDate ? String(p.matchDate).slice(0, 10) : today, kind: p.kind, market: p.market,
      odds: p.odds || null, confidence: p.confidence,
      home: p.home, away: p.away, league: p.league, sport: p.sport,
      at: new Date().toISOString(),
    };
    saveBets(b);
    haptic('medium');
    toast('Отметили: ' + p.market + ' · ' + (p.home || '') + ' — ' + (p.away || ''));
  }
  render();
}
// сводка: P/L, ROI, стрики — только по завершённым матчам (results.json)
function myBetStats() {
  const bets = loadBets();
  const ids = Object.keys(bets);
  const resById = new Map();
  for (const r of (REAL.results || [])) if (r.id != null) resById.set(String(r.id), r);
  const stake = currentStake();
  const rows = [];
  for (const id of ids) {
    const b = bets[id];
    const r = resById.get(id) || null;
    const odds = Number(r && r.odds) || Number(b.odds) || 0;
    rows.push({ id, b, r, odds, done: !!(r && r.result) });
  }
  const done = rows.filter(x => x.done).sort((a, b2) =>
    (a.r.date || '').localeCompare(b2.r.date || '') || (a.b.at || '').localeCompare(b2.b.at || ''));
  let wins = 0, losses = 0, pushes = 0, pnl = 0, staked = 0, noOdds = 0;
  for (const x of done) {
    const res = x.r.result;
    if (res === 'hit' || res === 'half_win') {
      wins++;
      if (x.r.profitUnits != null) { pnl += stake * Number(x.r.profitUnits); staked += stake; }
      else if (x.odds > 1) { pnl += stake * (x.odds - 1); staked += stake; }
      else noOdds++;
    } else if (res === 'miss' || res === 'half_loss') {
      losses++;
      if (x.r.profitUnits != null) { pnl += stake * Number(x.r.profitUnits); staked += stake; }
      else if (x.odds > 1) { pnl -= stake; staked += stake; }
      else noOdds++;
    } else pushes++;
  }
  // текущий стрик — с самого последнего результата назад
  let wStreak = 0, lStreak = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const res = done[i].r.result;
    if (res === 'hit') { wStreak++; if (lStreak) break; }
    else if (res === 'miss') { lStreak++; if (wStreak) break; }
  }
  const decided = wins + losses;
  return {
    total: ids.length, decided, wins, losses, pushes, noOdds,
    rate: decided ? Math.round(wins / decided * 100) : null,
    pnl: +pnl.toFixed(2), staked,
    roi: staked ? +((pnl / staked) * 100).toFixed(1) : null,
    wStreak, lStreak,
    rows: done.slice(-12).reverse(),
  };
}
/* ================= БАНК БОТА (в разработке) =================
   Считает, как выглядел бы счёт бота, если на каждый решённый сигнал с линией
   ставить одинаковую сумму (условные единицы). Переиспользует логику личного
   трекера (myBetStats): win = stake·(кэф−1), miss = −stake, push = 0.
   Ставки без линии в счёт не идут — им нельзя приписать результат, и они
   честно показываются отдельным числом.

   Раздел ещё не открыт (CONFIG.BANK_ENABLED=false): вкладки нет, прямой переход
   на view-bank закрыт. Смысл держать код здесь — обкатать на своих данных, прежде
   чем показывать людям. */
function bankRoll(kind) {
  const start = CONFIG.BANK_START, stake = CONFIG.BANK_STAKE;
  const rows = (REAL.results || []).filter(r =>
    !r.preseason && (kind ? r.kind === kind : true) && ['hit', 'miss', 'half_win', 'half_loss'].includes(r.result));
  const dated = rows.filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  let bank = start, peak = start, maxDD = 0, wins = 0, losses = 0, staked = 0, noOdds = 0;
  const series = [{ date: dated[0]?.date || '', bank: start }];
  for (const r of dated) {
    const odds = Number(r.odds);
    if (!(odds > 1)) { noOdds++; continue; }
    if (r.result === 'hit' || r.result === 'half_win') { bank += stake * (Number.isFinite(Number(r.profitUnits)) ? Number(r.profitUnits) : odds - 1); wins++; }
    else { bank += stake * (Number.isFinite(Number(r.profitUnits)) ? Number(r.profitUnits) : -1); losses++; }
    staked += stake;
    peak = Math.max(peak, bank);
    maxDD = Math.max(maxDD, peak - bank);
    if (series[series.length - 1].date !== r.date) series.push({ date: r.date, bank: +bank.toFixed(2) });
    else series[series.length - 1].bank = +bank.toFixed(2);
  }
  const decided = wins + losses;
  const days = new Set(dated.filter(r => Number(r.odds) > 1).map(r => r.date)).size;
  return {
    start, stake, bets: decided, noOdds, wins, losses, days,
    bank: +bank.toFixed(2),
    profit: +(bank - start).toFixed(2),
    growth: +(((bank / start) - 1) * 100).toFixed(1),
    roi: staked ? +(((bank - start) / staked) * 100).toFixed(1) : null,
    maxDD: +maxDD.toFixed(2),
    maxDDPct: peak ? +((maxDD / peak) * 100).toFixed(1) : null,
    rate: decided ? Math.round(wins / decided * 100) : null,
    series,
    recent: [...dated].filter(r => Number(r.odds) > 1).reverse().slice(0, 20),
    trusted: decided >= CONFIG.BANK_MIN_BETS,
  };
}
function renderBank() {
  const host = document.getElementById('bankBody');
  if (!host) return;
  // Раздел закрыт для всех до отдельного решения: показываем внутреннюю
  // заглушку с честной причиной, а не пустой экран.
  if (!CONFIG.BANK_ENABLED) {
    host.innerHTML = `<div class="empty"><span class="i">${ic('lock')}</span>
      Раздел в разработке.<br>Собираем историю ставок, чтобы банк был честным с первого показа.<br>
      <span class="bank-off">Пока недоступно даже подписчикам — включим, когда сами убедимся, что считает верно.</span></div>`;
    return;
  }
  const b = bankRoll(null);
  const proB = bankRoll('pro');
  if (!b.bets) {
    host.innerHTML = `<div class="empty"><span class="i">${ic('chart')}</span>Пока нет ставок с линией — банк начнёт считаться, как только сыграют первые матчи с кэфом.</div>`;
    return;
  }
  // Раздел задуман для подписчиков PRO. Когда флаг включат, без подписки видно
  // только витрину: баланс и график под замком, история ставок не рендерится —
  // как и в остальном приложении, платный контент в DOM не попадает.
  const pro = store.pro;
  if (!pro) {
    host.innerHTML = `
      <div class="bk-top">
        <div class="bk-bal">
          <div class="bk-lbl">Баланс бота</div>
          <div class="bk-num locked-num">· · ·</div>
          <div class="bk-sub">старт ${b.start} у.е. · схема ${b.stake} у.е. на сигнал</div>
        </div>
        <div class="bk-kpis">
          <div class="bk-kpi"><b>${b.bets}</b><span>ставок</span></div>
          <div class="bk-kpi"><b>${b.days}</b><span>дней</span></div>
        </div>
      </div>
      <div class="paywall-cta">
        <h3><svg class="ic"><use href="#i-lock"/></svg> Банк бота — в PRO</h3>
        <p>Подписчик видит счёт бота, кривую баланса и каждую прошедшую ставку: на что ставил, с каким кэфом и чем закончилось.</p>
        <button class="btn-sub plan-price" data-open="bank" onclick="goSubscribe()">Оформить PRO · 777 <svg class="ic"><use href="#i-star"/></svg> / 30 дней</button>
      </div>
      <div class="bk-note">Условные единицы. Это не деньги и не платёжное средство. Прошлые результаты не гарантируют будущих. 18+.</div>`;
    return;
  }
  const sign = b.profit >= 0 ? '+' : '';
  const cls = b.profit >= 0 ? 'good' : 'neutral';
  const pcls = proB.profit >= 0 ? 'good' : 'neutral';
  // график: нормализуем серию в точки SVG
  const W = 300, H = 76;
  const vals = b.series.map(s => s.bank);
  const lo = Math.min(...vals, b.start), hi = Math.max(...vals, b.start);
  const span = (hi - lo) || 1;
  const pts = b.series.map((s, i) => {
    const x = b.series.length > 1 ? (i / (b.series.length - 1)) * W : W;
    const y = H - ((s.bank - lo) / span) * (H - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const baseY = H - ((b.start - lo) / span) * (H - 8) - 4;
  const rows = b.recent.map(r => {
    const hit = r.result === 'hit';
    return `<div class="bk-row ${hit ? 'hit' : 'miss'}">
      <span class="bk-d">${r.date.slice(5)}</span>
      <span class="bk-m">${r.home} — ${r.away}</span>
      <span class="bk-k">${r.market}</span>
      <span class="bk-o">${Number(r.odds).toFixed(2)}</span>
      <span class="bk-r">${hit ? 'зашло' : 'мимо'}</span>
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="bk-top">
      <div class="bk-bal">
        <div class="bk-lbl">Баланс бота</div>
        <div class="bk-num ${b.profit >= 0 ? 'up' : 'down'}">${b.bank.toFixed(0)} <span>у.е.</span></div>
        <div class="bk-sub">старт ${b.start} · ${sign}${b.growth}%</div>
      </div>
      <div class="bk-kpis">
        <div class="bk-kpi"><b>${b.rate}%</b><span>заходов</span></div>
        <div class="bk-kpi"><b>${b.roi == null ? '—' : (b.roi > 0 ? '+' : '') + b.roi + '%'}</b><span>ROI</span></div>
        <div class="bk-kpi"><b>${b.bets}</b><span>ставок</span></div>
        <div class="bk-kpi"><b>${b.days}</b><span>дней</span></div>
      </div>
    </div>
    <div class="bk-chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="${baseY.toFixed(1)}" x2="${W}" y2="${baseY.toFixed(1)}" class="bk-base"/>
        <polyline points="${pts}" class="bk-line ${b.profit >= 0 ? 'up' : 'down'}"/>
      </svg>
    </div>
    <div class="bk-note">Схема: плоская ставка ${b.stake} у.е. на каждый сигнал с линией. Ставки без линии (${b.noOdds}) в счёт не идут. Макс. просадка ${b.maxDD} у.е. (${b.maxDDPct}% от пика).</div>
    ${b.trusted ? '' : `<div class="bank-warn">${ic('eye')} Пока ${b.bets} ${plural(b.bets, 'ставка', 'ставки', 'ставок')} — этого мало, чтобы судить о результате: разброс на такой выборке больше самого итога. Цифра честная, но ещё не показательна.</div>`}
    <div class="section-title">${ic('diamond')} Банк Pro-ИИ · отдельный отбор</div>
    <div class="bk-pro ${pcls}">
      <span>${proB.bets} ставок · ${proB.rate == null ? '—' : proB.rate + '%'} заходов</span>
      <b>${proB.bank.toFixed(0)} у.е. (${proB.profit >= 0 ? '+' : ''}${proB.growth}%)</b>
    </div>
    <div class="section-title">История ставок бота</div>
    <div class="bk-list">${rows}</div>
    <div class="bk-note">Условные единицы. Это не деньги и не платёжное средство. Ставки на спорт — риск; прошлые результаты не гарантируют будущих. 18+.</div>`;
}
// блокируем прямой переход на закрытый раздел
function openBankIfEnabled() {
  if (!CONFIG.BANK_ENABLED) { toast('Раздел в разработке — откроем позже'); return false; }
  return true;
}
/* Кнопка «Банк бота» в разделе PRO. Видна только подписчику: до покупки её нет
   вовсе (иначе это реклама закрытого раздела неплательщику). Пока раздел в
   разработке — кнопка не нажимается и помечена «скоро»: подписчик видит, что она
   у него появится, и понимает, что приложение развивается. Как только
   CONFIG.BANK_ENABLED станет true, та же кнопка начнёт открывать раздел. */
function renderBankCta() {
  const host = document.getElementById('bankCta');
  if (!host) return;
  if (!store.pro) { host.innerHTML = ''; return; }
  const soon = !CONFIG.BANK_ENABLED;
  host.innerHTML = `
    <button class="bank-cta ${soon ? 'soon' : ''}" ${soon ? 'disabled aria-disabled="true"' : `onclick="openBank()"`}>
      <span class="bc-ico"><svg class="ic"><use href="#i-coin"/></svg></span>
      <span class="bc-txt">
        <b>Банк бота</b>
        <span>${soon ? 'Считаем историю · откроется скоро' : 'Счёт, кривая баланса и все ставки'}</span>
      </span>
      ${soon
        ? `<span class="bc-soon">скоро</span>`
        : `<span class="bc-go"><svg class="ic"><use href="#i-arrowright"/></svg></span>`}
    </button>`;
}
function openBank() {
  if (!openBankIfEnabled()) return;
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-bank').classList.add('active');
  renderBank();
  haptic();
  window.scrollTo(0, 0);
}

// кнопка «Я поставил» на карточках — делегирование (колонда пересобирается)
document.addEventListener('click', (e) => {
  const el = e.target.closest('.mybet-btn');
  if (!el || el.disabled) return;
  e.preventDefault(); e.stopPropagation();
  const id = el.dataset.bid;
  const all = freeToday.concat(proToday);
  const p = all.find(x => String(x.id) === id);
  if (p) toggleBet(p);
}, true);
const today = dayKey();
let visits = +(localStorage.getItem('pxax_visits') || 0);
let streak = +(localStorage.getItem('pxax_streak') || 0);
const last = localStorage.getItem('pxax_last');
if (last !== today) {
  visits++;
  streak = (last === dayKey(new Date(Date.now() - 86400000))) ? streak + 1 : 1;
  localStorage.setItem('pxax_visits', visits);
  localStorage.setItem('pxax_streak', streak);
  localStorage.setItem('pxax_last', today);
}
// запоминаем последний открытый таб
let lastTab = localStorage.getItem('pxax_last_tab') || 'home';
// сохраняем версию приложения для возможной диагностики; уведомления при обновлении не показываем
localStorage.setItem('pxax_version', CONFIG.VERSION);

let freeToday = [];
let proToday = [];
// Сколько PRO-прогнозов есть на сервере. Публичный файл отдаёт только число —
// сам список приходит с /api/pro и лишь подписчику. Без подписки показываем это
// число в пейволе, чтобы человек видел, что покупает.
let proTotalToday = proToday.length;

/* ================= учёт реально просмотренных прогнозов ================= */
function markViewed(deck, i) {
  let seen = { d: today, keys: [] };
  try {
    const s = JSON.parse(localStorage.getItem('pxax_seen') || 'null');
    if (s && s.d === today) seen = s;
  } catch (e) {}
  const key = deck + ':' + i;
  if (seen.keys.includes(key)) return;
  seen.keys.push(key);
  if (seen.keys.length > 300) seen.keys = seen.keys.slice(-300);
  localStorage.setItem('pxax_seen', JSON.stringify(seen));
  localStorage.setItem('pxax_viewed', +(localStorage.getItem('pxax_viewed') || 0) + 1);
}

/* ================= swipe deck component ================= */
function makeDeck(trackEl, navEl, count, deckId) {
  // нативный scroll-snap: свайп делает сам браузер — работает в любом webview
  let index = 0, moved = false, lastLeft = 0, drag = null;
  const dots = [];
  navEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const d = document.createElement('button');
    d.className = 'dn'; d.onclick = () => goTo(i);
    navEl.appendChild(d); dots.push(d);
  }
  function setDots() { dots.forEach((d, j) => d.classList.toggle('on', j === index)); }
  function goTo(i, instant) {
    index = Math.max(0, Math.min(count - 1, i));
    trackEl.scrollTo({ left: index * trackEl.clientWidth, behavior: instant ? 'auto' : 'smooth' });
    setDots();
  }
  // синхронизация со свайпом/инерцией
  trackEl.addEventListener('scroll', () => {
    const left = trackEl.scrollLeft;
    if (Math.abs(left - lastLeft) > 8) moved = true;
    lastLeft = left;
    const i = Math.round(left / (trackEl.clientWidth || 1));
    if (i !== index) { index = i; setDots(); markViewed(deckId, i); haptic('impact'); }
    clearTimeout(trackEl._movedT);
    trackEl._movedT = setTimeout(() => moved = false, 250);
  }, { passive: true });
  // перетаскивание мышью (десктоп/превью)
  trackEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return; // тач — нативный скролл
    drag = { x: e.clientX, left: trackEl.scrollLeft };
    trackEl.setPointerCapture?.(e.pointerId);
  });
  trackEl.addEventListener('pointermove', e => {
    if (!drag) return;
    trackEl.scrollLeft = drag.left - (e.clientX - drag.x);
  });
  const mouseUp = e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    drag = null;
    goTo(dx < -40 ? index + 1 : dx > 40 ? index - 1 : index);
  };
  trackEl.addEventListener('pointerup', mouseUp);
  trackEl.addEventListener('pointercancel', () => { drag = null; goTo(index); });
  // после свайпа не срабатывают клики по кнопкам внутри карточки
  trackEl.addEventListener('click', e => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
  }, true);
  goTo(0, true);
  markViewed(deckId, 0); // первая карточка видна сразу
  return { goTo };
}

/* ================= cards ================= */
function teamBadge(logo, sport) {
  const safeLogo = typeof logo === 'string' && /^https:\/\/a\.espncdn\.com\//.test(logo) ? logo : '';
  const fallback = `<span${safeLogo ? ' hidden' : ''}>${sportEmoji(sport)}</span>`;
  const image = safeLogo
    ? `<img src="${safeLogo}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false">`
    : '';
  return `<div class="badge">${image}${fallback}</div>`;
}

function slideHTML(p, unlocked, isPro, isHistory) {
  const res = isHistory && p.result ? `<div class="res-chip ${p.result.cls}">${ic(p.result.label)}</div>` : '';
  const mdi = matchDateInfo(p.matchDate);
  // тег срочности: <24ч — красный пульсирующий «через N ч», иначе нейтральное «завтра»
  let statusTag = '';
  if (!isHistory && mdi.hours !== null) {
    statusTag = mdi.hours < 24
      ? `<span class="soon-tag">${ic('bolt')} через ${Math.max(1, Math.round(mdi.hours))} ч</span>`
      : `<span class="rel-tag">завтра</span>`;
  }
  // VALUE-бейдж и сравнение с линией — это оплачиваемый сигнал PRO: генератор
  // больше не кладёт value/edge/impliedProb в публичный файл, поэтому на
  // бесплатных карточках их нет вовсе. Здесь проверка по isPro — подстраховка,
  // если запись всё же пришла со старых данных или из VIP-фида в чужую колоду.
  const showEdge = !!isPro;
  const valBadge = (!isHistory && showEdge && p.value && p.edge != null && p.edge > 0.05) ? `<span class="value-badge">${ic('bolt')} VALUE</span>` : '';
  // строка линии: коэффициент; вероятность линии и перевес модели — только PRO
  let lineChip = '';
  if (!isHistory && p.odds) {
    const imp = showEdge && p.impliedProb != null ? Math.round(p.impliedProb * 100) : null;
    const edge = showEdge && p.edge != null ? Math.round(p.edge * 100) : null;
    const edgeCls = edge > 0 ? 'up' : 'down';
    const edgeTxt = edge == null ? '' : `${edge > 0 ? '+' : ''}${edge}%`;
    const edgeLabel = edge == null ? '' : edge > 0 ? 'перевес модели' : 'модель ниже линии';
    lineChip = `<div class="line-chip">
      <span>Линия <b>${p.odds.toFixed(2)}</b>${imp != null ? ` · вероятность линии <b>${imp}%</b>` : ''}</span>
      ${edge != null ? `<span class="edge ${edgeCls}">${edgeLabel} ${edgeTxt}</span>` : ''}
    </div>`;
  }
  // дополнительные рынки: спрятаны под раскрывашку, чтобы не спорить с вердиктом
  const others = (!isHistory && Array.isArray(p.markets))
    ? p.markets.filter(m => m.market !== p.market).slice(0, 3) : [];
  const extraMarkets = others.length
    ? `<details class="more-markets">
        <summary>ещё ${others.length} ${others.length === 1 ? 'рынок' : 'рынка'} от ИИ</summary>
        <div class="mm-list">${others.map(m =>
          `<div class="mm-row"><span class="mm-name">${m.market}</span><span class="mm-prob">${m.prob}%</span>${
            m.odds ? `<span class="mm-odds">кэф ${m.odds.toFixed(2)}</span>` : ''}</div>`).join('')}</div>
      </details>`
    : '';
  // HERO-вердикт — единственное место, куда должен падать взгляд: рынок и
  // вероятность модели рядом. Блок отдельный (.verdict-hero), чтобы его скос,
  // кант и свечение не зависели от остальной карточки.
  const heroBlock = `
          <div class="verdict-hero">
            <div class="vh-label">Прогноз ИИ</div>
            <div class="vh-main">
              <div class="vh-market">${p.market}</div>
              <div class="vh-prob">${p.confidence}%</div>
            </div>
            <div class="vh-bar"><i data-w="${p.confidence}"></i></div>
          </div>`;
  // Заблокированная карточка: сам прогноз (рынок, кэф, перевес, разбор) в разметку
  // не попадает — вместо него обезличенные плейсхолдеры. До этого контент размывался
  // CSS-фильтром, и в кадре до/во время применения blur VIP-ставка читалась.
  const maskedBody = `
        <div class="p-top">
          <span class="sport">${sportEmoji(p.sport)}</span><span>${p.league}</span>
          <span class="ai-tag pro">${ic('diamond')} Pro AI</span>
        </div>
        <div class="p-body">
          <div class="verdict-hero locked-hero">
            <div class="vh-label">Прогноз ИИ</div>
            <div class="vh-main">
              <div class="lock-ph vh-ph-market"></div>
              <div class="lock-ph vh-ph-prob"></div>
            </div>
            <div class="vh-bar"><i data-w="62"></i></div>
          </div>
          <div class="lock-ph lp-teams"></div>
          <div class="lock-ph lp-line"></div>
          <div class="lock-ph lp-note"></div>
        </div>`;
  const openBody = `
          <div class="p-top">
            <span class="sport">${sportEmoji(p.sport)}</span><span>${p.league}</span>
            <span class="ai-tag ${isPro ? 'pro' : ''}">${isPro ? ic('diamond') + ' Pro AI' : ic('cpu') + ' AI'}</span>
            ${statusTag}
            ${valBadge}
          </div>
          <div class="p-body">
            <div class="teams">
              <div class="team">
                ${teamBadge(p.homeLogo, p.sport)}
                <div class="tname">${p.home}</div>
              </div>
              <div class="vs-badge">VS</div>
              <div class="team">
                ${teamBadge(p.awayLogo, p.sport)}
                <div class="tname">${p.away}</div>
              </div>
            </div>
            <div class="time-chip">${ic('clock')} ${isHistory ? 'вчера · ' : ''}${mdi.chip}${p.time}</div>
          </div>
          ${heroBlock}
          ${lineChip}
          ${extraMarkets}
          <div class="bet-wrap">${betBtn(p) + myBetBtn(p, isHistory)}</div>
          <div class="ai-note"><b>${isPro ? 'Pro-разбор:' : 'Разбор ИИ:'}</b> ${p.note}</div>
          `;
  return `
    <div class="slide ${unlocked ? '' : 'locked'}">
      <div class="p-card ${isPro ? 'pro-card' : ''}">
        ${res}
        <div class="wm" aria-hidden="true">${sportEmoji(p.sport)}</div>
        <div class="blur">${unlocked ? openBody : maskedBody}
        </div>
        ${unlocked ? '' : `
        <div class="lock-overlay">
          <div class="ico">${ic('lock')}</div>
          <span>Только для PRO</span>
          <button onclick="goSubscribe()">Открыть доступ</button>
        </div>`}
      </div>
    </div>`;
}

/* ================= render ================= */
function animateNum(el, target, suffix = '') {
  const t0 = performance.now(), dur = 800;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + suffix;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

let freeDeckObj, proDeckObj;

function render() {
  const pro = store.pro;
  const isFreshFeed = REAL.status === 'fresh';
  const reportedPro = isFreshFeed ? Math.max(0, Math.min(5, Number(REAL.proCount) || 0)) : null;
  const pageTarget = { free: CONFIG.FREE_DAILY, pro: CONFIG.PRO_DAILY };
  const visibleHistoryLabelCount = historyCountForFilter(statFilter);
  document.getElementById('subBadge').className = 'sub-badge ' + (pro ? 'pro' : 'free');
  document.getElementById('subBadge').textContent = pro ? 'pro' : 'free';
  document.getElementById('profSub').textContent = pro ? 'PRO активна' : 'нет';
  document.querySelectorAll('.vsn').forEach(e => e.textContent = CONFIG.VERSION);
  document.getElementById('profVisits').textContent = visits;
  document.getElementById('streakV').textContent = streak;
  syncTrialButtons();

  // честная статистика: показываем цифры только по реальным завершённым матчам
  const hasReal = !!(REAL.results && REAL.results.length);
  const statsAll = hasReal ? collectStats(CONFIG.STAT_DAYS) : null;
  const statsView = hasReal ? collectStats(CONFIG.STAT_DAYS, statFilter) : null;
  // честная статистика: живая история считается надёжной, когда её >= 20;
  // меньше — честно пишем «собираем данные» и (если есть) даём бэктест модели.
  // preseason-строки в размер выборки не идут: они не про модель (см. collectStats)
  const liveN = hasReal ? REAL.results.filter(r => !r.preseason).length : 0;
    const bt = REAL.backtest && REAL.backtest.mode === 'archived-production' && REAL.backtest.signals >= 30 && REAL.backtest.hitRate != null ? REAL.backtest : null;
  const rateEl = document.getElementById('statRate');
  const rateLbl = document.querySelector('#view-home .stats .stat .l');
  if (hasReal && liveN >= 20) {
    rateEl.textContent = statsAll.rate + '%';
    if (rateLbl) rateLbl.textContent = 'заходов 14д';
  } else if (hasReal && liveN > 0) {
    rateEl.textContent = statsAll.rate + '%';
    if (rateLbl) rateLbl.textContent = 'заходов · ' + liveN + ' рез.';
  } else if (bt) {
    rateEl.textContent = Math.round(Number(bt.hitRate) * 100) + '%';
    if (rateLbl) rateLbl.textContent = `архив · ${bt.evaluationWindowDays}д · n=${bt.signals}`;
  } else {
    rateEl.textContent = '—';
    if (rateLbl) rateLbl.textContent = 'заходов 14д';
  }
  // Плашка «собираем данные / цифры недостоверны» убрана (v0.7.2):
  // каждая цифра и так считается по реальным завершённым матчам (data/results.json,
  // ESPN final scores), а пометка «недостоверно» мешала объективно оценивать потенциал.
  // Размер выборки всё равно виден в подписи счётчика («заходов · N рез.»).
  const cEl = document.getElementById('collectChip');
  if (cEl) cEl.hidden = true;
  document.getElementById('statFree').textContent = freeToday.length;
  const limit = REAL.feedLimits?.pro ?? CONFIG.PRO_DAILY;
  document.getElementById('statProCnt').textContent = reportedPro == null ? '—' : quotaStatus(reportedPro, limit, 3);
  document.getElementById('hHits').textContent = hasReal ? statsView.hits : '—';
  document.getElementById('hMiss').textContent = hasReal ? statsView.miss : '—';
  document.getElementById('hRate').textContent = hasReal ? statsView.rate + '%' : '—';
  document.getElementById('pTotal').textContent = hasReal ? statsAll.total : '—';
  document.getElementById('pHits').textContent = hasReal ? statsAll.hits : '—';
  document.getElementById('pMiss').textContent = hasReal ? statsAll.miss : '—';
  document.getElementById('pRate').textContent = hasReal ? statsAll.rate + '%' : '—';
  // динамические счётчики вместо захардкоженных
  const quotaLabel = isFreshFeed ? ` · ${quotaStatus(reportedPro, limit, 3)}` : '';
  document.getElementById('payProTitle').textContent = `Pro-ИИ · value-отбор${quotaLabel}`;
  document.getElementById('proCnt').textContent = reportedPro == null
    ? REAL.status === 'legacy' ? 'Старый выпуск · квота не подтверждена' : 'Сегодняшняя PRO-квота ещё не загружена'
    : `PRO-сигналы${quotaLabel}`;
  renderBetOfTheDay();

  // колоды (+ честные пустые состояния, если матчей в окне нет)
  const freeView = applySportFilter(freeToday);
  const proView = applySportFilter(proToday);
  renderSportFilter();
  const EMPTY_DECK = `<div class="empty" style="margin:0">${ic(REAL.status === 'error' ? 'x' : 'clock')} ${REAL.error || 'В ближайшие 72 часа нет реальных матчей, прошедших фильтры качества.'}</div>`;
  const ft = document.getElementById('freeTrack');
  const pt = document.getElementById('proTrack');
  if (freeView.length) {
    ft.innerHTML = freeView.map(p => slideHTML(p, true, false, false)).join('');
    freeDeckObj = makeDeck(ft, document.getElementById('freeNav'), freeView.length, 'free');
  } else {
    ft.innerHTML = EMPTY_DECK;
    document.getElementById('freeNav').innerHTML = '';
  }
  if (proView.length) {
    pt.innerHTML = proView.map(p => slideHTML(p, pro, true, false)).join('');
    proDeckObj = makeDeck(pt, document.getElementById('proNav'), proView.length, 'pro');
  } else if (!pro && proTotalToday > 0) {
    // Подписки нет, но сигналы на сервере есть: показываем замок, а не «матчей нет» —
    // иначе человек решит, что PRO сегодня пустой, и не станет платить.
    pt.innerHTML = `<div class="empty" style="margin:0">${ic('lock')} Сегодня ${proTotalToday} ${plural(proTotalToday, 'сигнал Pro-ИИ', 'сигнала Pro-ИИ', 'сигналов Pro-ИИ')} — открываются с подпиской.</div>`;
    document.getElementById('proNav').innerHTML = '';
  } else {
    const reason = REAL.proError || REAL.error || (REAL.status === 'fresh'
      ? `PRO: ${quotaStatus(Math.min(5, proTotalToday), Math.max(3, proTotalToday), 3)} после фильтра качества.`
      : 'PRO-фид ещё обновляется.');
    pt.innerHTML = `<div class="empty" style="margin:0">${ic(REAL.proError ? 'x' : 'diamond')} ${reason}</div>`;
    document.getElementById('proNav').innerHTML = '';
  }
  const shortfall = { free: Math.max(0, pageTarget.free - freeToday.length), pro: Math.max(0, pageTarget.pro - proTotalToday) };
  const shownProCount = isFreshFeed ? Math.min(5, proTotalToday) : 0;
  const historyCount = document.getElementById('historyCount');
  if (historyCount) historyCount.textContent = `${visibleHistoryLabelCount} результатов за ${CONFIG.STAT_DAYS} дней`;
  document.getElementById('paywallCta').style.display = (pro || !proTotalToday) ? 'none' : 'block';
  document.getElementById('proPaywall').style.display = (pro || !proTotalToday) ? 'none' : 'block';
  const proCountLabel = document.getElementById('proCnt');
  if (payProTitle && isFreshFeed && shortfall.pro > 0) payProTitle.textContent = `Pro-ИИ · расчётный перевес; ${shortfall.pro} сигналов не достигли порога качества`;
  if (proCountLabel) proCountLabel.textContent = isFreshFeed
    ? `PRO-сигналы · ${quotaStatus(shownProCount, Math.max(3, shownProCount), 3)}`
    : REAL.status === 'legacy' ? 'Старый выпуск · квота не подтверждена'
      : 'Сегодняшняя PRO-квота ещё не загружена';

  // статистика прошедших прогнозов
  const hEl = document.getElementById('historyList');
  hEl.innerHTML = '';
  let dIdx = 0;
  const kinds = statFilter === 'all' ? ['pro', 'free'] : [statFilter];
  const addH = (home, away, sub, cls, label, unlocked) => {
    const el = document.createElement('div');
    el.className = 'h-item ' + cls;
    el.style.setProperty('--d', (dIdx++ * .04) + 's');
    el.innerHTML = `
      <div class="r">${label}</div>
      <div class="m">
        <div class="t">${home} — ${away}</div>
        <div class="s">${sub}</div>
      </div>
      <div class="o">${unlocked ? '' : ic('lock')}</div>`;
    hEl.appendChild(el);
  };
  if (REAL.results) {
    // окно списка — то же, что у цифр выше (CONFIG.STAT_DAYS), иначе подпись
    // «7 дней» расходилась бы с верхними счётчиками за 14 дней
    const cutoff = dayKey(new Date(Date.now() - CONFIG.STAT_DAYS * 86400000));
    const rows = REAL.results
      .filter(r => r.date >= cutoff && kinds.includes(r.kind) && !r.preseason)
      .sort((a, b) => b.date.localeCompare(a.date));
    const nextHistoryFingerprint = `${statFilter}:${rows.map(r => `${r.id}:${r.date}:${r.result}`).join('|')}`;
    if (historyFingerprint !== nextHistoryFingerprint) {
      historyFingerprint = nextHistoryFingerprint;
      historyVisibleCount = HISTORY_PAGE_SIZE;
    }
    const visibleRows = rows.slice(0, historyVisibleCount);
    for (const r of visibleRows) {
      const cls = r.result === 'hit' || r.result === 'half_win' ? 'hit' : r.result === 'miss' || r.result === 'half_loss' ? 'miss' : 'push';
      const label = ic(r.result === 'hit' || r.result === 'half_win' ? 'check' : r.result === 'miss' || r.result === 'half_loss' ? 'x' : 'clock');
      addH(r.home, r.away,
        `${sportIcon(r.sport)} ${r.league} · <span class="${r.kind === 'pro' ? 'pro' : 'ai'}">${r.kind === 'pro' ? 'Pro AI' : 'AI'}</span> · ${r.market} · счёт ${r.score}`,
        cls, label, pro || r.kind === 'free');
    }
    const pager = document.getElementById('historyPager');
    const more = document.getElementById('historyMore');
    const less = document.getElementById('historyLess');
    if (pager) pager.hidden = rows.length <= HISTORY_PAGE_SIZE;
    if (more) {
      more.hidden = historyVisibleCount >= rows.length;
      more.textContent = `Показать ещё ${Math.min(HISTORY_PAGE_SIZE, Math.max(0, rows.length - historyVisibleCount))}`;
    }
    if (less) less.hidden = historyVisibleCount <= HISTORY_PAGE_SIZE;
    const historyProgress = document.getElementById('historyProgress');
    if (historyProgress) historyProgress.textContent = `Показано ${visibleRows.length} из ${rows.length}`;
  } else {
    historyFingerprint = null;
    historyVisibleCount = HISTORY_PAGE_SIZE;
    const historyProgress = document.getElementById('historyProgress');
    if (historyProgress) historyProgress.textContent = 'Показано 0';
    const pager = document.getElementById('historyPager');
    if (pager) pager.hidden = true;
  }
  // сколько preseason-строк отдано и исключено из статистики: показываем честно,
  // чтобы выпавшие матчи не выглядели подчисткой убыточных прогнозов
  const preNote = document.getElementById('preNote');
  if (preNote) {
    const preInfo = hasReal ? collectStats(CONFIG.STAT_DAYS, statFilter) : null;
    const nPre = preInfo ? preInfo.preSkip : 0;
    if (nPre > 0) {
      preNote.hidden = false;
      preNote.innerHTML = `${ic('eye')} Ещё ${nPre} ${plural(nPre, 'предсезонный матч', 'предсезонных матча', 'предсезонных матчей')} не ${plural(nPre, 'учтён', 'учтены', 'учтены')} выше: модель считает силу команд по регулярному сезону, а в предсезонке играют ротацией.`;
    } else {
      preNote.hidden = true;
    }
  }
  // подпись окна истории берём из CONFIG.STAT_DAYS, а не хардкодом
  const histTitle = document.getElementById('histTitle');
  if (histTitle) histTitle.textContent = `Прошедшие прогнозы ИИ · ${CONFIG.STAT_DAYS} дней`;
  if (!dIdx) {
    hEl.innerHTML = `<div class="empty"><span class="i">${ic('chart')}</span>Здесь появится статистика прошедших прогнозов.<br>Первые результаты — как только сыграют первые матчи.</div>`;
  }

  // профиль
  document.getElementById('profName').textContent =
    user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'Гость';
  document.getElementById('profId').textContent = user ? user.id : '—';
  const av = document.getElementById('profAvatar');
  if (user?.photo_url) av.innerHTML = `<img src="${user.photo_url}" alt="">`;
  else av.textContent = user ? (user.first_name?.[0] || '?').toUpperCase() : '?';
  let since = localStorage.getItem('pxax_since');
  if (!since) { localStorage.setItem('pxax_since', today); since = today; }
  document.getElementById('profSince').textContent =
    'в приложении с ' + new Date(since + 'T00:00:00').toLocaleDateString('ru-RU', { day:'numeric', month:'short' });

  renderProfileExtras(statsAll);
  renderMyBets();
  renderBank();
  renderBankCta();

  // полосы уверенности (в hero-вердикте)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.vh-bar i').forEach(i => i.style.width = i.dataset.w + '%');
  }));
  tickFresh();
}

/* ================= ставка дня (PRO-экспресс) ================= */
function renderBetOfTheDay() {
  const wrap = document.getElementById('botdWrap');
  if (!wrap) return;
  const pro = store.pro;
  const botd = REAL.botd;
  const valid = botd && Array.isArray(botd.legs) && botd.legs.length >= 2
    && botd.minConfidence >= 70 && Number.isFinite(Number(botd.combinedOdds));
  if (!valid) {
    // Без подписки самого экспресса в данных нет (он приходит только с /api/pro).
    // Показываем тизер по числу ног из публичного файла: сколько ног сегодня есть,
    // но без матчей, рынков и кэфов — они и есть платный контент.
    if (!pro && REAL.botdLegs >= 2) {
      wrap.hidden = false;
      document.getElementById('botdLegs').innerHTML = Array.from({ length: REAL.botdLegs },
        () => `<div class="botd-leg"><span class="lock-ph" style="height:14px;flex:1"></span></div>`).join('');
      document.getElementById('botdOdds').textContent = '—.—';
      document.getElementById('botdDetail').textContent =
        `экспресс на ${REAL.botdLegs} · матчи, рынки и кэфы открываются с PRO`;
      document.getElementById('botdLock').style.display = 'flex';
      document.getElementById('botdLink').style.visibility = 'hidden';
      return;
    }
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  // Экспресс дня тоже под пейволом: без PRO матчи, рынки и кэфы в DOM не рендерим,
  // иначе ноги экспресса лежали в разметке под blur-оверлеем и читались в кадре до его отрисовки.
  const legOdds = document.getElementById('botdOdds');
  const legDetail = document.getElementById('botdDetail');
  if (pro) {
    document.getElementById('botdLegs').innerHTML = botd.legs.map(l => `
    <div class="botd-leg">
      <span>${sportIcon(l.sport)}</span>
      <span class="lg-m">${l.home} — ${l.away} · ${l.market}</span>
      <span class="lg-p">${l.confidence}%</span>
      <span class="lg-o">${Number(l.odds).toFixed(2)}</span>
    </div>`).join('');
    legOdds.textContent = Number(botd.combinedOdds).toFixed(2);
    legDetail.textContent =
      `экспресс на ${botd.legs.length} · все ноги ≥ ${botd.minConfidence}% · совм. вероятность модели ${Math.round((botd.combinedProb || 0) * 100)}%`;
  } else {
    document.getElementById('botdLegs').innerHTML = `
    <div class="botd-leg"><span class="lock-ph" style="height:14px;flex:1"></span></div>
    <div class="botd-leg"><span class="lock-ph" style="height:14px;flex:1"></span></div>`;
    legOdds.textContent = '—.—';
    legDetail.textContent = `экспресс на ${botd.legs.length} · ноги и кэфы открываются с PRO`;
  }
  document.getElementById('botdLock').style.display = pro ? 'none' : 'flex';
  document.getElementById('botdLink').style.visibility = pro ? 'visible' : 'hidden';
}

/* ================= мои ставки: профиль ================= */
function renderMyBets() {
  const s = myBetStats();
  const el = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  el('bTotal', s.total);
  el('bWins', s.wins);
  el('bLoss', s.losses);
  el('bRate', s.rate == null ? '—' : s.rate + '%');
  el('bPnl', s.decided ? (s.pnl > 0 ? '+' : '') + String(s.pnl).replace('.', ',') : '—');
  el('bRoi', s.roi == null ? '—' : (s.roi > 0 ? '+' : '') + s.roi + '%');
  const st = document.getElementById('bStreak');
  if (st) {
    st.innerHTML = s.decided
      ? (s.wStreak > 0 ? `${ic('flame')} Серия: <b>${s.wStreak}</b> ${s.wStreak === 1 ? 'победа' : 'побед'} подряд`
        : s.lStreak > 0 ? `${ic('trenddown')} Серия: <b>${s.lStreak}</b> ${s.lStreak === 1 ? 'проигрыш' : 'проигрышей'} подряд`
        : '—')
      : (s.total ? 'Поставь матчи доиграют — P/L появится автоматически' : 'Отмечай «Я поставил» на карточках — трекер сам посчитает P/L и ROI');
  }
  // размер ставки
  const inp = document.getElementById('stakeInput');
  if (inp) {
    if (document.activeElement !== inp) inp.value = currentStake();
    if (!inp.dataset.wired) {
      inp.dataset.wired = '1';
      inp.addEventListener('change', () => {
        const v = Math.round(+inp.value);
        if (Number.isFinite(v) && v >= 1) { localStorage.setItem(STAKE_KEY, String(v)); renderMyBets(); toast('Размер ставки: ' + v + ' усл. ед.'); }
        else inp.value = currentStake();
      });
    }
  }
  // последние 12 с результатом
  const list = document.getElementById('myBetList');
  if (list) {
    list.innerHTML = '';
    if (!s.rows.length) {
      list.innerHTML = '<div class="empty" style="margin:0">Здесь появятся результаты твоих отмеченных ставок — как только матчи сыграют.</div>';
    } else {
      for (const x of s.rows) {
        const icon = ic(x.r.result === 'hit' ? 'check' : x.r.result === 'miss' ? 'x' : 'clock');
        let pnlTxt = '';
        if (x.r.result === 'hit' && x.odds > 1) pnlTxt = `+${(currentStake() * (x.odds - 1)).toFixed(2)}`;
        else if (x.r.result === 'miss' && x.odds > 1) pnlTxt = `-${currentStake()}`;
        else if (x.r.result === 'push') pnlTxt = '0 (возврат)';
        const d = (x.b.date || '').slice(5);
        const item = document.createElement('div');
        item.className = 'h-item ' + (x.r.result === 'hit' ? 'hit' : x.r.result === 'miss' ? 'miss' : 'push');
        item.innerHTML = `
          <div class="r">${icon} ${pnlTxt ? '<b style="font-size:11px">' + pnlTxt + '</b>' : ''}</div>
          <div class="m">
            <div class="t">${x.b.home || ''} — ${x.b.away || ''}</div>
            <div class="s">${x.b.market}${x.odds > 1 ? ' @' + Number(x.odds).toFixed(2).replace('.', ',') : ''} · ${x.b.league || ''}${d ? ' · ' + d : ''}</div>
          </div>`;
        list.appendChild(item);
      }
    }
  }
}

/* ================= профиль: уровень, ачивки, привычки, сравнение ================= */
const LEVELS = [
  { xp: 0,   icon: 'sprout', name: 'Новичок' },
  { xp: 60,  icon: 'target', name: 'Игрок' },
  { xp: 160, icon: 'chart', name: 'Аналитик' },
  { xp: 320, icon: 'diamond', name: 'Профи' },
  { xp: 600, icon: 'crown', name: 'Легенда' },
];

function renderProfileExtras(statsAll) {
  // XP: визиты + стрик + просмотренные прогнозы + подписка
  const viewed = +(localStorage.getItem('pxax_viewed') || 0);
  const xp = visits * 10 + streak * 15 + viewed + (store.pro ? 60 : 0);
  let li = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].xp) li = i;
  const cur = LEVELS[li];
  const next = LEVELS[li + 1];
  document.getElementById('lvlIcon').innerHTML = ic(cur.icon);
  document.getElementById('lvlName').textContent = cur.name;
  document.getElementById('lvlSub').textContent = next ? `до «${next.name}» осталось ${next.xp - xp} XP` : 'максимальный уровень';
  document.getElementById('xpNow').textContent = xp + ' XP';
  document.getElementById('xpNext').textContent = next ? next.xp + ' XP' : 'MAX';

  // достижения
  const since = localStorage.getItem('pxax_since') || today;
  const daysWith = Math.max(1, Math.round((Date.now() - new Date(since + 'T00:00:00')) / 86400000) + 1);
  document.getElementById('daysWith').textContent = daysWith;
  const bets = +(localStorage.getItem('pxax_bets') || 0);
  document.getElementById('betClicks').textContent = bets;
  const achs = [
    { i: 'play', t: 'Первый запуск', ok: visits >= 1 },
    { i: 'flame', t: '3 дня подряд', ok: streak >= 3 },
    { i: 'bolt', t: '7 дней подряд', ok: streak >= 7 },
    { i: 'diamond', t: 'PRO-игрок', ok: store.pro },
    { i: 'calendar', t: 'Неделя с нами', ok: daysWith >= 7 },
    { i: 'eye', t: '100 прогнозов', ok: viewed >= 100 },
    { i: 'receipt', t: 'Первая ставка', ok: Object.keys(loadBets()).length >= 1 },
    { i: 'trendup', t: 'ROI +10%', ok: (myBetStats().roi || 0) >= 10 },
  ];
  document.getElementById('achGrid').innerHTML =
    achs.map(a => `<div class="ach ${a.ok ? 'on' : ''}"><div class="i">${ic(a.i)}</div><div class="t">${a.t}</div></div>`).join('');

  // любимый спорт строится только по реальным результатам за 14 дней
  const sportCnt = {};
  if (REAL.results && REAL.results.length) {
    const cutoff = dayKey(new Date(Date.now() - 14 * 86400000));
    for (const r of REAL.results) {
      if (r.date < cutoff) continue;
      sportCnt[r.sport] = (sportCnt[r.sport] || 0) + 1;
    }
  }
  const fav = Object.entries(sportCnt).sort((a, b) => b[1] - a[1])[0];
  if (fav) {
    document.getElementById('favSportI').innerHTML = sportIcon(fav[0]);
    document.getElementById('favSportV').textContent = sportName(fav[0]);
  }

  // XP-бар — анимируем после вставки
  requestAnimationFrame(() => {
    const pct = next ? Math.min(100, Math.round((xp - cur.xp) / (next.xp - cur.xp) * 100)) : 100;
    document.getElementById('xpFill').style.width = pct + '%';
  });

  // сравнение Базовый vs VIP — честный вердикт (только по реальным данным)
  const v = document.getElementById('verdict');
  const hasRealCmp = !!(REAL.results && REAL.results.length);
  if (!hasRealCmp) {
    document.getElementById('cmpFree').textContent = '—';
    document.getElementById('cmpFreeD').textContent = 'мало данных';
    document.getElementById('cmpPro').textContent = '—';
    document.getElementById('cmpProD').textContent = 'мало данных';
    v.className = 'verdict neutral';
      const bt = REAL.backtest && REAL.backtest.mode === 'archived-production' && REAL.backtest.signals >= 30 && REAL.backtest.hitRate != null ? REAL.backtest : null;
    const reportRate = bt && Number(bt.hits) + Number(bt.losses)
      ? Math.round(Number(bt.hits) / (Number(bt.hits) + Number(bt.losses)) * 100)
      : null;
    v.innerHTML = bt
      ? `${ic('eye')} Архивная оценка реальных бесплатных прогнозов за ${bt.evaluationWindowDays} дней: ${reportRate}% (${bt.hits} выигрышных эквивалентов / ${bt.signals} решений), Brier ${bt.brier}; ROI ${bt.roi == null ? 'нет' : bt.roi + '%'} только на ${bt.roiBets} прогнозах с сохранённым коэффициентом. Исторических PRO-снимков нет; это не доказательство будущей доходности.`
      : `${ic('eye')} Статистика появится после первых сыгранных матчей — пока сравнивать нечего.`;
    return;
  }
  const sf = collectStats(CONFIG.STAT_DAYS, 'free');
  const sp = collectStats(CONFIG.STAT_DAYS, 'pro');
  document.getElementById('cmpFree').textContent = sf.rate + '%';
  document.getElementById('cmpFreeD').textContent = `${sf.hits} из ${sf.hits + sf.miss}`;
  document.getElementById('cmpPro').textContent = sp.rate + '%';
  document.getElementById('cmpProD').textContent = `${sp.hits} из ${sp.hits + sp.miss}`;
  // Вердикт о преимуществе VIP — только когда у обоих видов набрана достаточная
  // выборка. На 4 из 5 разница «+9 п.п.» целиком внутри случайного разброса
  // (95% интервал для 4/5 — примерно 38–96%), и писать «подписка может окупиться»
  // на таких данных нельзя: это продающее утверждение без основания.
  const nFree = sf.hits + sf.miss, nPro = sp.hits + sp.miss;
  const diff = sp.rate - sf.rate;
  if (nFree < CONFIG.MIN_CMP_N || nPro < CONFIG.MIN_CMP_N) {
    v.className = 'verdict neutral';
    v.innerHTML = `${ic('eye')} Для сравнения нужно хотя бы ${CONFIG.MIN_CMP_N} решённых прогнозов у каждого вида — сейчас Базовый ${nFree}, VIP ${nPro}. На такой выборке разница ничего не доказывает, поэтому честного вердикта пока нет.`;
    return;
  }
  if (diff >= 5) {
    v.className = 'verdict good';
    v.innerHTML = `${ic('diamond')} VIP-прогнозы заходят чаще на <b>${diff} п.п.</b> — подписка может окупиться. Но помни: <b>вероятность не 100%</b>.`;
  } else if (diff <= -5) {
    v.className = 'verdict neutral';
    v.innerHTML = `${ic('eye')} Сейчас VIP заходит <b>реже</b> базового (${Math.abs(diff)} п.п.) — платить не обязательно. Следи за статистикой.`;
  } else {
    v.className = 'verdict neutral';
    v.innerHTML = `${ic('eye')} Разница пока небольшая (${Math.abs(diff)} п.п.) — ясности нет, стоит ли платить. Решение за тобой · 18+.`;
  }
}

/* ================= UI wiring ================= */
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}
async function goSubscribe() {
  document.querySelector('[data-view="pro"]').click();
  // Реальная оплата Telegram Stars. Основной способ — openInvoice нативной ссылкой
  // воркера: счёт открывается сразу в вебвью, не нужно искать его в чате. Если воркер
  // или версия клиента не поддерживают openInvoice — падаем на счёт из чата бота.
  if (isTg && tg?.initData && apiReady()) {
    try {
      haptic('impact');
      toast('Готовлю счёт…');
      const r = await fetch(CONFIG.API_BASE + '/api/invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData || '' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (j.ok && j.invoiceUrl && tg.openInvoice) {
        haptic('impact');
        let settled = false;
        tg.openInvoice(j.invoiceUrl, async (status) => {
          settled = true;
          if (status === 'paid') {
            haptic('success');
            toast('Оплата прошла — включаю PRO');
          } else if (status === 'failed') {
            haptic('error');
            toast('Оплата не прошла, попробуй ещё раз');
            return;
          }
          // Вебвью не всегда отдаёт колбэк (и статус может прийти раньше вебхука),
          // поэтому доступ подтверждаем по серверу, а не по одному лишь статусу.
          await pollProAfterPayment();
        });
        // если колбэк так и не пришёл — не оставляем человека без проверки статуса
        setTimeout(() => { if (!settled) pollProAfterPayment(); }, 45 * 1000);
        return;
      }
      if (j.ok && j.invoiceUrl && tg.openTelegramLink) {
        haptic('success');
        toast('Счёт в чате бота — оплати там');
        tg.openTelegramLink(CONFIG.SUBSCRIBE_URL);
        return;
      }
      if (!j.ok) {
        // Ошибку показываем по существу, а не одной фразой на все случаи.
        // Раньше «не удалось выставить счёт» означало и битую сессию, и отказ
        // Telegram, и неверный параметр — и по этой подписи нельзя было понять,
        // что именно чинить. reason приходит от воркера (описание от Telegram).
        console.warn('Invoice error:', j.error, j.reason || '');
        if (j.error === 'not_configured') toast('Оплата ещё настраивается');
        else if (j.error === 'bad_auth') toast('Сессия устарела — открой приложение заново');
        else if (j.error === 'invoice_failed' && j.reason) toast('Счёт не создан: ' + String(j.reason).slice(0, 90));
        else toast('Не удалось выставить счёт, попробуй позже');
      }
    } catch (e) {
      console.warn('Payment error:', e);
      haptic('error');
      toast('Сервер оплаты недоступен');
      return;
    }
  }
  if (tg?.openTelegramLink) tg.openTelegramLink(CONFIG.SUBSCRIBE_URL + '?start=subscribe');
  else toast('Оплата через бота: ' + CONFIG.SUBSCRIBE_URL);
}
// бэкенд оплаты настроен (адрес вписан) — иначе ведём в чат бота
function apiReady() {
  return !!CONFIG.API_BASE && !/^__|trycloudflare/.test(CONFIG.API_BASE);
}
/* После закрытия счёта оплата может дойти до вебхука на секунду-две позже
   события в вебвью, поэтому статус проверяем несколько раз, а не один. */
async function pollProAfterPayment() {
  for (const wait of [700, 1500, 2500, 4000, 6000]) {
    await new Promise(r => setTimeout(r, wait));
    if (await loadServerPro()) { render(); toast('PRO активна — приятных прогнозов!'); return; }
  }
  toast('Оплата прошла, статус обновится в течение минуты');
}
// реальный PRO-статус с бэкенда (сервер — источник правды)
let TRIAL = { available: null };
// Цена и срок — только с сервера (/api/status): фронтенд не хардкодит их.
// Значения ниже — то, что видно до первого ответа сервера (совпадают с [vars] воркера).
let PRICE = 777;
let PRO_DAYS = 30;
let TRIAL_DAYS = 3;
// Подписи цены и пробного периода в кнопках приводим к данным сервера: иначе
// в разметке остаются числа, которые расходятся с реальным счётом Stars.
function syncPlanLabels() {
  document.querySelectorAll('button.plan-price').forEach(b => {
    // меняем только само число перед иконкой Stars: захват пробелов вокруг съедал
    // разделитель «· 777» и получалось «·777»
    b.innerHTML = b.innerHTML.replace(/\d[\d\s.,]*(?=\s*<svg)/, String(PRICE));
    b.innerHTML = b.innerHTML.replace(/(\/\s*)\d+\s*дн(?:ей|я)?/, '$1' + PRO_DAYS + ' дней');
  });
  document.querySelectorAll('.trial-days').forEach(el => { el.textContent = TRIAL_DAYS; });
}
function syncPriceLabels() { syncPlanLabels(); }
/* VIP-прогнозы приходят с бэкенда и только подписчику: в публичном
   data/predictions.json их нет, поэтому curl-ом без оплаты их не достать.
   Возвращает true, если состав фида изменился (для автообновления). */
async function loadProFeed() {
  REAL.pro = []; REAL.botd = null;
  if (!isTg || !user || !apiReady() || !store.pro) {
    proToday = [];
    proFp = null;
    REAL.proError = null;
    return false;
  }
  try {
    const r = await fetch(CONFIG.API_BASE + '/api/pro', { headers: { 'X-Telegram-Init-Data': tg.initData || '' }, cache: 'no-store' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      REAL.proError = body.error === 'feed_stale' ? 'PRO-фид устарел' : 'PRO-фид временно недоступен';
      proToday = [];
      proTotalToday = 0;
      return false;
    }
    const j = await r.json();
    if (!j.ok) {
      REAL.proError = 'PRO-фид временно недоступен';
      proToday = [];
      proTotalToday = 0;
      return false;
    }
    REAL.proError = null;
  const list = Array.isArray(j.predictions) ? j.predictions : [];
    const visibleList = availablePredictions(list);
    const fp = (j.date || '') + ':' + (j.generated || '') + ':' + visibleList.length;
    const changed = fp !== proFp;
    proFp = fp;
    REAL.pro = visibleList;
    REAL.botd = (j.botd && Array.isArray(j.botd.legs) && j.botd.legs.length >= 2) ? j.botd : null;
    proToday = visibleList.slice(0, CONFIG.PRO_DAILY).map(p => ({ ...p, kind: 'pro', league: p.lgName }));
    proTotalToday = j.freshness === 'grace' ? 0 : visibleList.length;
    if (j.freshness === 'grace' && !REAL.error) REAL.error = `Последний PRO-выпуск за ${j.date}; ждём публикацию сегодняшних сигналов.`;
    return changed;
  } catch (e) {
    console.warn('Failed to load pro feed:', e);
    REAL.proError = 'PRO-фид временно недоступен';
    proToday = [];
    proTotalToday = 0;
    return false;
  }
}
async function loadServerPro() {
  if (!isTg || !user || !apiReady()) return false;
  try {
    const r = await fetch(CONFIG.API_BASE + '/api/status?uid=' + user.id, {
      headers: { 'X-Telegram-Init-Data': tg.initData || '' }, cache: 'no-store'
    });
    if (!r.ok) {
      console.warn('Server status returned', r.status);
      return false;
    }
    const j = await r.json();
    store.pro = !!j.pro;
    TRIAL.available = !j.pro && !j.trialUsed;
    // цена и срок — только с сервера (в воркере это [vars] STARS_PRICE / PRO_DAYS)
    if (j.price) { PRICE = j.price; syncPriceLabels(); }
    if (j.days) PRO_DAYS = j.days;
    if (j.trialDays) TRIAL_DAYS = j.trialDays;
    return j.pro;
  } catch (e) {
    console.warn('Failed to load server pro status:', e);
    return false;
  }
}
// активация бесплатного пробного периода
async function startTrial() {
  if (!isTg || !user || !apiReady()) { toast('Доступно в Telegram'); return; }
  try {
    const r = await fetch(CONFIG.API_BASE + '/api/trial', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData || '' },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    if (j.ok) {
      TRIAL.available = false;
      haptic('success');
      toast(`Пробный период активирован — ${TRIAL_DAYS} дн. PRO`);
      await loadServerPro();
      render();
    } else if (j.reason === 'used') { toast('Пробный период уже был использован'); }
    else if (j.reason === 'active') { toast('У тебя уже активна PRO'); }
    else if (j.reason === 'disabled') { toast('Пробный период недоступен'); }
    else { toast('Не удалось активировать, попробуй позже'); }
  } catch (e) { haptic('error'); toast('Сервер недоступен'); }
}

// копирование промокода
function copyPromo() {
  const done = () => { haptic('success'); toast('Промокод скопирован'); };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(CONFIG.PROMO).then(done).catch(() => fallbackCopy(done));
  } else fallbackCopy(done);
}
function fallbackCopy(done) {
  const ta = document.createElement('textarea');
  ta.value = CONFIG.PROMO; document.body.appendChild(ta);
  ta.select(); try { document.execCommand('copy'); done(); } catch(e) {}
  ta.remove();
}
// партнёрские ссылки открываем через Telegram in-app браузер
document.addEventListener('click', e => {
  const a = e.target.closest('[data-plink]');
  if (!a) return;
  // счётчик переходов к партнёру — для профиля
  localStorage.setItem('pxax_bets', +(localStorage.getItem('pxax_bets') || 0) + 1);
  haptic('impact');
  if (tg?.openLink) { e.preventDefault(); tg.openLink(a.dataset.plink); }
});
// ---- управление подпиской (bottom-sheet) ----
async function openManage() {
  let st = { pro: store.pro, until: null, payments: [], price: PRICE, days: PRO_DAYS, trialDays: TRIAL_DAYS, trialUsed: !TRIAL.available };
  if (isTg && user && apiReady()) {
    try {
      const r = await fetch(CONFIG.API_BASE + '/api/status?uid=' + user.id, {
        headers: { 'X-Telegram-Init-Data': tg.initData || '' }, cache: 'no-store'
      });
      st = await r.json();
      if (st.price) { PRICE = st.price; syncPriceLabels(); }
      if (st.days) PRO_DAYS = st.days;
      if (st.trialDays) TRIAL_DAYS = st.trialDays;
    } catch (e) {}
  }
  if (st.pro && !store.pro) store.pro = true;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  const daysLeft = st.until ? Math.max(0, Math.ceil((new Date(st.until) - Date.now()) / 864e5)) : 0;
  const fmt = d => d ? new Date(d).toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' }) : '—';
  const hist = (st.payments || []).slice(-5).reverse()
    .map(p => `<div class="row"><span>${new Date(p.d).toLocaleDateString('ru-RU')}</span><b>${p.stars} ${ic('star')}</b></div>`).join('');
  ov.innerHTML = `
    <div class="modal">
      <h3>${ic(st.pro ? 'diamond' : 'user')} Управление подпиской</h3>
      <div class="m-status ${st.pro ? 'on' : 'off'}">
        <div class="s">${st.pro ? 'PRO активна' : 'Подписки нет'}</div>
        ${st.pro ? `<div class="d">действует до <b>${fmt(st.until)}</b> · осталось <b>${daysLeft} дн.</b></div>` : ''}
${st.demo ? '<div class="d">демо-режим (браузер без Telegram)</div>' : ''}
      </div>
      ${hist ? `<div class="m-hist"><div class="t">История платежей</div>${hist}</div>` : ''}
      ${!st.pro && st.trialUsed === false ? `<button class="btn-trial" id="mTrial">${ic('gift')} Попробовать бесплатно · ${st.trialDays || TRIAL_DAYS} дн.</button>` : ''}
      <button class="btn-sub" id="mAction">${st.pro ? `Продлить на +${st.days || PRO_DAYS} дней · ${st.price || PRICE} ${ic('star')}` : `Оформить PRO · ${st.price || PRICE} ${ic('star')}`}</button>
      <div class="m-note">Оплата разовая в Telegram Stars. Продление суммируется с текущим сроком. Stars не возвращаются. Прогнозы не гарантируют результат, 18+.</div>
      <button class="m-close" id="mClose">Закрыть</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#mClose').onclick = () => { ov.remove(); render(); };
  const mT = ov.querySelector('#mTrial');
  if (mT) mT.onclick = () => { ov.remove(); startTrial(); };
  ov.querySelector('#mAction').onclick = () => { ov.remove(); goSubscribe(); };
}
document.getElementById('btnSubscribe2').onclick = openManage;
// Кнопки пробного периода зависят от ответа сервера (/api/status), который приходит
// асинхронно уже после разбора разметки. Раньше видимость считалась один раз при
// загрузке — TRIAL.available тогда ещё null, и кнопка «Попробовать бесплатно» не
// показывалась никогда. Теперь состояние обновляется из render().
function syncTrialButtons() {
  const show = TRIAL.available === true && !store.pro;
  ['btnTrialHome', 'btnTrialPro'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = show ? 'block' : 'none';
  });
}
syncTrialButtons();

// фильтр статистики: Все / Базовый ИИ / VIP
document.querySelectorAll('#view-history .filter-row .f-btn').forEach(b => {
  b.onclick = () => {
    statFilter = b.dataset.f;
    historyVisibleCount = HISTORY_PAGE_SIZE;
    haptic();
    document.querySelectorAll('.f-btn').forEach(x => x.classList.toggle('on', x === b));
    render();
  };
});

const historyMore = document.getElementById('historyMore');
const historyLess = document.getElementById('historyLess');
if (historyMore) historyMore.onclick = () => {
  historyVisibleCount += HISTORY_PAGE_SIZE;
  haptic();
  render();
};
if (historyLess) historyLess.onclick = () => {
  historyVisibleCount = HISTORY_PAGE_SIZE;
  haptic();
  render();
  document.getElementById('view-history')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
};

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    localStorage.setItem('pxax_last_tab', btn.dataset.view);
    haptic();
    window.scrollTo(0, 0);
    /* maybeCelebrate убрано */
  };
});

// восстанавливаем последний открытый таб при запуске
const savedTab = localStorage.getItem('pxax_last_tab');
if (savedTab) {
  const tabBtn = document.querySelector(`.tab[data-view="${savedTab}"]`);
  if (tabBtn) {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tabBtn.classList.add('active');
    document.getElementById('view-' + savedTab).classList.add('active');
  }
}
/* maybeCelebrate убрано */

// «ИИ думает» — раз в день
if (sessionStorage.getItem('intro_' + today)) {
  document.getElementById('aiLoading').style.display = 'none';
} else {
  setTimeout(() => {
    const el = document.getElementById('aiLoading');
    el.style.transition = 'opacity .4s'; el.style.opacity = '0';
    setTimeout(() => el.remove(), 420);
    sessionStorage.setItem('intro_' + today, '1');
  }, 1600);
}

// ---------- pull-to-refresh ----------
let ptrY = 0, ptrStart = 0, ptrActive = false;
const ptrEl = document.getElementById('pullToRefresh');

document.addEventListener('touchstart', e => {
  if (window.scrollY === 0) {
    ptrStart = e.touches[0].clientY;
    ptrActive = true;
  }
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!ptrActive) return;
  const y = e.touches[0].clientY;
  ptrY = Math.max(0, y - ptrStart);
  if (ptrY > 0) {
    ptrEl.style.height = Math.min(80, ptrY) + 'px';
    if (ptrY > 60) ptrEl.classList.add('show');
    else ptrEl.classList.remove('show');
  }
}, { passive: true });

document.addEventListener('touchend', async () => {
  if (!ptrActive) return;
  ptrActive = false;
  if (ptrY > 60) {
    ptrEl.classList.add('show');
    haptic('impact');
    toast('Обновление данных...');
    await loadReal();
    await loadServerPro();
    render();
    setTimeout(() => {
      ptrEl.classList.remove('show');
      ptrEl.style.height = '0';
    }, 500);
  } else {
    ptrEl.classList.remove('show');
    ptrEl.style.height = '0';
  }
  ptrY = 0;
}, { passive: true });

/* ================= скелетоны до первого рендера ================= */
function skSlide() {
  return `<div class="sk-slide"><div class="sk-card">
    <div class="sk-line w40"></div>
    <div class="sk-teams"><div class="sk-badge"></div><div class="sk-vs">VS</div><div class="sk-badge"></div></div>
    <div class="sk-line w60"></div>
    <div class="sk-line w80"></div>
    <div class="sk-bar"></div>
  </div></div>`;
}
(function fillSkeletons() {
  for (const id of ['freeTrack', 'proTrack']) {
    const el = document.getElementById(id);
    if (el && !el.children.length) el.innerHTML = skSlide() + skSlide() + skSlide();
  }
})();

function tickFresh() {
  const el = document.getElementById('freshChip');
  const text = document.getElementById('freshTxt');
  if (!el || !text) return;
  el.hidden = false;
  if (REAL.status !== 'fresh' && REAL.status !== 'grace') {
    text.textContent = REAL.error || 'Загружаем актуальные прогнозы…';
    return;
  }
  const generated = new Date(REAL.lastUpdate || '').getTime();
  if (!Number.isFinite(generated)) {
    text.textContent = 'Реальные прогнозы загружены';
    return;
  }
  const mins = Math.max(0, Math.floor((Date.now() - generated) / 60000));
  const freshLabel = REAL.status === 'grace'
    ? `Последний реальный выпуск за ${REAL.date || 'предыдущий день'} · ждём обновления.`
    : `${mins < 120 ? `Обновлено ${mins} мин. назад` : `Обновлено ${Math.floor(mins / 60)} ч. назад`}.`;
  text.textContent = freshLabel;
}
setInterval(tickFresh, 30000);

/* ================= автообновление витрины =================
   Вебвью в Telegram может висеть открытым часами, а фид пересчитывается
   каждые 2 часа — поэтому во время открытой страницы раз в 5 минут проверяем
   данные: если файлы обновились, тихо перерисовываем (без перезагрузки и без
   прыжка на другую вкладку). Смена суток (день МСК поменялся) — полный
   перезапуск страницы: мок/статистика корректно сбросятся на новый день. */
async function autoRefresh() {
  try {
    if (dayKey() !== today) { location.reload(); return; }
    let changed = false;
    const r = await fetch('data/predictions.json?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !Array.isArray(d.predictions) || !d.date) throw new Error('bad_feed');
    const fp = (d.generated || '') + '|' + (d.date || '');
    const freshness = feedFresh(d);
    if (freshness) {
      REAL.status = freshness;
      REAL.feedTargets = { free: 3, pro: 3 };
      const visibleFree = availablePredictions(d.predictions.filter(p => !p.tier || p.tier === 'free'));
      const rawProCount = Number(d.proCount) || 0;
      const reportedProCount = freshness === 'fresh' ? Math.min(5, rawProCount) : 0;
      REAL.feedShortfall = { free: Math.max(0, 3 - Math.min(3, visibleFree.length)), pro: freshness === 'fresh' ? Math.max(0, 3 - reportedProCount) : 3 };
      REAL.error = freshness === 'grace' ? `Показываем предыдущий реальный выпуск за ${d.date}; ждём обновлённый выпуск.` : null;
      REAL.loaded = true;
      REAL.date = d.date;
      REAL.lastUpdate = d.generated || null;
      REAL.free = visibleFree;
      REAL.proCount = reportedProCount;
      REAL.botdLegs = Number(d.botdLegs) || 0;
      freeToday = REAL.free.slice(0, CONFIG.FREE_DAILY).map(p => ({ ...p, kind: 'free', league: p.lgName }));
      proTotalToday = reportedProCount;
    } else {
      REAL.status = 'stale';
      REAL.error = `Данные прогнозов устарели: ${d.date || 'неизвестная дата'}`;
      REAL.free = [];
      REAL.proCount = 0;
      freeToday = [];
      proTotalToday = 0;
    }
    REAL.botdLegs = Number(d.botdLegs) || 0;
    if (fp !== feedFingerprint) { feedFingerprint = fp; changed = true; }
    if (await loadProFeed()) changed = true;
    try {
      const rr = await fetch('data/results.json?v=' + Date.now(), { cache: 'no-store' });
      if (rr.ok) {
        const j = await rr.json();
        if (Array.isArray(j) && resultsFingerprint(j) !== resultsFp) {
          resultsFp = resultsFingerprint(j);
          REAL.results = j;
          changed = true;
        }
      }
    } catch (e) {}
    try {
      const br = await fetch('data/backtest.json?v=' + Date.now(), { cache: 'no-store' });
      if (br.ok) {
        const j = await br.json();
        if (j && j.mode === 'archived-production' && j.signals > 0) {
          const nextFp = j.evaluationWindowDays + ':' + j.resolved + ':' + j.signals;
          if (nextFp !== backtestFp) { backtestFp = nextFp; REAL.backtest = j; changed = true; }
        }
      }
    } catch (e) {}
    if (changed) render();
  } catch (e) {
    REAL.status = 'error';
    REAL.error = 'Не удалось обновить реальные прогнозы';
    REAL.free = [];
    freeToday = [];
    console.warn('autoRefresh:', e);
    render();
  }
}
setInterval(autoRefresh, 5 * 60 * 1000); // чек каждые 5 минут

/* (конфетти убрано) */

/* ================= онбординг первого визита ================= */
function showOnboarding() {
  if (localStorage.getItem('pxax_onboarded') === '1') return;
  const steps = [
    { i: 'target', t: 'Привет! Это PXAX AI', d: 'Цель — минимум 3 реальных бесплатных прогноза и 3 PRO-сигнала при наличии матчей, прошедших фильтры качества. Вымышленные прогнозы не подставляются.' },
    { i: 'diamond', t: 'PRO — value-ставки', d: 'Модель сравнивает свои вероятности с линией букмекера и берёт рынки с перевесом. Оплата разовая в Telegram Stars, плюс бесплатная проба.' },
    { i: 'shield', t: 'Честные правила', d: 'Прогнозы — аналитика ИИ, а не гарантия: вероятность не 100%. Ставьте только то, что готовы потерять. 18+.' },
  ];
  let cur = 0;
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <div class="ob-icon" id="obIcon"></div>
      <div class="ob-title" id="obTitle"></div>
      <div class="ob-txt" id="obTxt"></div>
      <div class="ob-dots" id="obDots">${steps.map(() => '<span class="ob-dot"></span>').join('')}</div>
      <button class="btn-sub" id="obNext">Дальше</button>
      <button class="ob-skip" id="obSkip">Пропустить</button>
    </div>`;
  const close = () => { localStorage.setItem('pxax_onboarded', '1'); ov.remove(); };
  const paint = () => {
    const s = steps[cur];
    // ищем внутри ov: на первом кадре оверлей ещё не в DOM, document.getElementById вернул бы null
    ov.querySelector('#obIcon').innerHTML = ic(s.i);
    ov.querySelector('#obTitle').textContent = s.t;
    ov.querySelector('#obTxt').textContent = s.d;
    ov.querySelectorAll('.ob-dot').forEach((d, j) => d.classList.toggle('on', j === cur));
    ov.querySelector('#obNext').textContent = cur === steps.length - 1 ? 'Начать' : 'Дальше';
  };
  ov.querySelector('#obNext').onclick = () => {
    haptic();
    if (cur < steps.length - 1) { cur++; paint(); } else close();
  };
  ov.querySelector('#obSkip').onclick = close;
  document.body.appendChild(ov);
  paint();
}

(async () => {
  const serverPro = await loadServerPro();
  await loadReal();
  freeToday = REAL.status === 'fresh' || REAL.status === 'grace'
    ? REAL.free.slice(0, CONFIG.FREE_DAILY).map(p => ({ ...p, kind: 'free', league: p.lgName }))
    : [];
  // PRO приходит отдельно и только подписчику
  await loadProFeed();
  render();
  if (serverPro) toast('PRO активна — спасибо за поддержку!');
  setTimeout(showOnboarding, 600);
})();
