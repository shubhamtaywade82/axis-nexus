import type { PerformanceMetrics } from '../research/types';
import type { ExpertTradeFeatures, ExpertTradeMetrics, ExpertTradeSetup, ExpertTradeSetupType, MarketRegime } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A coarse read of the NIFTY tape. Shades the score; never gates a setup
 * outright — a genuine breakout in a neutral tape is still a breakout. */
export function computeMarketRegime(niftyPerf: PerformanceMetrics): MarketRegime {
  if (niftyPerf.sma50 == null) return 'NEUTRAL';
  const aboveTrend = niftyPerf.close > niftyPerf.sma50;
  const momentum = niftyPerf.return20d ?? 0;
  if (aboveTrend && momentum > 0.5) return 'RISK_ON';
  if (!aboveTrend && momentum < -0.5) return 'RISK_OFF';
  return 'NEUTRAL';
}

const REGIME_SCORE: Record<MarketRegime, number> = { RISK_ON: 5, NEUTRAL: 3, RISK_OFF: 0 };

/**
 * Composite 0-100 score, computed only after the level engine has produced
 * a risk/reward — a setup cannot be scored on trend/momentum/volume alone,
 * because the whole point of section 11/12 of the architecture brief is
 * that a technically clean setup with a poor R:R is not a good trade.
 *
 * This is for RANKING AND AUDITABILITY, not a probability estimate — no
 * claim of "90/100 = 90% win rate" is made or implied anywhere downstream.
 * A real probability layer needs the historical outcome sample size the
 * lifecycle/outcome tracker in this module starts accumulating (see
 * repository.ts) — it does not exist on day one.
 */
export function scoreSetup(
  setupType: ExpertTradeSetupType,
  strength: number,
  f: ExpertTradeFeatures,
  metrics: ExpertTradeMetrics,
  regime: MarketRegime,
): ExpertTradeSetup {
  const trendScore = [f.trend.above20, f.trend.above50, f.trend.above200, f.trend.sma200Rising === true]
    .filter(Boolean).length * 5; // 0-20

  const rsi = f.momentum.rsi14 ?? 50;
  const rsiFit = 1 - clamp(Math.abs(rsi - 55) / 25, 0, 1); // sweet spot ~55, not overbought/oversold
  const adxFit = clamp((f.momentum.adx14 ?? 0) / 40, 0, 1);
  const momentumScore = (rsiFit * 0.5 + adxFit * 0.5) * 15; // 0-15

  const rs = ((f.relativeStrength.vs60d ?? 0) + (f.relativeStrength.vs250d ?? 0)) / 2;
  const rsScore = clamp((rs + 10) / 30, 0, 1) * 15; // -10%..+20% -> 0..15

  const volumeScore = clamp(((f.volume.relativeVolume ?? 1) - 1) / 1.5, 0, 1) * 15; // 0-15

  const structureScore = strength * 15; // how cleanly the pattern itself fit, 0-15

  const rrScore = metrics.rr1 >= 2 ? 10 : metrics.rr1 >= 1.5 ? 7 : metrics.rr1 >= 1 ? 5 : metrics.rr1 >= 0.8 ? 3 : 0;

  const atrPct = f.volatility.atrPct;
  const volatilityScore = atrPct == null ? 2.5 : clamp(1 - Math.abs(atrPct - 2.5) / 4, 0, 1) * 5; // healthy band ~1-4%

  const regimeScore = REGIME_SCORE[regime];

  const total = trendScore + momentumScore + rsScore + volumeScore + structureScore + rrScore + volatilityScore + regimeScore;
  const score = Math.round(clamp(total, 0, 100));

  return { type: setupType, score, conviction: score };
}
