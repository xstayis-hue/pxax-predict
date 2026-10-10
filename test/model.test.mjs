// Офлайн-тесты модели: проверяют ровно те куски, которые правятся ради качества
// прогнозов, — выбор рынка, калибровку и домашний фактор. Без сети и без ESPN,
// поэтому гоняются в CI на каждый push.
//
// Запуск: node test/model.test.mjs
import { selectionScore, marketFamily, calibratedRate, calibrateProbability, homeAdvFromTotals, CALIBRATION_MAX_SHIFT } from '../scripts/model.mjs';

const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? `  [${extra}]` : ''}`);
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---- выбор рынка: вероятность как база, edge — ограниченная добавка ---- */
// Лонгшот с огромным «перевесом» не должен обгонять уверенный рынок.
const confident = selectionScore(0.66, 0.05);
const longshot = selectionScore(0.55, 0.80);
check('S1: уверенный рынок обгоняет лонгшот с перевесом +80%', confident > longshot,
  `confident=${confident.toFixed(3)} longshot=${longshot.toFixed(3)}`);

// При равной вероятности рынок с перевесом всё же идёт вперёд.
check('S2: при равной вероятности выигрывает рынок с перевесом',
  selectionScore(0.60, 0.10) > selectionScore(0.60, 0.0),
  `${selectionScore(0.60, 0.10).toFixed(3)} > ${selectionScore(0.60, 0.0).toFixed(3)}`);

// Добавка ограничена: edge +300% не даёт больше, чем +50%.
check('S3: перевес зажат (0.5), +300% не сильнее +50%',
  approx(selectionScore(0.55, 3.0), selectionScore(0.55, 0.5), 1e-9),
  `${selectionScore(0.55, 3.0).toFixed(4)} == ${selectionScore(0.55, 0.5).toFixed(4)}`);

// Без перевеса (нет линии) — чистая вероятность.
check('S4: без edge счёт равен вероятности', approx(selectionScore(0.62, null), 0.62, 1e-9));

/* ---- семейства рынков ---- */
check('F1: П1/П2/Х -> result',
  marketFamily('П1') === 'result' && marketFamily('П2') === 'result' && marketFamily('Х') === 'result');
check('F2: Х2/1Х -> double', marketFamily('Х2') === 'double' && marketFamily('1Х') === 'double');
check('F3: ТБ/ТМ любого тотала -> total',
  marketFamily('ТБ 2.5') === 'total' && marketFamily('ТМ 2.5') === 'total' && marketFamily('ТБ 230.5') === 'total');
check('F4: неизвестный рынок -> other', marketFamily('Ф1 -1.5') === 'other');

/* ---- калибровка ---- */
// Нет данных — нет поправки, а не 0.5 вместо вероятности.
check('C1: пустая корзина не даёт поправки', calibratedRate({ n: 0, actual: null }) === null);
// Доля заходов со шринком: 9 из 10 -> не 0.9 и не средняя корзины
const r910 = calibratedRate({ n: 10, actual: 0.9 });
// Шринк Лапласа: (9 + 0.5)/(10 + 1) = 0.864 — не сырая доля 0.9 и не средняя
// вероятность корзины (она зависела бы от того, попали ли в неё лонгшоты).
check('C2: 9/10 со шринком даёт 0.864, не 0.9', approx(r910, 9.5 / 11, 1e-9), r910.toFixed(3));
// Поправка не применяется, пока файл не reliable
const bucket = { lo: 0.5, hi: 0.6, n: 17, actual: 0.647 };
check('C3: при reliable=false вероятность не меняется',
  approx(calibrateProbability(0.55, bucket, false), 0.55, 1e-9));
// После калибровки вероятность растёт (факт 65% при предсказании 55%)
const cal = calibrateProbability(0.55, bucket, true);
check('C4: недооценка 55% -> факт 65% поднимает вероятность', cal > 0.55, cal.toFixed(3));
// Сдвиг ограничен — калибровка не может переписать модель
const far = calibrateProbability(0.90, bucket, true);
check('C5: сдвиг зажат ±6 пунктов', Math.abs(far - 0.90) <= CALIBRATION_MAX_SHIFT + 1e-9, far.toFixed(3));
// Противоположный случай: модель переоценивает (факт 50% при 65%)
const over = calibrateProbability(0.65, { lo: 0.6, hi: 0.7, n: 11, actual: 0.36 }, true);
check('C6: переоценка 65% -> факт 36% опускает вероятность', over < 0.65 && over >= 0.65 - CALIBRATION_MAX_SHIFT - 1e-9, over.toFixed(3));

/* ---- домашний фактор ---- */
check('H1: мало матчей — общей константы достаточно (null)',
  homeAdvFromTotals(44, 25, 12) === null, 'n=12');
// Доля хозяев 56.25% -> множитель 1.125 (деление на 0.5, а не на 2)
const adv = homeAdvFromTotals(450, 350, 100);
check('H2: сбалансированная выборка даёт 1.125 при 56/44', approx(adv, 1.125, 1e-9), String(adv));
check('H3: равенство голов -> ровно 1.0', approx(homeAdvFromTotals(300, 300, 100), 1.0, 1e-9));
check('H4: нулевые счета не делятся на ноль', homeAdvFromTotals(0, 0, 100) === null);
check('H5: множитель зажат сверху 1.35', homeAdvFromTotals(900, 100, 100) === 1.35, String(homeAdvFromTotals(900, 100, 100)));

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
