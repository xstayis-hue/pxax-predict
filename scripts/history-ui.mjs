export function quotaStatus(count, limit, minimum = 3) {
  const actual = Math.max(0, Math.floor(Number(count) || 0));
  const maximum = Math.max(0, Math.floor(Number(limit) || 0));
  const minTarget = Math.max(0, Math.floor(Number(minimum) || 0));
  if (actual < minTarget) return `${actual} из ${maximum} · цель ${minTarget}, не хватает ${minTarget - actual}`;
  return actual > maximum ? `${actual} из лимита ${maximum}` : `${actual} из ${maximum}`;
}

export function visibleHistoryCount(results, filter, cutoffDate) {
  return (results || []).filter(result => !result.preseason
    && (filter === 'all' || result.kind === filter)
    && result.date >= cutoffDate).length;
}
