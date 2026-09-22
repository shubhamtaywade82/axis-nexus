import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { expertTradesRoutes } from '../routes/expertTrades';
import type { ExpertTradeEngine } from '../services/expertTrades/expertTradeEngine';
import type { ExpertTradeScheduler } from '../services/expertTrades/scheduler';
import { saveExpertTrade, clearExpertTradesForTests } from '../services/expertTrades/repository';
import type { ExpertTrade } from '../services/expertTrades/types';

function makeTrade(overrides: Partial<ExpertTrade> = {}): ExpertTrade {
  const now = Date.now();
  return {
    id: 'xt_route_test',
    symbol: 'ONGC',
    name: 'Oil & Natural Gas Corp',
    sector: 'Energy',
    securityId: '2475',
    exchangeSegment: 'NSE_EQ',
    exchange: 'NSE',
    direction: 'LONG',
    horizon: 'SHORT_TERM',
    setup: { type: 'BREAKOUT', score: 88, conviction: 88 },
    market: { regime: 'RISK_ON' },
    levels: { current: 234.7, entry: 241.8, entryLow: 241.2, entryHigh: 244.2, stopLoss: 229, target1: 253.4, target2: 266, invalidationLevel: 226 },
    metrics: { riskPerShare: 12.8, downsidePct: -5.3, target1Pct: 4.8, target2Pct: 10, rr1: 0.91, rr2: 1.89, potentialProfitPct: 10, expectedHoldingDays: { min: 3, max: 10 } },
    thesis: ['Breakout above 20-day resistance'],
    invalidation: ['Daily close below ₹226'],
    state: 'NEW',
    createdAt: now,
    expiresAt: now + 100000,
    lastEvaluatedAt: now,
    ...overrides,
  };
}

describe('Expert Trades Routes HTTP API', () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let mockEngine: Partial<ExpertTradeEngine>;
  let mockScheduler: Partial<ExpertTradeScheduler>;

  beforeAll(async () => {
    await clearExpertTradesForTests();
    await saveExpertTrade(makeTrade());
    await saveExpertTrade(makeTrade({ id: 'xt_past', symbol: 'RELIANCE', state: 'TARGET_2', closedAt: Date.now() }));

    mockEngine = {
      getStatus: jest.fn().mockReturnValue({ scannedAt: Date.now(), universe: 'FNO_HEAVYWEIGHTS', published: 2 }),
      scan: jest.fn().mockResolvedValue({ scannedAt: Date.now(), universe: 'FNO_HEAVYWEIGHTS', published: 1 }),
    };
    mockScheduler = {
      getStatus: jest.fn().mockReturnValue({
        enabled: true, marketPhase: 'CLOSED', nextScheduledJob: 'Post-Market Scan (15:50 IST)',
        nextJobTimeIst: '16:00 IST', telegramEnabled: false, openIdeaCount: 0, lastRunTimes: {},
      }),
      triggerPhase: jest.fn().mockResolvedValue({ result: 'brief text' }),
    };

    app = express();
    app.use(express.json());
    app.use('/api/expert-trades', expertTradesRoutes(mockEngine as unknown as ExpertTradeEngine, mockScheduler as unknown as ExpertTradeScheduler));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}/api/expert-trades`;
        resolve();
      });
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('GET / returns open trade ideas by default', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.trades.map((t: any) => t.symbol)).toContain('ONGC');
    expect(data.trades.map((t: any) => t.symbol)).not.toContain('RELIANCE');
  });

  it('GET /past returns closed trade ideas', async () => {
    const res = await fetch(`${baseUrl}/past`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.trades.map((t: any) => t.symbol)).toEqual(['RELIANCE']);
  });

  it('GET /stats returns outcome analytics computed from every closed trade', async () => {
    const res = await fetch(`${baseUrl}/stats`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.overall).toBeDefined();
    expect(data.overall.setupType).toBe('ALL');
    expect(Array.isArray(data.bySetup)).toBe(true);
    // The seeded 'xt_past' fixture never set triggeredAt, so it counts as
    // never-triggered rather than a realized win/loss.
    expect(data.overall.neverTriggered).toBeGreaterThanOrEqual(1);
  });

  it('GET /scheduler/status proxies the scheduler status with a live open-idea count', async () => {
    const res = await fetch(`${baseUrl}/scheduler/status`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.enabled).toBe(true);
    expect(data.openIdeaCount).toBe(1); // the seeded NEW 'ONGC' fixture; xt_past is TARGET_2
  });

  it('POST /scheduler/trigger runs the requested phase', async () => {
    const res = await fetch(`${baseUrl}/scheduler/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'pre_market_brief' }),
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.result).toBe('brief text');
    expect(mockScheduler.triggerPhase).toHaveBeenCalledWith('pre_market_brief');
  });

  it('POST /scheduler/trigger rejects an unknown phase', async () => {
    const res = await fetch(`${baseUrl}/scheduler/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /scanner/status proxies the engine status', async () => {
    const res = await fetch(`${baseUrl}/scanner/status`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.published).toBe(2);
  });

  it('POST /scan triggers a scan and returns the summary', async () => {
    const res = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe: 'FNO_HEAVYWEIGHTS' }),
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.published).toBe(1);
    expect(mockEngine.scan).toHaveBeenCalledWith(expect.objectContaining({ universe: 'FNO_HEAVYWEIGHTS' }));
  });

  it('GET /symbol/:symbol returns trade history for that symbol', async () => {
    const res = await fetch(`${baseUrl}/symbol/ongc`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.count).toBe(1);
    expect(data.trades[0].symbol).toBe('ONGC');
  });

  it('GET /:id returns a single trade', async () => {
    const res = await fetch(`${baseUrl}/xt_route_test`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.symbol).toBe('ONGC');
  });

  it('GET /:id returns 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
