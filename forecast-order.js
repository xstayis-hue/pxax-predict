(() => {
  const sortByKickoff = (predictions) => [...(predictions || [])].sort((a, b) => {
    const aTime = new Date(a?.matchDate || '').getTime();
    const bTime = new Date(b?.matchDate || '').getTime();
    const safeA = Number.isFinite(aTime) ? aTime : Number.POSITIVE_INFINITY;
    const safeB = Number.isFinite(bTime) ? bTime : Number.POSITIVE_INFINITY;
    return safeA - safeB || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });
  window.PxaxForecastOrdering = { sortByKickoff };
})();
