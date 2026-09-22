import { confirmIntradayTrend } from '../services/expertTrades/intradayConfirmation';
import type { InstrumentRef } from '../services/research/types';

/** Columnar 60-minute series, steadily trending at `pctPerBar` per bar. */
function series(n: number, start: number, pctPerBar: number) {
  const timestamp: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + pctPerBar / 100;
    timestamp.push(1_700_000_000 + i * 3600);
    open.push(price); high.push(price * 1.01); low.push(price * 0.99); close.push(price); volume.push(10000);
  }
  return { timestamp, open, high, low, close, volume };
}

function fakeClient(payload: ReturnType<typeof series> | (() => Promise<any>)): any {
  return { charts: { intraday: typeof payload === 'function' ? jest.fn(payload) : jest.fn().mockResolvedValue(payload) } };
}

const REF: InstrumentRef = { symbol: 'ONGC', securityId: '2475', exchangeSegment: 'NSE_EQ' };

describe('Intraday confirmation — 60-minute structural check', () => {
  it('confirms alignment on a steady 60m uptrend', async () => {
    const client = fakeClient(series(40, 200, 0.3));
    const res = await confirmIntradayTrend(client, REF);
    expect(res.aligned).toBe(true);
    expect(res.direction).toBe(1);
  });

  it('flags contradiction on a steady 60m downtrend', async () => {
    const client = fakeClient(series(40, 200, -0.3));
    const res = await confirmIntradayTrend(client, REF);
    expect(res.aligned).toBe(false);
    expect(res.direction).toBe(-1);
    expect(res.reason).toMatch(/bearish/i);
  });

  it('treats too little intraday history as aligned, not as a rejection', async () => {
    const client = fakeClient(series(5, 200, 0.3));
    const res = await confirmIntradayTrend(client, REF);
    expect(res.aligned).toBe(true);
    expect(res.direction).toBeNull();
    expect(res.reason).toMatch(/insufficient/i);
  });

  it('fails open (aligned: true) when the intraday endpoint errors, never blocking the daily setup', async () => {
    const client = fakeClient(() => Promise.reject(new Error('rate limited')));
    const res = await confirmIntradayTrend(client, REF);
    expect(res.aligned).toBe(true);
    expect(res.direction).toBeNull();
    expect(res.reason).toMatch(/unavailable/i);
  });

  it('requests 60-minute EQUITY bars for the given instrument', async () => {
    const client = fakeClient(series(40, 200, 0.3));
    await confirmIntradayTrend(client, REF);
    expect(client.charts.intraday).toHaveBeenCalledWith(
      expect.objectContaining({ securityId: '2475', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY', interval: '60' }),
    );
  });
});
