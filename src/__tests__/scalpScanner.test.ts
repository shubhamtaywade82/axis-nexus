import { ScalpScanner } from '../services/scalpScanner';
import { ScalpPositionManager } from '../services/scalpPositionManager';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { setSystemState } from '../services/systemState';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function stubMarket(ltp = 100): MarketDataService {
  const svc = new MarketDataService(stubClient());
  (svc as any).lastTickAt = Date.now();
  (svc as any).quotes.set('44000', {
    securityId: '44000', symbol: undefined, ltp,
    change: 0, pctChange: 0, high: 101, low: 99, open: 100, prevClose: 100,
    volume: 0, oi: 0, updatedAt: Date.now(),
    bid: ltp - 0.5, ask: ltp + 0.5, bidQty: 1000, askQty: 1000,
  });
  return svc;
}

describe('ScalpScanner', () => {
  beforeAll(() => {
    setSystemState('READY');
  });

  it('constructs without error', () => {
    const client = stubClient();
    const market = stubMarket();
    const risk = new RiskEngine(client, market);
    const scalpManager = new ScalpPositionManager(market, { kind: 'paper' } as any);
    const engine = { placeOrder: jest.fn() } as any;
    const scanner = new ScalpScanner(client, market, engine, risk, scalpManager);
    expect(scanner).toBeDefined();
  });

  it('does not scan when market is closed', async () => {
    const client = stubClient();
    const market = stubMarket();
    const risk = new RiskEngine(client, market);
    const scalpManager = new ScalpPositionManager(market, { kind: 'paper' } as any);
    scalpManager.start();
    const engine = { placeOrder: jest.fn() } as any;
    const scanner = new ScalpScanner(client, market, engine, risk, scalpManager);
    // Market closed
    await scanner.evaluate({ isMarketOpen: false, squareOffWindow: false });
    expect(engine.placeOrder).not.toHaveBeenCalled();
  });

  it('does not scan during square-off window', async () => {
    const client = stubClient();
    const market = stubMarket();
    const risk = new RiskEngine(client, market);
    const scalpManager = new ScalpPositionManager(market, { kind: 'paper' } as any);
    scalpManager.start();
    const engine = { placeOrder: jest.fn() } as any;
    const scanner = new ScalpScanner(client, market, engine, risk, scalpManager);
    await scanner.evaluate({ isMarketOpen: true, squareOffWindow: true });
    expect(engine.placeOrder).not.toHaveBeenCalled();
  });

  it('exposes a probe method returning scan state', async () => {
    const client = stubClient();
    const market = stubMarket();
    const risk = new RiskEngine(client, market);
    const scalpManager = new ScalpPositionManager(market, { kind: 'paper' } as any);
    const engine = { placeOrder: jest.fn() } as any;
    const scanner = new ScalpScanner(client, market, engine, risk, scalpManager);
    const probe = await scanner.probe();
    expect(probe).toHaveProperty('lastScanAt');
    expect(probe).toHaveProperty('openScalps');
    expect(probe).toHaveProperty('nextScanInSec');
    expect(Array.isArray(probe.openScalps)).toBe(true);
  });
});
