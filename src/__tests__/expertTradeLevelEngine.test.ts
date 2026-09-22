import { buildLevels, computeMetrics, resolveHorizon, MIN_RR1 } from '../services/expertTrades/levelEngine';
import type { ExpertTradeFeatures } from '../services/expertTrades/types';

function baseFeatures(overrides: Partial<ExpertTradeFeatures> = {}): ExpertTradeFeatures {
  return {
    price: 241.8,
    trend: { above20: true, above50: true, above200: true, sma200Rising: true },
    momentum: { rsi14: 58, adx14: 28, roc20Pct: 6 },
    volatility: { atr14: 5, atrPct: 2.1 },
    volume: { relativeVolume: 1.8 },
    structure: {
      resistance20d: 241.2,
      support20d: 225,
      swingHigh60d: 253.4,
      swingLow60d: 218,
      distanceToResistancePct: -0.25,
    },
    relativeStrength: { vs60d: 5, vs250d: 8 },
    supertrendDirection: 1,
    ...overrides,
  };
}

describe('Level engine — entry/stop/target construction', () => {
  it('builds a breakout entry above resistance with a structural or ATR stop, whichever is tighter', () => {
    const levels = buildLevels('BREAKOUT', baseFeatures());
    expect(levels).not.toBeNull();
    expect(levels!.entry).toBeGreaterThan(baseFeatures().structure.resistance20d);
    expect(levels!.stopLoss).toBeLessThan(levels!.entry);
    expect(levels!.stopLoss).toBeGreaterThanOrEqual(baseFeatures().structure.swingLow60d);
  });

  it('uses the current price as entry for a pullback/continuation setup (already in the zone)', () => {
    const f = baseFeatures();
    const levels = buildLevels('TREND_PULLBACK', f);
    expect(levels!.entry).toBe(f.price);
  });

  it('never places the target below entry, and target2 >= target1', () => {
    const levels = buildLevels('MOMENTUM_CONTINUATION', baseFeatures())!;
    expect(levels.target1).toBeGreaterThan(levels.entry);
    expect(levels.target2).toBeGreaterThanOrEqual(levels.target1);
  });

  it('computes risk/reward and rejects setups below the minimum R:R on target 1', () => {
    // Entry right at resistance with a very wide ATR stop -> poor R:R on T1.
    const f = baseFeatures({
      structure: { resistance20d: 100, support20d: 40, swingHigh60d: 102, swingLow60d: 20, distanceToResistancePct: 0 },
      volatility: { atr14: 40, atrPct: 40 }, // absurdly wide stop relative to the setup
    });
    const levels = buildLevels('BREAKOUT', f)!;
    const metrics = computeMetrics(levels, resolveHorizon('BREAKOUT'));
    expect(metrics.rr1).toBeLessThan(MIN_RR1);
  });

  it('reports potential profit off target2 vs entry, not off current price', () => {
    const f = baseFeatures();
    const levels = buildLevels('BREAKOUT', f)!;
    const metrics = computeMetrics(levels, resolveHorizon('BREAKOUT'));
    const expected = ((levels.target2 - levels.entry) / levels.entry) * 100;
    expect(metrics.potentialProfitPct).toBeCloseTo(expected, 6);
  });

  it('falls back to a percentage stop when structure alone would put the stop at or above entry', () => {
    // swingLow60d above entry is contrived, but exercises the explicit
    // sanity fallback in buildLevels rather than relying on it never firing.
    const f = baseFeatures({
      price: 100,
      volatility: { atr14: null, atrPct: null },
      structure: { resistance20d: 100, support20d: 99.5, swingHigh60d: 105, swingLow60d: 100.5, distanceToResistancePct: 0 },
    });
    const levels = buildLevels('TREND_PULLBACK', f);
    expect(levels).not.toBeNull();
    expect(levels!.entry).toBe(100);
    expect(levels!.stopLoss).toBeCloseTo(95, 6); // entry * (1 - 5%)
  });

  it('maps setup types to a fixed, documented horizon', () => {
    expect(resolveHorizon('BREAKOUT')).toBe('SHORT_TERM');
    expect(resolveHorizon('TREND_PULLBACK')).toBe('MID_TERM');
    expect(resolveHorizon('BASE_EXPANSION')).toBe('MID_TERM');
    expect(resolveHorizon('MOMENTUM_CONTINUATION')).toBe('SHORT_TERM');
  });
});
