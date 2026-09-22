import type { Candle, PerformanceMetrics } from '../research/types';
import type { ExpertTradeFeatures, ExpertTradeSetupType } from './types';

/**
 * Deterministic setup detection. Each detector returns a match strength in
 * [0, 1] (how cleanly the pattern fits) or `null` if the pattern does not
 * apply at all — this is NOT the final 0-100 score (that also needs the
 * risk/reward from the level engine and the market regime; see
 * scoringEngine.ts). A symbol may match more than one setup; the engine
 * picks the strongest.
 *
 * These are mechanical, auditable proxies for the five setup families in
 * the architecture spec, built only from what a single daily OHLCV series
 * plus the screener's PerformanceMetrics actually supports. True pivot-based
 * support/resistance and multi-timeframe confirmation are explicitly out of
 * scope for this pass (see features.ts) — every rule below says so at the
 * point it substitutes a rolling high/low for real market structure.
 */

const MIN_RELATIVE_VOLUME_BREAKOUT = 1.3;
const MIN_ADX_TREND = 20;

interface Detection { type: ExpertTradeSetupType; strength: number }

function detectBreakout(candles: Candle[], f: ExpertTradeFeatures): Detection | null {
  // Resistance measured over the 20 days BEFORE today, so "today closed
  // above it" is meaningful rather than circular (today's high feeds the
  // window it's being compared to).
  const priorWindow = candles.slice(-21, -1);
  if (priorWindow.length < 20) return null;
  const priorResistance = Math.max(...priorWindow.map((c) => c.high));
  if (f.price <= priorResistance) return null;
  const extension = ((f.price - priorResistance) / priorResistance) * 100;
  if (extension > 4) return null; // already run too far past the level to be "the" breakout bar
  if ((f.volume.relativeVolume ?? 0) < MIN_RELATIVE_VOLUME_BREAKOUT) return null;
  if (!f.trend.above50) return null;

  const volumeScore = Math.min(1, (f.volume.relativeVolume ?? 0) / 2.5);
  const tightnessScore = Math.max(0, 1 - extension / 4);
  return { type: 'BREAKOUT', strength: (volumeScore + tightnessScore) / 2 };
}

function detectBreakoutRetest(candles: Candle[], f: ExpertTradeFeatures): Detection | null {
  // A breakout in the last 10-30 sessions, now pulled back to within 2% of
  // that old resistance while holding above it.
  const lookback = candles.slice(-40, -8);
  if (lookback.length < 20) return null;
  const priorResistance = Math.max(...lookback.map((c) => c.high));
  const recentHigh = Math.max(...candles.slice(-8).map((c) => c.high));
  if (recentHigh <= priorResistance) return null; // never actually broke out
  const distancePct = ((f.price - priorResistance) / priorResistance) * 100;
  if (distancePct < -1 || distancePct > 3) return null; // not in the retest zone
  if ((f.momentum.rsi14 ?? 0) < 42) return null; // momentum should not have collapsed
  if (!f.trend.above50) return null;

  const zoneScore = 1 - Math.min(1, Math.abs(distancePct) / 3);
  const rsiScore = Math.min(1, ((f.momentum.rsi14 ?? 42) - 42) / 20);
  return { type: 'BREAKOUT_RETEST', strength: (zoneScore + rsiScore) / 2 };
}

function detectTrendPullback(f: ExpertTradeFeatures): Detection | null {
  if (!f.trend.above200 || f.trend.sma200Rising !== true) return null;
  if ((f.momentum.adx14 ?? 0) < MIN_ADX_TREND) return null;
  const rsi = f.momentum.rsi14;
  if (rsi == null || rsi < 38 || rsi > 58) return null; // cooled off, not broken
  if (!f.trend.above50) return null; // pullback within an uptrend, not a breakdown

  const rsiCentered = 1 - Math.abs(rsi - 48) / 10;
  const adxScore = Math.min(1, (f.momentum.adx14 ?? 0) / 40);
  return { type: 'TREND_PULLBACK', strength: (rsiCentered + adxScore) / 2 };
}

function detectBaseExpansion(candles: Candle[], f: ExpertTradeFeatures, perf: PerformanceMetrics): Detection | null {
  // A tight 20-day range (the "base") followed by an expansion day on
  // volume, closing near the top of the base.
  const rangePct = perf.close > 0 ? ((f.structure.resistance20d - f.structure.support20d) / perf.close) * 100 : 100;
  if (rangePct > 10) return null; // not tight enough to call a base
  if ((f.volume.relativeVolume ?? 0) < 1.4) return null;
  const proximityToTopPct = ((f.structure.resistance20d - f.price) / f.structure.resistance20d) * 100;
  if (proximityToTopPct > 2.5) return null; // expansion should be pressing the top of the base
  if (!f.trend.above50) return null;

  const tightnessScore = Math.max(0, 1 - rangePct / 10);
  const volumeScore = Math.min(1, (f.volume.relativeVolume ?? 0) / 2.5);
  return { type: 'BASE_EXPANSION', strength: (tightnessScore + volumeScore) / 2 };
}

function detectMomentumContinuation(f: ExpertTradeFeatures): Detection | null {
  if ((f.relativeStrength.vs60d ?? 0) < 8) return null;
  if ((f.momentum.adx14 ?? 0) < 25) return null;
  if (!f.trend.above20 || !f.trend.above50) return null;
  // Needs room to run — a resistance wall within 3% negates "continuation".
  if (f.structure.distanceToResistancePct != null && f.structure.distanceToResistancePct < 3) return null;
  if ((f.volume.relativeVolume ?? 0) < 1.05) return null;

  const rsScore = Math.min(1, (f.relativeStrength.vs60d ?? 0) / 25);
  const adxScore = Math.min(1, (f.momentum.adx14 ?? 0) / 45);
  return { type: 'MOMENTUM_CONTINUATION', strength: (rsScore + adxScore) / 2 };
}

/** Returns every matched setup, strongest first. Empty when nothing fits —
 * most candidates on any given day should return nothing; that is the
 * point of a setup engine over a plain screener. */
export function detectSetups(
  candles: Candle[],
  features: ExpertTradeFeatures,
  perf: PerformanceMetrics,
): Array<{ type: ExpertTradeSetupType; strength: number }> {
  const detections = [
    detectBreakout(candles, features),
    detectBreakoutRetest(candles, features),
    detectTrendPullback(features),
    detectBaseExpansion(candles, features, perf),
    detectMomentumContinuation(features),
  ].filter((d): d is Detection => d != null);

  detections.sort((a, b) => b.strength - a.strength);
  return detections;
}
