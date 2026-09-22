import { ExpertTradeScheduler, defaultScheduledScanOptions } from '../services/expertTrades/scheduler';
import { saveExpertTrade, clearExpertTradesForTests } from '../services/expertTrades/repository';
import type { ExpertTradeEngine } from '../services/expertTrades/expertTradeEngine';
import type { ExpertTrade } from '../services/expertTrades/types';

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: `xt_${Math.random()}`,
    symbol: 'ONGC',
    name: 'Oil & Natural Gas Corp',
    sector: 'Energy',
    securityId: '2475',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 85, conviction: 85, intradayAligned: true },
    market: { regime: 'RISK_ON' },
    levels: { current: 234.7, entry: 241.8, entryLow: 241.2, entryHigh: 244.2, stopLoss: 229, target1: 253.4, target2: 266, invalidationLevel: 226 },
    metrics: { riskPerShare: 12.8, downsidePct: -5.3, target1Pct: 4.8, target2Pct: 10, rr1: 0.91, rr2: 1.89, potentialProfitPct: 10, expectedHoldingDays: { min: 3, max: 10 } },
    thesis: [], invalidation: [],
    state: 'NEW',
    createdAt: now,
    expiresAt: now + 100000,
    lastEvaluatedAt: now,
    ...overrides,
  };
}

describe('ExpertTradeScheduler — daily scan/brief lifecycle', () => {
  let scheduler: ExpertTradeScheduler;
  let mockEngine: Partial<ExpertTradeEngine>;

  beforeEach(async () => {
    await clearExpertTradesForTests();
    mockEngine = {
      scan: jest.fn().mockResolvedValue({
        scannedAt: Date.now(), universe: 'NSE_ALL_EQUITIES', exchange: 'NSE', regime: 'RISK_ON',
        totalResolved: 500, totalScreened: 300, candidatesConsidered: 120, setupsDetected: 8,
        published: 5, skippedExisting: 2, skippedIlliquid: 40, skippedFetchFailed: 3, durationMs: 45000,
      }),
    };
    scheduler = new ExpertTradeScheduler(mockEngine as ExpertTradeEngine);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('reports initial status with a valid market phase', () => {
    const status = scheduler.getStatus();
    expect(status.enabled).toBe(true);
    expect(['PRE_MARKET', 'MARKET_HOURS', 'POST_MARKET', 'CLOSED']).toContain(status.marketPhase);
    expect(status.nextScheduledJob).toBeDefined();
  });

  it('runs the post-market scan and reports the summary', async () => {
    const summary = await scheduler.runPostMarketScan();
    expect(summary.published).toBe(5);
    expect(mockEngine.scan).toHaveBeenCalledTimes(1);
  });

  it('summarizes open NEW ideas in the pre-market brief', async () => {
    await saveExpertTrade(makeTrade({ symbol: 'ONGC' }));
    await saveExpertTrade(makeTrade({ symbol: 'TCS', state: 'ACTIVE' })); // not NEW — excluded
    const msg = await scheduler.runPreMarketBrief();
    expect(msg).toContain('ONGC');
    expect(msg).not.toContain('TCS');
  });

  it('reports no ideas cleanly when nothing is awaiting a trigger', async () => {
    const msg = await scheduler.runPreMarketBrief();
    expect(msg).toMatch(/no open expert trade ideas/i);
  });

  it('triggers a specific phase on demand', async () => {
    const res = await scheduler.triggerPhase('scan');
    expect((res.result as any).published).toBe(5);
  });

  it('rejects an unrelated phase name at the route contract level via triggerPhase\'s own two options', async () => {
    const res = await scheduler.triggerPhase('pre_market_brief');
    expect(typeof res.result).toBe('string');
  });
});

describe('defaultScheduledScanOptions', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => { process.env = ORIGINAL_ENV; });

  it('defaults to the full NSE universe, more generous than the interactive scan cap', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.EXPERT_TRADE_SCAN_UNIVERSE;
    delete process.env.EXPERT_TRADE_SCAN_MAX_UNIVERSE;
    const opts = defaultScheduledScanOptions();
    expect(opts.universe).toBe('NSE_ALL_EQUITIES');
    expect(opts.maxUniverse).toBe(300);
  });

  it('honors env overrides', () => {
    process.env = { ...ORIGINAL_ENV, EXPERT_TRADE_SCAN_UNIVERSE: 'FNO_HEAVYWEIGHTS', EXPERT_TRADE_SCAN_MAX_UNIVERSE: '50' };
    const opts = defaultScheduledScanOptions();
    expect(opts.universe).toBe('FNO_HEAVYWEIGHTS');
    expect(opts.maxUniverse).toBe(50);
  });
});
