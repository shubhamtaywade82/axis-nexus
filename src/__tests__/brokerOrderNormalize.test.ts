import { normalizeBrokerOrder, cancelBrokerOrder, formatDhanError } from '../routes/portfolio';
import { cancelPaperOrder, mem } from '../db';

// journalOrderRows is internal — tested via listBrokerOrders integration would
// need a full router boot; cover normalize mapping here only.

describe('normalizeBrokerOrder', () => {
  it('maps DhanHQ OrderResponse fields into the paper order-book row shape', () => {
    const row = normalizeBrokerOrder({
      orderId: '712607202142',
      correlationId: 'strat_ast_test',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      tradingSymbol: 'NIFTY23200CE',
      orderType: 'MARKET',
      quantity: 65,
      price: 0,
      filledQty: 65,
      averageTradedPrice: 100,
      createTime: '2026-09-09 12:19:37',
      legName: 'NA',
      exchangeSegment: 'NSE_FNO',
    });
    expect(row.id).toBe('712607202142');
    expect(row.corr).toBe('strat_ast_test');
    expect(row.instrument).toBe('NIFTY23200CE');
    expect(row.side).toBe('BUY');
    expect(row.qty).toBe(65);
    expect(row.filled).toBe(65);
    expect(row.avg).toBe(100);
    expect(row.status).toBe('TRADED');
  });
});

describe('cancelBrokerOrder', () => {
  it('cancels order directly when orderId is valid', async () => {
    const mockCancel = jest.fn().mockResolvedValue({ orderId: '712607202142', orderStatus: 'CANCELLED' });
    const client = {
      orders: {
        cancel: mockCancel,
        getByCorrelationId: jest.fn(),
      },
    } as any;

    const res = await cancelBrokerOrder(client, '712607202142');
    expect(mockCancel).toHaveBeenCalledWith('712607202142');
    expect(res.orderStatus).toBe('CANCELLED');
  });

  it('resolves correlation ID if direct cancel fails and cancels with real order ID', async () => {
    const mockCancel = jest.fn()
      .mockRejectedValueOnce(new Error('Order not found'))
      .mockResolvedValueOnce({ orderId: '712607202142', orderStatus: 'CANCELLED' });
    const mockGetByCorr = jest.fn().mockResolvedValue({ orderId: '712607202142' });
    const client = {
      orders: {
        cancel: mockCancel,
        getByCorrelationId: mockGetByCorr,
      },
    } as any;

    const res = await cancelBrokerOrder(client, 'gc4-1784540964');
    expect(mockGetByCorr).toHaveBeenCalledWith('gc4-1784540964');
    expect(mockCancel).toHaveBeenCalledWith('712607202142');
    expect(res.orderStatus).toBe('CANCELLED');
  });

  it('clears stuck transit orders in sandbox mode when DH-906 is returned', async () => {
    const transitError = Object.assign(new Error('Dhan API request failed with status 400'), {
      status: 400,
      errorCode: 'DH-906',
      errorMessage: 'Order is in Transit state',
    });
    const client = {
      orders: {
        cancel: jest.fn().mockRejectedValue(transitError),
        getByCorrelationId: jest.fn().mockRejectedValue(new Error('Not found')),
      },
    } as any;

    const res = await cancelBrokerOrder(client, '712607202142', true);
    expect(res.orderStatus).toBe('CANCELLED');
    expect((res as any).clearedTransit).toBe(true);
  });

  it('throws transit error in live mode (does not fake cancel in live)', async () => {
    const transitError = Object.assign(new Error('Dhan API request failed with status 400'), {
      status: 400,
      errorCode: 'DH-906',
      errorMessage: 'Order is in Transit state',
    });
    const client = {
      orders: {
        cancel: jest.fn().mockRejectedValue(transitError),
        getByCorrelationId: jest.fn().mockRejectedValue(new Error('Not found')),
      },
    } as any;

    await expect(cancelBrokerOrder(client, '712607202142', false)).rejects.toThrow('Dhan API request failed with status 400');
  });
});

describe('formatDhanError', () => {
  it('formats Dhan error with code and message', () => {
    const err = Object.assign(new Error('Dhan API request failed with status 400'), {
      errorCode: 'DH-906',
      errorMessage: 'Order is in Transit state',
    });
    expect(formatDhanError(err)).toBe('DH-906: Order is in Transit state (Dhan API request failed with status 400)');
  });
});

describe('cancelPaperOrder', () => {
  it('marks pending paper orders as CANCELLED', async () => {
    mem.orders.push({ id: 'test_p1', status: 'PENDING', symbol: 'TCS' });
    const cancelled = await cancelPaperOrder('test_p1');
    expect(cancelled).toBe(true);
    const order = mem.orders.find((o: any) => o.id === 'test_p1');
    expect(order?.status).toBe('CANCELLED');
  });

  it('returns false when order not found or not pending', async () => {
    mem.orders.push({ id: 'test_traded', status: 'TRADED', symbol: 'TCS' });
    const cancelled = await cancelPaperOrder('test_traded');
    expect(cancelled).toBe(false);
  });
});
