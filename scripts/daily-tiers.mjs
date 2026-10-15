export const DAILY_MIN_FREE = 3;
export const DAILY_MIN_PRO = 3;
export const DAILY_MAX_FREE = 5;
export const DAILY_MAX_PRO = 5;
export const FREE_MIN_CONFIDENCE = 55;
export const PRO_MIN_CONFIDENCE = 60;

export function assignDailyTiers(predictions, options = {}) {
  const minFree = options.minFree ?? DAILY_MIN_FREE;
  const minPro = options.minPro ?? DAILY_MIN_PRO;
  const maxFree = options.maxFree ?? DAILY_MAX_FREE;
  const maxPro = options.maxPro ?? DAILY_MAX_PRO;
  const minFreeConfidence = options.minFreeConfidence ?? FREE_MIN_CONFIDENCE;
  const minProConfidence = options.minProConfidence ?? PRO_MIN_CONFIDENCE;
  const candidates = [...(predictions || [])]
    .filter(p => p?.id != null && Number.isFinite(Number(p.confidence)) && Number(p.confidence) >= minFreeConfidence)
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));
  const eligiblePro = candidates.filter(p => p.value === true && Number(p.confidence) >= minProConfidence)
    .sort((a, b) => (Number(b.edge) || 0) - (Number(a.edge) || 0) || Number(b.confidence) - Number(a.confidence));
  const desiredPro = Math.min(maxPro, eligiblePro.length);
  const proCount = Math.min(desiredPro, Math.max(0, candidates.length - Math.min(minFree, maxFree)));
  const proIds = new Set(eligiblePro.slice(0, proCount).map(p => String(p.id)));
  const pro = eligiblePro.filter(p => proIds.has(String(p.id))).map(p => ({ ...p, tier: 'pro' }));
  const remaining = candidates.filter(p => !proIds.has(String(p.id)));
  const freeCount = Math.min(maxFree, remaining.length);
  const free = remaining.slice(0, freeCount).map(p => ({ ...p, tier: 'free' }));
  const predictionIds = [...free, ...pro].map(p => String(p.id));
  if (new Set(predictionIds).size !== predictionIds.length) throw new Error('A match cannot be assigned to both tiers');
  const shortfall = { free: Math.max(0, minFree - free.length), pro: Math.max(0, minPro - pro.length) };
  return { free, pro, targets: { free: minFree, pro: minPro }, limits: { free: maxFree, pro: maxPro }, shortfall,
    candidateCount: candidates.length, eligibleProCount: eligiblePro.length };
}
