import { saveExpertTrade, updateExpertTrade, listExpertTrades, getExpertTrade, getExpertTradesBySymbol, hasOpenExpertTrade, clearExpertTradesForTests } from '../services/expertTrades/repository';
import type { ExpertTrade } from '../services/expertTrades/types';
import { dbMode } from '../db';

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: `xt_${now}_test`,
    symbol: 'TCS',
    name: 'Tata Consultancy Services',
    sector: 'Information Technology',
    securityId: '11536',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 82, conviction: 82, intradayAligned: true },
    market: { regime: 'RISK_ON' },
    levels: { current: 4000, entry: 4050, entryLow: 4030, entryHigh: 4070, stopLoss: 3950, target1: 4150, target2: 4250, invalidationLevel: 3920 },
    metrics: { riskPerShare: 100, downsidePct: -2.5, target1Pct: 2.5, target2Pct: 5, rr1: 1, rr2: 2, potentialProfitPct: 5, expectedHoldingDays: { min: 3, max: 10 } },
    thesis: [], invalidation: [],
    state: 'NEW',
    createdAt: now,
    expiresAt: now + 100000,
    lastEvaluatedAt: now,
    ...overrides,
  };
}

describe('ExpertTradeRepository — memory-mode persistence', () => {
  beforeEach(async () => {
    await clearExpertTradesForTests();
  });

  it('never writes to Postgres from the test environment', () => {
    expect(dbMode()).toBe('memory');
  });

  it('saves and retrieves a trade by id', async () => {
    const trade = makeTrade();
    await saveExpertTrade(trade);
    const fetched = await getExpertTrade(trade.id);
    expect(fetched?.symbol).toBe('TCS');
  });

  it('lists trades filtered by state, sorted by score descending', async () => {
    await saveExpertTrade(makeTrade({ id: 'a', symbol: 'A', setup: { type: 'BREAKOUT', score: 60, conviction: 60, intradayAligned: true } }));
    await saveExpertTrade(makeTrade({ id: 'b', symbol: 'B', setup: { type: 'BREAKOUT', score: 90, conviction: 90, intradayAligned: true } }));
    await saveExpertTrade(makeTrade({ id: 'c', symbol: 'C', state: 'STOPPED', setup: { type: 'BREAKOUT', score: 99, conviction: 99, intradayAligned: true } }));

    const open = await listExpertTrades({ state: ['NEW'] });
    expect(open.map((t) => t.symbol)).toEqual(['B', 'A']);
  });

  it('updates state in place without creating a duplicate row', async () => {
    const trade = makeTrade({ id: 'dup-check' });
    await saveExpertTrade(trade);
    await updateExpertTrade({ ...trade, state: 'ACTIVE', triggeredAt: Date.now() });

    const bySymbol = await getExpertTradesBySymbol('TCS');
    expect(bySymbol).toHaveLength(1);
    expect(bySymbol[0].state).toBe('ACTIVE');
  });

  it('reports an open trade for a symbol so the scanner will not republish it', async () => {
    await saveExpertTrade(makeTrade({ id: 'open-1', symbol: 'INFY' }));
    expect(await hasOpenExpertTrade('INFY')).toBe(true);
    expect(await hasOpenExpertTrade('WIPRO')).toBe(false);
  });

  it('does not count a closed trade as open', async () => {
    await saveExpertTrade(makeTrade({ id: 'closed-1', symbol: 'HCLTECH', state: 'STOPPED' }));
    expect(await hasOpenExpertTrade('HCLTECH')).toBe(false);
  });
});
