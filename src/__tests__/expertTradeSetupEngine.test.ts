import { detectSetups } from '../services/expertTrades/setupEngine';
import { computeFeatures } from '../services/expertTrades/features';
import { computePerformance } from '../services/research/performance';
import type { Candle } from '../services/research/types';

/** Flat/choppy series: oscillates with no net drift and no volume spike —
 * should trigger no setup at all. */
function choppySeries(days: number, base: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < days; i++) {
    const wobble = Math.sin(i / 3) * 0.5;
    const close = base + wobble;
    out.push({ close, high: close + 0.3, low: close - 0.3, volume: 1_000_000 });
  }
  return out;
}

/** A steady uptrend for `days` sessions, then a clean breakout bar above
 * the prior 20-day high on volume expansion. */
function breakoutSeries(days: number, base: number): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < days; i++) {
    price *= 1.001; // gentle grind higher, keeps trend filters satisfied
    out.push({ close: price, high: price * 1.005, low: price * 0.995, volume: 1_000_000 });
  }
  const lastClose = out[out.length - 1].close;
  const priorHigh = Math.max(...out.slice(-20).map((c) => c.high));
  const breakoutClose = priorHigh * 1.015;
  out.push({ close: breakoutClose, high: breakoutClose * 1.005, low: lastClose * 0.998, volume: 3_000_000 });
  return out;
}

function build(candles: Candle[], benchmark: Candle[]) {
  const perf = computePerformance(candles, benchmark)!;
  const features = computeFeatures(candles, perf)!;
  return { perf, features };
}

describe('Setup engine — deterministic pattern detection', () => {
  it('detects nothing in flat, low-conviction chop', () => {
    const bench = choppySeries(260, 100);
    const candles = choppySeries(260, 200);
    const { perf, features } = build(candles, bench);
    expect(detectSetups(candles, features, perf)).toHaveLength(0);
  });

  it('flags a breakout on a new high with volume expansion, above the 50-day average', () => {
    const bench = choppySeries(260, 100);
    const candles = breakoutSeries(260, 200);
    const { perf, features } = build(candles, bench);
    const setups = detectSetups(candles, features, perf);
    expect(setups.map((s) => s.type)).toContain('BREAKOUT');
  });

  it('does not flag a breakout without volume confirmation', () => {
    const bench = choppySeries(260, 100);
    const candles = breakoutSeries(260, 200);
    // Zero out the expansion on the final bar — same price move, no volume.
    candles[candles.length - 1] = { ...candles[candles.length - 1], volume: 900_000 };
    const { perf, features } = build(candles, bench);
    const setups = detectSetups(candles, features, perf);
    expect(setups.map((s) => s.type)).not.toContain('BREAKOUT');
  });

  it('ranks matched setups strongest-first', () => {
    const bench = choppySeries(260, 100);
    const candles = breakoutSeries(260, 200);
    const { perf, features } = build(candles, bench);
    const setups = detectSetups(candles, features, perf);
    for (let i = 0; i < setups.length - 1; i++) {
      expect(setups[i].strength).toBeGreaterThanOrEqual(setups[i + 1].strength);
    }
  });
});
