// Общие функции модели: распределение счёта / нормальное приближение.
// Вынесены из generate-predictions.mjs — используются и backtest.mjs.
// Поведение идентично исходному инлайн-коду генератора (просто перенесено в модуль).

const factorial = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const goalProb = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / factorial(k);

// Матрица вероятностей счёта: [голы дома, голы вгостях, P(дом)·P(гости)]
export function scoreMatrix(lh, la, max = 8) {
  const m = [];
  for (let h = 0; h <= max; h++) for (let a = 0; a <= max; a++) m.push([h, a, goalProb(h, lh) * goalProb(a, la)]);
  return m;
}

// Вероятности исходов и тоталов из матрицы (футбол/хоккей — низкие счётные)
export function outcomesFromMatrix(mtx, totalLine = 2.5) {
  let p1 = 0, px = 0, p2 = 0, over = 0, under = 0;
  let p1h = 0, p2h = 0; // форы -1.5 / +1.5
  for (const [h, a, p] of mtx) {
    if (h > a) p1 += p; else if (h === a) px += p; else p2 += p;
    if (h + a > totalLine) over += p; else under += p;
    if (h - a >= 2) p1h += p;
    if (a - h >= 2) p2h += p;
  }
  return { p1, px, p2, over, under, p1h, p2h };
}

// Баскетбол: очки — почти непрерывная величина, дискретное распределение не годится.
// Нормальное приближение по разнице и сумме очков.
const erf = (x) => {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};
const normCdf = (z, mean, sd) => 0.5 * (1 + erf((z - mean) / (sd * Math.SQRT2)));
export function outcomesFromNormal(lh, la, totalLine) {
  // Ожидаемая разность очков в НБА — СКО ~13–14, сумма ~17. Берём чуть шире,
  // чтобы не рисовать 80% там, где рынок кладёт ~65% (честность важнее «красивых» цифр)
  const diff = (lh - la) * 0.85, sdDiff = 14;
  const total = lh + la, sdTot = 17;
  const p1 = 1 - normCdf(0, diff, sdDiff); // ничьих в НБА не бывает
  const p2 = 1 - p1;
  const over = totalLine ? 1 - normCdf(totalLine, total, sdTot) : null;
  const under = totalLine && over != null ? 1 - over : null;
  return { p1, px: 0, p2, over, under, p1h: null, p2h: null };
}

// xG-форма (Understat): множители к ожидаемым голам.
// t = {xf, xa}: средние xG за/против за последние 5 сыгранных матчей команды;
// L = {lf, la}: те же средние по лиге в том же окне.
// Форму учитываем лишь наполовину (итого до ~10% к ожиданию): таблица лиги остаётся основой, xG — поправка.
// att: форма атаки (xf выше лиги -> >1), def: «продуваемость» (xa выше лиги -> >1, то есть хуже).
export function xgBlend(t, L) {
  const clampF = (v) => Math.max(0.9, Math.min(1.1, Number.isFinite(v) ? v : 1));
  return {
    att: 0.5 + 0.5 * clampF(t.xf / (L.lf || t.xf || 1)),
    def: 0.5 + 0.5 * clampF(t.xa / (L.la || t.xa || 1)),
  };
}

// =========================================================
// Выбор рынка и калибровка вероятностей — то, что модель отдаёт клиенту.
// Живёт здесь (а не в генераторе), потому что те же функции использует бэктест:
// иначе проверяется не та модель, что продаётся. Раньше бэктест считал совсем
// другую версию (только форма по голам, без таблиц и линий), и его проходимость
// ничего не говорила о продакшне.
// =========================================================

// Семейство рынка: по нему копится калибровка. Разделять П1/П2/Х незачем —
// наблюдений на каждый исход слишком мало, а смещение у них общее.
export function marketFamily(market) {
  const m = String(market || '');
  if (/^ТБ|^ТМ/.test(m)) return 'total';
  if (/^[1Х2]{2}$/.test(m)) return 'double';
  if (/^П[12]$|^Х$/.test(m)) return 'result';
  return 'other';
}

// Насколько модель верит перевесу над линией при выборе рынка.
// Прямой выбор «где edge максимальный» отдавал карточку самому несогласному
// рынку, а несогласие — это чаще всего ошибка модели: в истории заходы с
// большим edge были ХУЖЕ (нижняя половина по edge 80%, верхняя 53%, а самые
// крупные «перевесы» +86%/+55%/+48% — все мимо).
// Поэтому базой идёт вероятность, а edge — небольшая ограниченная добавка:
// он помогает выбрать между близкими рынками и уже не может продавить в
// карточку лонгшот с перевесом +80%.
export const EDGE_WEIGHT = 0.25;

export function selectionScore(p, edge) {
  const e = Number.isFinite(edge) ? edge : 0;
  const capped = Math.max(-0.5, Math.min(0.5, e));
  const prob = Number.isFinite(p) ? p : 0;
  return prob * (1 + EDGE_WEIGHT * capped);
}

// Калибровка: вызов «наблюдаемую долю заходов» вместо «средней вероятности
// корзины». Средняя вероятность корзины зависит от того, попадают ли в неё
// лонгшоты: при 9 заходах из 10 со средней 0.75 «калиброванная» вышла бы ~0.83,
// что как раз и раздувало уверенность. Доля заходов плюс шринк к 0.5 — это
// сглаживание Лапласа, оно даёт ровно 0.5 при нуле данных.
export function calibratedRate(bucket) {
  const n = Number(bucket && bucket.n) || 0;
  const actual = Number(bucket && bucket.actual);
  if (!n || !Number.isFinite(actual)) return null;
  return (actual * n + 0.5) / (n + 1);
}

// Поправка вероятности по калибровке. Возвращает confidence как долю.
// Правила, чтобы не сломать ничего на малых данных:
//   • калибровка применяется только когда файл помечен reliable (n >= 20);
//   • сравниваем корзины с РАЗНОЙ шириной, поэтому кривую строим в нормированном
//     виде (середина корзины -> доля заходов) и подтягиваем соседние точки друг
//     к другу, чтобы разрыв ширины не превращался в ступеньку вероятности;
//   • итог зажат в ±6 пунктов от исходной вероятности: этого хватает, чтобы
//     снять смещение 6–10 пунктов, но не даёт калибровке переписать модель.
export const CALIBRATION_MAX_SHIFT = 0.06;

export function calibrateProbability(prob, bucket, reliable) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return p;
  if (!reliable) return p;
  const r = calibratedRate(bucket);
  if (r == null) return p;
  const mid = (Number(bucket.lo) + Math.min(Number(bucket.hi), 1)) / 2;
  const a = Math.max(0, Math.min(1, r + (0.5 - mid) * 0.5));
  const shifted = p + (a - p) * 0.5;
  return Math.max(p - CALIBRATION_MAX_SHIFT, Math.min(p + CALIBRATION_MAX_SHIFT, shifted));
}

// Домашнее преимущество лиги из фактических голов.
// Раньше это была одна константа 1.15 на всю футбольную лигу: в Аргентине и
// Бразилии (худшая проходимость в истории) преимущество поля своё, в MLS — своё.
// Делим долю голов хозяев на 0.5 — это и есть множитель к «пополам»; делить на
// два и получать 1.0 при сбалансированной лиге было бы ошибкой, потому что
// преимущество уже заложено в саму пропорцию.
// При малой выборке возвращает null: лучше общая константа, чем шум по 3 матчам.
export const MIN_HOME_ADV_GAMES = 40;
export function homeAdvFromTotals(homeGoals, awayGoals, games, minGames = MIN_HOME_ADV_GAMES) {
  const h = Number(homeGoals), a = Number(awayGoals), n = Number(games);
  if (!Number.isFinite(h) || !Number.isFinite(a) || !Number.isFinite(n)) return null;
  if (n < minGames || h + a <= 0) return null;
  const adv = (h / (h + a)) / 0.5;
  if (!Number.isFinite(adv)) return null;
  return Math.max(1.0, Math.min(1.35, adv));
}

