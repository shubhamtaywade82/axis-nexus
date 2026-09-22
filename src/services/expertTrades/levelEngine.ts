import type { ExpertTradeFeatures, ExpertTradeHorizon, ExpertTradeLevels, ExpertTradeMetrics, ExpertTradeSetupType } from './types';

/** Below this risk/reward on target 1, the setup is rejected outright — a
 * visually clean pattern whose structural target does not justify the
 * structural risk is not a trade, per the architecture brief's own point
 * (section 11). */
export const MIN_RR1 = 0.8;

const ENTRY_BUFFER_PCT: Partial<Record<ExpertTradeSetupType, number>> = {
  BREAKOUT: 0.25,
  BASE_EXPANSION: 0.25,
};

const ATR_STOP_MULTIPLIER = 1.5;
const FALLBACK_STOP_PCT = 5; // used only when ATR is unavailable (short history)

const HORIZON_HOLDING_DAYS: Record<ExpertTradeHorizon, { min: number; max: number }> = {
  SHORT_TERM: { min: 3, max: 10 },
  MID_TERM: { min: 10, max: 30 },
  LONG_TERM: { min: 30, max: 90 },
};

/** Setup type -> holding horizon. A fixed, documented mapping rather than a
 * free-form guess: breakouts and continuation moves are meant to resolve
 * quickly, pullbacks/bases are given more room. */
export function resolveHorizon(setupType: ExpertTradeSetupType): ExpertTradeHorizon {
  if (setupType === 'TREND_PULLBACK' || setupType === 'BASE_EXPANSION') return 'MID_TERM';
  return 'SHORT_TERM';
}

/**
 * Builds the numeric entry/stop/target levels for a detected setup.
 * Returns `null` only when there is not enough structure to place a sane
 * stop (e.g. no ATR and price already at the 60-day low) — callers must
 * still separately reject on `MIN_RR1` after calling `computeMetrics`.
 */
export function buildLevels(setupType: ExpertTradeSetupType, f: ExpertTradeFeatures): ExpertTradeLevels | null {
  const buffer = ENTRY_BUFFER_PCT[setupType] ?? 0;
  // Breakout/base-expansion setups trigger on a move through resistance;
  // pullback/retest/continuation setups are already in the zone, so the
  // entry is the current price itself.
  const entry = buffer > 0
    ? f.structure.resistance20d * (1 + buffer / 100)
    : f.price;
  if (!(entry > 0)) return null;

  const structuralStop = setupType === 'BREAKOUT' || setupType === 'BASE_EXPANSION'
    ? f.structure.resistance20d * 0.985 // retest of the breakout level failing
    : f.structure.support20d;

  const atrStop = f.volatility.atr14 != null
    ? entry - ATR_STOP_MULTIPLIER * f.volatility.atr14
    : null;

  let stopLoss = atrStop != null ? Math.min(structuralStop, atrStop) : structuralStop;
  // Never below the 60-day swing low — beyond that this is not a "pullback
  // stop", it is a different (and much larger) trade.
  stopLoss = Math.max(stopLoss, f.structure.swingLow60d);
  if (!(stopLoss > 0) || stopLoss >= entry) {
    stopLoss = entry * (1 - FALLBACK_STOP_PCT / 100);
  }
  if (stopLoss >= entry) return null; // structure genuinely will not support a long here

  const risk = entry - stopLoss;

  // Target 1: the next real resistance above entry, or (if there is none
  // within reach) a conservative 1.5R measured move.
  const structuralTarget1 = f.structure.swingHigh60d > entry * 1.01 ? f.structure.swingHigh60d : null;
  const target1 = structuralTarget1 ?? entry + risk * 1.5;

  // Target 2: range projection (the 20-day range added above the breakout)
  // vs. a 2.5R measured move — whichever is further, since either is a
  // legitimate technical basis and this is deliberately the more generous
  // of the two targets, not the conservative one.
  const rangeProjection = entry + (f.structure.resistance20d - f.structure.support20d);
  const measuredMove = entry + risk * 2.5;
  const target2 = Math.max(rangeProjection, measuredMove, target1 * 1.01);

  const invalidationLevel = Math.min(stopLoss, f.structure.support20d) * 0.99;

  return {
    current: f.price,
    entry,
    entryLow: buffer > 0 ? f.structure.resistance20d : entry * 0.995,
    entryHigh: entry * 1.01,
    stopLoss,
    target1,
    target2,
    invalidationLevel,
  };
}

export function computeMetrics(levels: ExpertTradeLevels, horizon: ExpertTradeHorizon): ExpertTradeMetrics {
  const risk = levels.entry - levels.stopLoss;
  const pct = (value: number) => ((value - levels.entry) / levels.entry) * 100;

  return {
    riskPerShare: risk,
    downsidePct: pct(levels.stopLoss),
    target1Pct: pct(levels.target1),
    target2Pct: pct(levels.target2),
    rr1: risk > 0 ? (levels.target1 - levels.entry) / risk : 0,
    rr2: risk > 0 ? (levels.target2 - levels.entry) / risk : 0,
    potentialProfitPct: pct(levels.target2),
    expectedHoldingDays: HORIZON_HOLDING_DAYS[horizon],
  };
}
