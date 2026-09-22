import { adx, atr, rsi, supertrend } from '@nemesis-oss/dhanhq-sdk';
import type { Candle, PerformanceMetrics } from '../research/types';
import type { ExpertTradeFeatures } from './types';

/** Last non-null value in a leading-null indicator series. */
function last<T>(series: Array<T | null>): T | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i] as T;
  }
  return null;
}

/**
 * Deterministic technical feature vector for one instrument, built from
 * daily OHLCV plus the `PerformanceMetrics` the screener already computed
 * (so SMA/return/RS logic lives in exactly one place). Everything here is
 * a real indicator over real candles — RSI/ATR/ADX/Supertrend come from
 * the DhanHQ SDK's `ta` module, not a reimplementation.
 *
 * Single-timeframe (daily) by design for this MVP: the full multi-timeframe
 * pipeline (1D/4H/1H/15m/5m) described in the architecture spec needs a
 * per-symbol intraday candle cache to be affordable across hundreds of
 * symbols, which does not exist yet (see AdaptiveSupertrendCandles for the
 * closest precedent, built for a handful of indices, not the equity
 * universe). Daily-only detection is a real, honest simplification, not a
 * placeholder pretending to be more.
 */
export function computeFeatures(candles: Candle[], perf: PerformanceMetrics): ExpertTradeFeatures | null {
  if (candles.length < 60) return null;
  const close = perf.close;
  if (!(close > 0)) return null;

  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(candles, 14);
  const adxResult = adx(candles, 14);
  const supertrendResult = supertrend(candles, { period: 10, multiplier: 3 });

  const atr14 = last(atrSeries);
  const atrPct = atr14 != null ? (atr14 / close) * 100 : null;

  const window20 = candles.slice(-20);
  const resistance20d = Math.max(...window20.map((c) => c.high));
  const support20d = Math.min(...window20.map((c) => c.low));

  const window60 = candles.slice(-60);
  const swingHigh60d = Math.max(...window60.map((c) => c.high));
  const swingLow60d = Math.min(...window60.map((c) => c.low));

  const trailing20Vol = candles.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20;
  const todayVol = candles[candles.length - 1].volume;
  const relativeVolume = trailing20Vol > 0 ? todayVol / trailing20Vol : null;

  return {
    price: close,
    trend: {
      above20: perf.sma20 != null && close > perf.sma20,
      above50: perf.sma50 != null && close > perf.sma50,
      above200: perf.sma200 != null && close > perf.sma200,
      sma200Rising: perf.sma200Rising,
    },
    momentum: {
      rsi14: last(rsiSeries),
      adx14: last(adxResult.adx),
      roc20Pct: perf.return20d,
    },
    volatility: { atr14, atrPct },
    volume: { relativeVolume },
    structure: {
      resistance20d,
      support20d,
      swingHigh60d,
      swingLow60d,
      distanceToResistancePct: resistance20d > 0 ? ((resistance20d - close) / close) * 100 : null,
    },
    relativeStrength: {
      vs60d: perf.relativeStrength60d,
      vs250d: perf.relativeStrength250d,
    },
    supertrendDirection: last(supertrendResult.direction),
  };
}
