import { gradeMarket } from './settlement.mjs';

export function evaluateArchivedPredictions(predictions, results) {
  const resultById = new Map((results || []).map(result => [String(result.id), result]));
  const predictionById = new Map();
  for (const prediction of [...(predictions || [])].sort((a, b) => String(a.snapshotGenerated || '').localeCompare(String(b.snapshotGenerated || '')))) {
    const id = String(prediction?.id ?? '');
    if (!id) continue;
    const result = resultById.get(id);
    const kickoff = new Date(prediction.matchDate || '').getTime();
    const snapshot = new Date(prediction.snapshotGenerated || '').getTime();
    if (Number.isFinite(kickoff) && Number.isFinite(snapshot) && snapshot >= kickoff) continue;
    if (result?.date && prediction.matchDate && prediction.matchDate.slice(0, 10) < result.date) continue;
    predictionById.set(id, prediction);
  }
  const rows = [];
  for (const [id, prediction] of predictionById) {
    const result = resultById.get(id);
    const probability = Number(prediction?.modelProb);
    if (!result || result.preseason || !Number.isFinite(probability) || probability < 0 || probability > 1) continue;
    const score = String(result.score || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!score) continue;
    const settlement = gradeMarket(prediction.market || result.market, Number(score[1]), Number(score[2]), prediction.odds ?? result.odds);
    if (!settlement || !['hit', 'miss', 'half_win', 'half_loss', 'push'].includes(settlement.result)) continue;
    rows.push({ id, date: result.date || prediction.matchDate?.slice(0, 10) || null,
      tier: result.kind || 'free', market: prediction.market || result.market,
      probability, result: settlement.result, score: result.score,
      profitUnits: settlement.profitUnits ?? null });
  }
  const decisive = rows.filter(row => !['push', 'half_win', 'half_loss'].includes(row.result));
  const brierRows = rows.filter(row => row.result === 'hit' || row.result === 'miss');
  const brier = brierRows.length
    ? brierRows.reduce((sum, row) => sum + (row.probability - (row.result === 'hit' ? 1 : 0)) ** 2, 0) / brierRows.length
    : null;
  const wins = rows.reduce((sum, row) => sum + (row.result === 'hit' ? 1 : row.result === 'half_win' ? 0.5 : 0), 0);
  const losses = rows.reduce((sum, row) => sum + (row.result === 'miss' ? 1 : row.result === 'half_loss' ? 0.5 : 0), 0);
  const roiRows = rows.filter(row => row.profitUnits != null);
  const profitUnits = roiRows.reduce((sum, row) => sum + row.profitUnits, 0);
  const stakedUnits = roiRows.length;
  return {
    mode: 'archived-production',
    generated: new Date().toISOString(),
    evaluationWindowDays: rows.length ? Math.ceil((new Date(rows.map(row => row.date).filter(Boolean).sort().at(-1)) - new Date(rows.map(row => row.date).filter(Boolean).sort()[0])) / 86400000) + 1 : 0,
    source: 'committed archived public prediction snapshots joined by event id to resolved results',
    snapshots: (predictions || []).length,
    resolved: rows.length,
    signals: decisive.length,
    hits: wins,
    losses,
    hitRate: wins + losses ? +(wins / (wins + losses)).toFixed(4) : null,
    brier: brier == null ? null : +brier.toFixed(4),
    roi: stakedUnits ? +(profitUnits / stakedUnits * 100).toFixed(2) : null,
    roiBets: stakedUnits,
    pushes: rows.filter(row => row.result === 'push').length,
    halfResults: rows.filter(row => row.result === 'half_win' || row.result === 'half_loss').length,
    coverage: {
      tiers: [...new Set(rows.map(row => row.tier))],
      firstDate: rows.map(row => row.date).filter(Boolean).sort()[0] || null,
      lastDate: rows.map(row => row.date).filter(Boolean).sort().at(-1) || null,
      includesPro: rows.some(row => row.tier === 'pro'),
    },
    note: 'Оценка только фактически сохранённых публичных прогнозов; PRO-снимки и архивные входные признаки отсутствуют. Не является 90-дневным replay или доказательством будущей доходности.',
  };
}
