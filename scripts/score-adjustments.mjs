export function normalizeScoreProbabilities(outcomes) {
  const values = { ...outcomes };
  for (const key of ['p1', 'px', 'p2', 'over', 'under', 'p1h', 'p2h']) {
    if (Number.isFinite(values[key])) values[key] = Math.max(0, Math.min(1, values[key]));
  }
  for (const group of [['p1', 'px', 'p2'], ['over', 'under']]) {
    const sum = group.reduce((total, key) => total + (Number.isFinite(values[key]) ? values[key] : 0), 0);
    if (sum > 1) for (const key of group) if (Number.isFinite(values[key])) values[key] /= sum;
  }
  return values;
}

export function clampExpectedGoals(lh, la, kind) {
  const max = kind === 'soccer' ? 4.5 : kind === 'hockey' ? 7 : 175;
  const min = kind === 'soccer' ? 0.35 : kind === 'hockey' ? 1 : 60;
  return [Math.max(min, Math.min(max, lh)), Math.max(min, Math.min(max, la))];
}

export function applySoccerLowScoreGuard(outcomes, expectedHome, expectedAway) {
  const normalized = normalizeScoreProbabilities(outcomes);
  if (expectedHome + expectedAway <= 0.7 && normalized.p1 < 0.03) {
    const delta = 0.03 - normalized.p1;
    normalized.p1 += delta;
    normalized.p2 = Math.max(0, normalized.p2 - delta);
  }
  return normalized;
}
