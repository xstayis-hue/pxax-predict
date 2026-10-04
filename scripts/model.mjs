// Общие функции модели: Пуассон / нормальное приближение.
// Вынесены из generate-predictions.mjs — используются и backtest.mjs.
// Поведение идентично исходному инлайн-коду генератора (просто перенесено в модуль).

const factorial = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / factorial(k);

// Пуассонова матрица: [голы дома, голы вгостях, P(дом)·P(гости)]
export function poissonMatrix(lh, la, max = 8) {
  const m = [];
  for (let h = 0; h <= max; h++) for (let a = 0; a <= max; a++) m.push([h, a, pois(h, lh) * pois(a, la)]);
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

// Баскетбол: очки — почти непрерывная величина, пуассон не годится.
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
