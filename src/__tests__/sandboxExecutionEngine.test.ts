import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { SandboxExecutionEngine } from '../engines/sandbox';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import * as sandboxInstruments from '../services/sandboxInstruments';
import { noteDhanRateLimit, resetDhanRateLimitForTests } from '../lib/dhanRateLimit';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test', baseURL: 'https://sandbox.dhan.co/v2' });
}

describe('SandboxExecutionEngine.placeOrder', () => {
  function setup(settled: { orderStatus: string; averagePrice?: number; filledQty?: number }) {
    const client = stubClient();
    jest.spyOn(client.orders, 'place').mockResolvedValue({ correlationId: 'c1', data: { orderId: 'sbx1' } } as any);
    jest.spyOn(client.orders, 'getById').mockResolvedValue(settled as any);
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: true });
    const sandbox = new SandboxExecutionEngine(client, market, risk);
    return { sandbox, client, risk, market };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    resetDhanRateLimitForTests();
  });

  it('places the order against the sandbox client and reports the settled status', async () => {
    const { sandbox, client } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 50 });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '11111', quantity: 50, exchangeSegment: 'NSE_FNO', tickSize: 0.05,
    });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr1', intent_id: 'i1',
      params: {
        security_id: '11111', quantity: 50, transaction_type: 'BUY', price: 99.5,
        exchange_segment: 'NSE_FNO',
      },
    });
    expect(res.status).toBe('TRADED');
    expect(res.fill_price).toBe(100);
    expect(res.order_id).toBe('sbx1');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({
      orderType: 'LIMIT', price: 99.5, validity: 'DAY',
      disclosedQuantity: 0, triggerPrice: 0, afterMarketOrder: false,
    }));
  });

  it('uses lot size and tick size from the scrip master, not the caller-supplied values', async () => {
    const { sandbox, client } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 65 });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '46026', quantity: 65, exchangeSegment: 'NSE_FNO', tickSize: 5,
    });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr3', intent_id: 'i3',
      params: {
        security_id: '46026', quantity: 10, transaction_type: 'BUY', price: 123,
        exchange_segment: 'NSE_FNO',
      },
    });
    expect(res.status).toBe('TRADED');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({
      securityId: '46026', quantity: 65, orderType: 'LIMIT', price: 125,
    }));
  });

  it('rejects without calling the broker when the risk gate blocks', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: false, reason: 'kill switch armed' });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr2', intent_id: 'i2',
      params: {
        security_id: '22222', quantity: 10, transaction_type: 'BUY', price: 50,
        exchange_segment: 'NSE_FNO',
      },
    });
    expect(res.status).toBe('REJECTED');
    expect(client.orders.place).not.toHaveBeenCalled();
  });

  it('does not record order rejection stats when Dhan returns 429', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '11111', quantity: 50, exchangeSegment: 'NSE_FNO', tickSize: 0.05,
    });
    jest.spyOn(client.orders, 'place').mockRejectedValue(new Error('Dhan API rate limit exceeded (status 429) (DH-904 | Rate_Limit)'));
    const recordSpy = jest.spyOn(risk.getPortfolio(), 'recordOrderOutcome');

    const res = await sandbox.placeOrder({
      correlation_id: 'corr429', intent_id: 'i429',
      params: {
        security_id: '11111', quantity: 50, transaction_type: 'BUY', price: 99.5,
        exchange_segment: 'NSE_FNO',
      },
    });

    expect(res.status).toBe('REJECTED');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('skips broker calls while global Dhan rate-limit gate is active', async () => {
    noteDhanRateLimit({ retryAfterMs: 60_000 });
    const { sandbox, client } = setup({ orderStatus: 'TRADED' });
    const resolveSpy = jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg');

    const res = await sandbox.placeOrder({
      correlation_id: 'corr_gate', intent_id: 'i_gate',
      params: {
        security_id: '11111', quantity: 50, transaction_type: 'BUY', price: 99.5,
        exchange_segment: 'NSE_FNO',
      },
    });

    expect(res.status).toBe('REJECTED');
    expect(String(res.reason)).toContain('rate limit');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(client.orders.place).not.toHaveBeenCalled();
  });

  it('tracks filled position in PositionMonitor and invalidates portfolio when risk_limits provided', async () => {
    const { sandbox, market, risk } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 50 });
    const trackSpy = jest.spyOn(market.monitor, 'track');
    const invalidateSpy = jest.spyOn(risk.getPortfolio(), 'invalidate');
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '11111', quantity: 50, exchangeSegment: 'NSE_FNO', tickSize: 0.05,
    });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr-sl', intent_id: 'i-sl',
      params: {
        security_id: '11111', quantity: 50, transaction_type: 'BUY', price: 100,
        exchange_segment: 'NSE_FNO',
      },
      risk_limits: { stop_loss: 80, target: 140, trailing_stop: { distance: 10 } },
    });
    expect(res.status).toBe('TRADED');
    expect(trackSpy).toHaveBeenCalledWith(expect.objectContaining({
      securityId: '11111', quantity: 50, stopLoss: 80, target: 140,
    }));
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('falls back to local sandbox paper execution when Dhan returns DH-905 mock OMS limitation', async () => {
    const { sandbox, client } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '56995', quantity: 65, exchangeSegment: 'NSE_FNO', tickSize: 0.05,
    });
    const dh905Err = new Error('Dhan API request failed with status 400 (DH-905)');
    (dh905Err as any).errorCode = 'DH-905';
    jest.spyOn(client.orders, 'place').mockRejectedValue(dh905Err);

    const res = await sandbox.placeOrder({
      correlation_id: 'corr-dh905', intent_id: 'i-dh905',
      params: {
        security_id: '56995', quantity: 65, transaction_type: 'BUY', price: 90,
        exchange_segment: 'NSE_FNO',
      },
    });

    expect(res.status).toBe('TRADED');
    expect(res.is_paper).toBe(true);
    expect(res.fill_price).toBe(90);
  });
});

describe('SandboxExecutionEngine.closeLeg', () => {
  function setup(settled: { orderStatus: string }) {
    const client = stubClient();
    jest.spyOn(client.orders, 'place').mockResolvedValue({ correlationId: 'c1', data: { orderId: 'sbx-close' } } as any);
    jest.spyOn(client.orders, 'getById').mockResolvedValue(settled as any);
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const sandbox = new SandboxExecutionEngine(client, market, risk);
    return { sandbox, client, risk };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    resetDhanRateLimitForTests();
  });

  it('places a reversing order and bypasses risk.canTrade() — unwinding a partial fill must work even when entries are blocked', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: false, reason: 'kill switch armed' });

    const res = await sandbox.closeLeg({ securityId: '11111', qty: 50, side: 'BUY', instrument: 'NIFTY24000CE' }, 100);

    expect(res.status).toBe('TRADED');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({ transactionType: 'SELL', quantity: 50 }));
  });

  it('invalidates the portfolio cache after closeLeg so margin/position reads refresh', async () => {
    const { sandbox, risk } = setup({ orderStatus: 'TRADED' });
    const invalidateSpy = jest.spyOn(risk.getPortfolio(), 'invalidate');
    await sandbox.closeLeg({ securityId: '11111', qty: 50, side: 'BUY', instrument: 'NIFTY24000CE' }, 100);
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
