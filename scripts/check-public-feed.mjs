// Проверка, что публичные файлы прогнозов не содержат платного сигнала PRO.
//
// Зачем: PRO продаёт сравнение модели с линией букмекера (value/edge и фразу
// «перевес модели +N%»). Если это снова утечёт в data/predictions.json, архивы
// или results.json, любой сможет скачать VIP-сигнал curl-ом без подписки —
// именно так и случилось однажды. Скрипт запускается в CI после генерации и
// валит пайплайн, а не молча коммитит утечку.
//
// Платный сигнал здесь — это поля value/edge/impliedProb (в том числе внутри
// markets) и текст с перевесом в note. Бесплатная часть (market, confidence,
// modelProb, odds, record) остаётся.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const FORBIDDEN_FIELDS = ['value', 'edge', 'impliedProb', 'tier'];
const FORBIDDEN_NOTE = /перевес модели|недооценивает исход/i;
const files = [];
if (existsSync('data/predictions.json')) files.push('data/predictions.json');
if (existsSync('data/results.json')) files.push('data/results.json');
if (existsSync('data/archive')) {
  for (const f of readdirSync('data/archive')) {
    if (f.endsWith('.json')) files.push(`data/archive/${f}`);
  }
}

const problems = [];
for (const file of files) {
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { problems.push(`${file}: не читается как JSON (${e.message})`); continue; }
  const rows = Array.isArray(json) ? json : (Array.isArray(json.predictions) ? json.predictions : null);
  if (!rows) continue;
  rows.forEach((row, i) => {
    const where = `${file}[${i}] ${row.home || ''} — ${row.away || ''}`.trim();
    for (const field of FORBIDDEN_FIELDS) {
      if (row[field] !== undefined) problems.push(`${where}: платное поле "${field}"`);
    }
    if (Array.isArray(row.markets)) {
      row.markets.forEach((m) => {
        if (m && m.edge !== undefined) problems.push(`${where}: платное поле markets[].edge (${m.market || '?'})`);
      });
    }
    if (FORBIDDEN_NOTE.test(String(row.note || ''))) {
      problems.push(`${where}: в note осталось сравнение с линией (перевес модели)`);
    }
  });
  // счётчик valueCount сам раскрывает, сколько value-ставок было в бесплатных
  if (!Array.isArray(json) && json && json.valueCount !== undefined) {
    problems.push(`${file}: верхнеуровневый valueCount раскрывает число value-ставок`);
  }
}

if (problems.length) {
  console.error(`PENNYWALL LEAK: платный сигнал PRO снова в публичных файлах (${problems.length}):`);
  problems.slice(0, 25).forEach((p) => console.error('  - ' + p));
  if (problems.length > 25) console.error(`  ... ещё ${problems.length - 25}`);
  process.exit(1);
}
console.log(`OK: публичные данные чисты (${files.length} файлов) — платного сигнала PRO нет`);
