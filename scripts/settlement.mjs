const totalOutcome = (side, score, line) => {
  if (score === line) return 'push';
  return (side === 'over' ? score > line : score < line) ? 'win' : 'loss';
};

export function settleTotal(market, homeScore, awayScore, odds = null) {
  const match = /^(ТБ|ТМ)\s*(\d+(?:[.,]\d+)?)$/i.exec(String(market || '').trim());
  if (!match) return null;

  const line = Number(match[2].replace(',', '.'));
  const total = Number(homeScore) + Number(awayScore);
  const decimalOdds = Number(odds);
  if (!Number.isFinite(line) || !Number.isFinite(total)) return null;

  const side = match[1].toUpperCase() === 'ТБ' ? 'over' : 'under';
  const fraction = Math.round((line % 1) * 100);
  let outcomes;
  if (fraction === 25 || fraction === 75) {
    const lower = fraction === 25 ? Math.floor(line) : Math.floor(line) + 0.5;
    outcomes = [totalOutcome(side, total, lower), totalOutcome(side, total, lower + 0.5)];
  } else {
    outcomes = [totalOutcome(side, total, line)];
  }

  const wins = outcomes.filter(value => value === 'win').length;
  const losses = outcomes.filter(value => value === 'loss').length;
  const pushes = outcomes.length - wins - losses;
  const result = wins === outcomes.length ? 'hit'
    : losses === outcomes.length ? 'miss'
      : wins && losses ? 'half_win'
        : wins ? 'half_win'
          : losses ? 'half_loss' : 'push';
  let profitUnits = null;
  if (Number.isFinite(decimalOdds) && decimalOdds > 1) {
    profitUnits = outcomes.reduce((sum, value) => sum + (
      value === 'win' ? decimalOdds - 1 : value === 'loss' ? -1 : 0
    ), 0) / outcomes.length;
  }
  return { result, profitUnits, line, total, parts: outcomes };
}

export function gradeMarket(market, homeScore, awayScore, odds = null) {
  const hs = Number(homeScore), as = Number(awayScore);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const m = String(market || '').trim();
  const result = (hit) => ({
    result: hit ? 'hit' : 'miss',
    profitUnits: Number.isFinite(Number(odds)) && Number(odds) > 1 ? (hit ? Number(odds) - 1 : -1) : null,
  });
  switch (m) {
    case 'П1': return result(hs > as);
    case 'П2': return result(as > hs);
    case 'Х': return result(hs === as);
    case 'Х2': return result(as >= hs);
    case '1Х': return result(hs >= as);
    case 'Ф1 -1.5': return result(hs - as >= 2);
    case 'Ф2 -1.5': return result(as - hs >= 2);
    default: return settleTotal(m, hs, as, odds);
  }
}
