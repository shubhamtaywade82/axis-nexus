import { evaluateTransition } from '../services/expertTrades/lifecycle';
import type { ExpertTrade } from '../services/expertTrades/types';

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: 'xt_test_ongc',
    symbol: 'ONGC',
    name: 'Oil & Natural Gas Corp',
    sector: 'Energy',
    securityId: '2475',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 80, conviction: 80 },
    market: { regime: 'NEUTRAL' },
    levels: {
      current: 234.7, entry: 241.8, entryLow: 241.2, entryHigh: 244.2,
      stopLoss: 229, target1: 253.4, target2: 266, invalidationLevel: 226,
    },
    metrics: {
      riskPerShare: 12.8, downsidePct: -5.3, target1Pct: 4.8, target2Pct: 10,
      rr1: 0.91, rr2: 1.89, potentialProfitPct: 10, expectedHoldingDays: { min: 3, max: 10 },
    },
    thesis: [],
    invalidation: [],
    state: 'NEW',
    createdAt: now,
    expiresAt: now + 14 * 24 * 60 * 60 * 1000,
    lastEvaluatedAt: now,
    lastEvaluatedPrice: 234.7,
    ...overrides,
  };
}

describe('Lifecycle — deterministic state transitions', () => {
  it('stays NEW while CMP is below entry and above the invalidation level', () => {
    const trade = makeTrade();
    const next = evaluateTransition(trade, 235, Date.now());
    expect(next.state).toBe('NEW');
    expect(next.lastEvaluatedPrice).toBe(235);
  });

  it('triggers ACTIVE once CMP reaches the entry', () => {
    const trade = makeTrade();
    const next = evaluateTransition(trade, 242, Date.now());
    expect(next.state).toBe('ACTIVE');
    expect(next.triggeredAt).toBeDefined();
  });

  it('invalidates a NEW idea that breaks down before ever triggering', () => {
    const trade = makeTrade();
    const next = evaluateTransition(trade, 225, Date.now());
    expect(next.state).toBe('INVALIDATED');
    expect(next.closedAt).toBeDefined();
  });

  it('expires a NEW idea whose entry never triggers within the validity window', () => {
    const trade = makeTrade({ expiresAt: Date.now() - 1000 });
    const next = evaluateTransition(trade, 235, Date.now());
    expect(next.state).toBe('EXPIRED');
  });

  it('stops out an ACTIVE trade on a stop-loss touch', () => {
    const trade = makeTrade({ state: 'ACTIVE', triggeredAt: Date.now() - 1000 });
    const next = evaluateTransition(trade, 228, Date.now());
    expect(next.state).toBe('STOPPED');
    expect(next.closedAt).toBeDefined();
  });

  it('reaches TARGET_1 without closing the idea, and records target1HitAt', () => {
    const trade = makeTrade({ state: 'ACTIVE', triggeredAt: Date.now() - 1000 });
    const next = evaluateTransition(trade, 254, Date.now());
    expect(next.state).toBe('TARGET_1');
    expect(next.closedAt).toBeUndefined();
    expect(next.target1HitAt).toBeDefined();
  });

  it('reaches TARGET_2 from TARGET_1 and closes the idea, keeping the original target1HitAt', () => {
    const firstHitAt = Date.now() - 500;
    const trade = makeTrade({ state: 'TARGET_1', triggeredAt: Date.now() - 1000, target1HitAt: firstHitAt });
    const next = evaluateTransition(trade, 267, Date.now());
    expect(next.state).toBe('TARGET_2');
    expect(next.closedAt).toBeDefined();
    expect(next.target1HitAt).toBe(firstHitAt);
  });

  it('resolves a gap through both targets directly to TARGET_2, not TARGET_1, but still records target1HitAt', () => {
    const trade = makeTrade({ state: 'ACTIVE', triggeredAt: Date.now() - 1000 });
    const next = evaluateTransition(trade, 270, Date.now());
    expect(next.state).toBe('TARGET_2');
    expect(next.target1HitAt).toBeDefined();
  });

  it('expires an ACTIVE trade that never reaches target 1 within its holding horizon', () => {
    const triggeredAt = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago, horizon max is 10
    const trade = makeTrade({ state: 'ACTIVE', triggeredAt });
    const next = evaluateTransition(trade, 245, Date.now());
    expect(next.state).toBe('EXPIRED');
  });

  it('does not time out a trade that already banked target 1', () => {
    const triggeredAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const trade = makeTrade({ state: 'TARGET_1', triggeredAt });
    const next = evaluateTransition(trade, 255, Date.now());
    expect(next.state).toBe('TARGET_1');
  });

  it('leaves terminal states untouched', () => {
    const trade = makeTrade({ state: 'STOPPED', closedAt: Date.now() - 1000 });
    const next = evaluateTransition(trade, 500, Date.now());
    expect(next.state).toBe('STOPPED');
  });
});
