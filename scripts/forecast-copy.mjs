export function proValueExplanation(value, edge, modelProbability, lineProbability) {
  if (!value || !Number.isFinite(edge) || !Number.isFinite(modelProbability) || !Number.isFinite(lineProbability)) return '';
  const advantage = edge > 0 ? ` (расчётный перевес +${Math.round(edge * 100)}%)` : '';
  return ` Value-сигнал PRO: вероятность модели ${Math.round(modelProbability * 100)}% против справедливой вероятности линии ${Math.round(lineProbability * 100)}%${advantage}.`;
}
