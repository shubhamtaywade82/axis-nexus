import { computeQuickBuyQuantity, buildQuickBuyPreview, executeQuickBuy, DEFAULT_RISK_PER_TRADE_INR } from '../services/expertTrades/quickBuy';
import type { RiskEngine } from '../services/riskEngine';
import type { PortfolioSource } from '../services/portfolioSource';
import type { PaperExecutionEngine } from '../engines/paper';
import type { ExpertTrade } from '../services/expertTrades/types';

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: 'xt_qb_unit',
    symbol: 'TCS',
    name: 'Tata Consultancy Services',
    sector: 'Information Technology',
    securityId: '11536',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 80, conviction: 80, intradayAligned: true },
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

function fakeRisk(allowed = true, reason?: string): RiskEngine {
  return { canTrade: jest.fn().mockReturnValue({ allowed, reason }) } as unknown as RiskEngine;
}

function fakePortfolio(availableMargin = 1_000_000): PortfolioSource {
  return {
    getWallet: jest.fn().mockResolvedValue({
      availableMargin, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0,
      unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: availableMargin, equity: availableMargin,
    }),
  } as unknown as PortfolioSource;
}

function fakePaper(response: any = { status: 'TRADED', fill_price: 4051, quantity: 50 }): PaperExecutionEngine {
  return { placeOrder: jest.fn().mockResolvedValue(response) } as unknown as PaperExecutionEngine;
}

describe('computeQuickBuyQuantity', () => {
  it('divides the risk budget by risk-per-share and floors it', () => {
    expect(computeQuickBuyQuantity(4050, 3950, 5000)).toBe(50); // 5000 / 100
    expect(computeQuickBuyQuantity(4050, 3950, 5250)).toBe(52); // floor(52.5)
  });

  it('returns 0 rather than a negative or infinite quantity when entry is not above stop', () => {
    expect(computeQuickBuyQuantity(100, 100, 5000)).toBe(0);
    expect(computeQuickBuyQuantity(100, 105, 5000)).toBe(0);
  });
});

describe('buildQuickBuyPreview', () => {
  it('computes capital/loss/profit figures off the server-sized quantity', async () => {
    const trade = makeTrade();
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio(), 5000);

    expect(preview.quantity).toBe(50);
    expect(preview.capitalRequired).toBeCloseTo(50 * 4050, 6);
    expect(preview.maxLossInr).toBeCloseTo(50 * 100, 6);
    expect(preview.target1ProfitInr).toBeCloseTo(50 * 100, 6);
    expect(preview.target2ProfitInr).toBeCloseTo(50 * 200, 6);
    expect(preview.eligible).toBe(true);
  });

  it('flags unaffordable when available margin is below capital required', async () => {
    const trade = makeTrade();
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio(1000), 5000);
    expect(preview.affordable).toBe(false);
  });

  it('surfaces the risk engine gate without blocking the preview itself', async () => {
    const trade = makeTrade();
    const preview = await buildQuickBuyPreview(trade, fakeRisk(false, 'Kill switch engaged'), fakePortfolio());
    expect(preview.riskGate).toEqual({ allowed: false, reason: 'Kill switch engaged' });
    expect(preview.eligible).toBe(true); // the gate is informational here; execution re-checks it
  });

  it('marks ineligible for a state past target1', async () => {
    const trade = makeTrade({ state: 'TARGET_1' });
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio());
    expect(preview.eligible).toBe(false);
    expect(preview.ineligibleReason).toMatch(/NEW or ACTIVE/);
  });

  it('marks ineligible once already bought', async () => {
    const trade = makeTrade({ execution: { status: 'PLACED', correlationId: 'xtqb_abc', quantity: 50, fillPrice: 4051, placedAt: Date.now(), mode: 'paper' } });
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio());
    expect(preview.eligible).toBe(false);
    expect(preview.ineligibleReason).toMatch(/Already bought/);
  });

  it('marks ineligible when the risk budget is too small to buy even one share', async () => {
    const trade = makeTrade(); // risk per share = 100
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio(), 50);
    expect(preview.quantity).toBe(0);
    expect(preview.eligible).toBe(false);
    expect(preview.ineligibleReason).toMatch(/rounds to zero/);
  });

  it('defaults to DEFAULT_RISK_PER_TRADE_INR when no override is given', async () => {
    const trade = makeTrade();
    const preview = await buildQuickBuyPreview(trade, fakeRisk(), fakePortfolio());
    expect(preview.riskPerTradeInr).toBe(DEFAULT_RISK_PER_TRADE_INR);
  });
});

describe('executeQuickBuy', () => {
  it('places a CNC MARKET BUY sized by risk, with stop-loss/target1 as risk_limits', async () => {
    const trade = makeTrade();
    const paper = fakePaper({ status: 'TRADED', fill_price: 4052, quantity: 50 });
    const result = await executeQuickBuy(trade, paper, 5000);

    expect(result.status).toBe('TRADED');
    expect(result.quantity).toBe(50);
    expect(result.fillPrice).toBe(4052);
    expect(paper.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        security_id: '11536', exchange_segment: 'NSE_EQ', product_type: 'CNC',
        transaction_type: 'BUY', order_type: 'MARKET', quantity: 50,
      }),
      risk_limits: { stop_loss: 3950, target: 4150 }, // target1, not target2 — see quickBuy.ts docstring
    }));
  });

  it('rejects without calling placeOrder when the state is not buyable', async () => {
    const trade = makeTrade({ state: 'STOPPED' });
    const paper = fakePaper();
    const result = await executeQuickBuy(trade, paper, 5000);
    expect(result.status).toBe('REJECTED');
    expect(paper.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects without calling placeOrder when already bought', async () => {
    const trade = makeTrade({ execution: { status: 'PLACED', correlationId: 'xtqb_abc', quantity: 50, fillPrice: 4051, placedAt: Date.now(), mode: 'paper' } });
    const paper = fakePaper();
    const result = await executeQuickBuy(trade, paper, 5000);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toMatch(/Already bought/);
    expect(paper.placeOrder).not.toHaveBeenCalled();
  });

  it('propagates a rejection from the execution engine (e.g. insufficient margin, risk gate)', async () => {
    const trade = makeTrade();
    const paper = fakePaper({ status: 'REJECTED', reason: 'Kill switch engaged' });
    const result = await executeQuickBuy(trade, paper, 5000);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('Kill switch engaged');
  });

  it('never places an order when the computed quantity is zero', async () => {
    const trade = makeTrade();
    const paper = fakePaper();
    const result = await executeQuickBuy(trade, paper, 10); // risk budget smaller than one share's risk
    expect(result.status).toBe('REJECTED');
    expect(paper.placeOrder).not.toHaveBeenCalled();
  });
});
