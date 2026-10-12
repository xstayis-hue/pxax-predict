export function quotaStatus(count, target) {
  const actual = Math.max(0, Math.floor(Number(count) || 0));
  const goal = Math.max(0, Math.floor(Number(target) || 0));
  return actual >= goal ? `${actual} / ${goal}` : `${actual} / ${goal} · недобор ${goal - actual}`;
}

export function visibleHistoryCount(results, filter, cutoffDate) {
  return (results || []).filter(result => !result.preseason
    && (filter === 'all' || result.kind === filter)
    && result.date >= cutoffDate).length;
}
