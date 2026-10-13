export function quotaStatus(count, minimum = 3) {
  const actual = Math.max(0, Math.floor(Number(count) || 0));
  const goal = Math.max(0, Math.floor(Number(minimum) || 0));
  if (actual < goal) return `${actual} сигналов · не хватает ${goal - actual} до минимума ${goal}`;
  return `${actual} сигналов · минимум ${goal} выполнен`;
}

export function visibleHistoryCount(results, filter, cutoffDate) {
  return (results || []).filter(result => !result.preseason
    && (filter === 'all' || result.kind === filter)
    && result.date >= cutoffDate).length;
}
