import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluateArchivedPredictions } from './backtest-evaluator.mjs';

const predictions = [];
for (const file of readdirSync('data/archive').filter(name => name.endsWith('.json')).sort()) {
  const feed = JSON.parse(readFileSync(`data/archive/${file}`, 'utf8'));
  for (const prediction of feed.predictions || []) {
    predictions.push({ ...prediction, tier: prediction.tier || 'free', snapshotGenerated: feed.generated || null });
  }
}
const current = JSON.parse(readFileSync('data/predictions.json', 'utf8'));
for (const prediction of current.predictions || []) {
  predictions.push({ ...prediction, tier: 'free', snapshotGenerated: current.generated || null });
}
const results = JSON.parse(readFileSync('data/results.json', 'utf8'));
const report = evaluateArchivedPredictions(predictions, results);
if (!report.signals) {
  throw new Error('Нет сохранённых production-прогнозов с подтверждёнными исходами; отчёт не обновлён.');
}
writeFileSync('data/backtest.json', JSON.stringify(report, null, 2));
console.log(`Archived production backtest: ${report.hits}/${report.signals} settled predictions, Brier ${report.brier}; ${report.coverage.firstDate}..${report.coverage.lastDate}; public/free snapshots only`);
