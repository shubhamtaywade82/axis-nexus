import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { LiveExecutionEngine } from '../engines/live';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import type { NormalizedPosition, PortfolioSource } from '../services/portfolioSource';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function stubTracker(fill: { status: string; filledQuantity: number; averagePrice: number }) {
  return { waitFor: jest.fn(async () => fill) } as any;
}

function stubPortfolio(): PortfolioSource {
  return {
    kind: 'broker',
    getPositions: jest.fn(async () => [] as NormalizedPosition[]),
    getWallet: jest.fn(async () => ({
      availableMargin: 0, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0,
      unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 0, equity: 0,
    })),
    getTodayOrderStats: jest.fn(async () => ({ total: 0, filled: 0, rejected: 0, consecutiveLosses: 0 })),
    recordOrderOutcome: jest.fn(),
    markToMarket: jest.fn(async () => ({ totalUnrealized: 0, staleCount: 0 })),
    closePosition: jest.fn(async () => ({ status: 'noop' as const })),
    closeAll: jest.fn(async () => []),
    isOpenOnBroker: jest.fn(() => true),
    invalidate: jest.fn(),
  };
}

describe('LiveExecutionEngine.placeOrder', () => {
  function setup(fill: { status: string; filledQuantity: number; averagePrice: number }) {
    const client = stubClient();
    jest.spyOn(client.orders, 'place').mockResolvedValue({ correlationId: 'c1', data: { orderId: 'ord1' } } as any);
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: true });
    const tracker = stubTracker(fill);
    const portfolio = stubPortfolio();
    const live = new LiveExecutionEngine(client, tracker, market.monitor, market, risk, portfolio);
    return { live, market, portfolio };
  }

  afterEach(() => jest.restoreAllMocks());

  it('invalidates the portfolio cache after every settled order — the position book just changed', async () => {
    const { live, portfolio } = setup({ status: 'TRADED', filledQuantity: 50, averagePrice: 100 });
    await live.placeOrder({
      correlation_id: 'corr1', intent_id: 'i1',
      params: { security_id: '11111', quantity: 50, transaction_type: 'BUY' },
    });
    expect(portfolio.invalidate).toHaveBeenCalledTimes(1);
  });

  it('should not report a fill or arm stop-loss monitoring when the broker rejects', async () => {
    const { live, market, portfolio } = setup({ status: 'REJECTED', filledQuantity: 0, averagePrice: 0 });
    const trackSpy = jest.spyOn(market.monitor, 'track');
    const res = await live.placeOrder({
      correlation_id: 'corr_rej', intent_id: 'ir',
      params: { security_id: '11111', quantity: 50, transaction_type: 'BUY' },
      risk_limits: { stop_loss: 90 },
    });
    expect(res.status).toBe('REJECTED');
    expect(trackSpy).not.toHaveBeenCalled();
    expect(portfolio.recordOrderOutcome).toHaveBeenCalledWith({ status: 'REJECTED' });
  });

  it('tracks a BUY (long) fill with a positive signed quantity', async () => {
    const { live, market } = setup({ status: 'TRADED', filledQuantity: 50, averagePrice: 100 });
    await live.placeOrder({
      correlation_id: 'corr2', intent_id: 'i2',
      params: { security_id: '22222', quantity: 50, transaction_type: 'BUY' },
      risk_limits: { stop_loss: 80 },
    });
    const tracked = market.monitor.tracked().find((t) => t.securityId === '22222');
    expect(tracked?.quantity).toBe(50);
  });

  it('tracks a SELL (short) fill with a NEGATIVE signed quantity — the confirmed bug', async () => {
    // Regression test: this used to pass a raw, always-positive
    // filledQuantity regardless of side. PositionMonitor's quantity is
    // positive for a long, negative for a short — an unsigned short was
    // tracked backwards: its stop-loss fired on a price FALL (a profit for
    // a short) and its target on a RISE (the loss).
    const { live, market } = setup({ status: 'TRADED', filledQuantity: 50, averagePrice: 100 });
    await live.placeOrder({
      correlation_id: 'corr3', intent_id: 'i3',
      params: { security_id: '33333', quantity: 50, transaction_type: 'SELL' },
      risk_limits: { stop_loss: 120 },
    });
    const tracked = market.monitor.tracked().find((t) => t.securityId === '33333');
    expect(tracked?.quantity).toBe(-50);
  });
});
