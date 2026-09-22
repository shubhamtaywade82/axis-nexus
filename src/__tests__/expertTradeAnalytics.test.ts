import { computeOutcomeStats } from '../services/expertTrades/analytics';
import type { ExpertTrade } from '../services/expertTrades/types';

const DAY = 24 * 60 * 60 * 1000;

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: `xt_${Math.random()}`,
    symbol: 'TCS',
    name: 'Tata Consultancy Services',
    sector: 'Information Technology',
    securityId: '11536',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 80, conviction: 80 },
    market: { regime: 'NEUTRAL' },
    levels: { current: 100, entry: 100, entryLow: 99, entryHigh: 101, stopLoss: 95, target1: 108, target2: 115, invalidationLevel: 93 },
    metrics: { riskPerShare: 5, downsidePct: -5, target1Pct: 8, target2Pct: 15, rr1: 1.6, rr2: 3, potentialProfitPct: 15, expectedHoldingDays: { min: 3, max: 10 } },
    thesis: [], invalidation: [],
    state: 'STOPPED',
    createdAt: now - 5 * DAY,
    expiresAt: now + 10 * DAY,
    lastEvaluatedAt: now,
    ...overrides,
  };
}

describe('Outcome analytics — realized returns off actual observed prices', () => {
  it('reports no sample when nothing has ever triggered', () => {
    const trades = [makeTrade({ state: 'INVALIDATED', triggeredAt: undefined, closedAt: Date.now() })];
    const { overall } = computeOutcomeStats(trades);
    expect(overall.sampleSize).toBe(0);
    expect(overall.neverTriggered).toBe(1);
    expect(overall.winRate).toBeNull();
    expect(overall.expectancyPct).toBeNull();
  });

  it('computes win rate and expectancy off lastEvaluatedPrice, not the idealized target/stop', () => {
    const triggeredAt = Date.now() - 4 * DAY;
    const closedAt = Date.now();
    const winner = makeTrade({
      state: 'TARGET_2', triggeredAt, closedAt,
      lastEvaluatedPrice: 116, // slipped 1 point past the idealized target2 of 115
    });
    const loser = makeTrade({
      state: 'STOPPED', triggeredAt, closedAt,
      lastEvaluatedPrice: 94, // slipped 1 point past the idealized stop of 95
    });

    const { overall } = computeOutcomeStats([winner, loser]);
    expect(overall.sampleSize).toBe(2);
    expect(overall.winRate).toBe(0.5);
    expect(overall.avgWinnerPct).toBeCloseTo(16, 6); // (116-100)/100 * 100
    expect(overall.avgLoserPct).toBeCloseTo(-6, 6); // (94-100)/100 * 100
    expect(overall.expectancyPct).toBeCloseTo((16 - 6) / 2, 6);
  });

  it('counts a gap straight through target2 as a target1 hit too', () => {
    const triggeredAt = Date.now() - 2 * DAY;
    const trade = makeTrade({
      state: 'TARGET_2', triggeredAt, closedAt: Date.now(),
      target1HitAt: triggeredAt + DAY, // set by lifecycle.ts even on a gap
      lastEvaluatedPrice: 120,
    });
    const { overall } = computeOutcomeStats([trade]);
    expect(overall.target1HitRate).toBe(1);
    expect(overall.target2HitRate).toBe(1);
  });

  it('does not count target1 as hit when the trade never reached it', () => {
    const trade = makeTrade({ state: 'STOPPED', triggeredAt: Date.now() - DAY, closedAt: Date.now(), target1HitAt: undefined, lastEvaluatedPrice: 95 });
    const { overall } = computeOutcomeStats([trade]);
    expect(overall.target1HitRate).toBe(0);
  });

  it('computes median holding days from trigger to close', () => {
    const now = Date.now();
    const trades = [
      makeTrade({ triggeredAt: now - 10 * DAY, closedAt: now - 8 * DAY, lastEvaluatedPrice: 96 }), // 2 days
      makeTrade({ triggeredAt: now - 10 * DAY, closedAt: now - 4 * DAY, lastEvaluatedPrice: 96 }), // 6 days
      makeTrade({ triggeredAt: now - 10 * DAY, closedAt: now - 6 * DAY, lastEvaluatedPrice: 96 }), // 4 days
    ];
    const { overall } = computeOutcomeStats(trades);
    expect(overall.medianHoldingDays).toBeCloseTo(4, 6);
  });

  it('breaks results down per setup type, ranked by expectancy', () => {
    const triggeredAt = Date.now() - 3 * DAY;
    const goodSetup = makeTrade({ setup: { type: 'MOMENTUM_CONTINUATION', score: 70, conviction: 70 }, state: 'TARGET_2', triggeredAt, closedAt: Date.now(), lastEvaluatedPrice: 120 });
    const badSetup = makeTrade({ setup: { type: 'BREAKOUT', score: 70, conviction: 70 }, state: 'STOPPED', triggeredAt, closedAt: Date.now(), lastEvaluatedPrice: 90 });

    const { bySetup } = computeOutcomeStats([goodSetup, badSetup]);
    expect(bySetup.map((s) => s.setupType)).toEqual(['MOMENTUM_CONTINUATION', 'BREAKOUT']);
    expect(bySetup[0].expectancyPct).toBeGreaterThan(bySetup[1].expectancyPct!);
  });

  it('separates never-triggered ideas from realized win/loss', () => {
    const realized = makeTrade({ state: 'STOPPED', triggeredAt: Date.now() - DAY, closedAt: Date.now(), lastEvaluatedPrice: 95 });
    const neverTriggered = makeTrade({ state: 'EXPIRED', triggeredAt: undefined, closedAt: Date.now() });
    const { overall } = computeOutcomeStats([realized, neverTriggered]);
    expect(overall.sampleSize).toBe(1);
    expect(overall.neverTriggered).toBe(1);
  });
});
