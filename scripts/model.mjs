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
