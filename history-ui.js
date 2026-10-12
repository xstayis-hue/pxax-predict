(() => {
  const quotaStatus = (count, target) => {
    const actual = Math.max(0, Math.floor(Number(count) || 0));
    const goal = Math.max(0, Math.floor(Number(target) || 0));
    return actual >= goal ? `${actual} / ${goal}` : `${actual} / ${goal} · недобор ${goal - actual}`;
  };
  const visibleHistoryCount = (results, filter, cutoffDate) =>
    (results || []).filter(result => !result.preseason
      && (filter === 'all' || result.kind === filter)
      && result.date >= cutoffDate).length;
  window.PxaxHistoryUi = { quotaStatus, visibleHistoryCount };
})();
