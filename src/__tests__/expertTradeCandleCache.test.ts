import { CachedMarketDataProvider, clearCandleCacheForTests, type EquityMarketDataProvider } from '../services/expertTrades/candleCache';
import type { Candle, InstrumentRef } from '../services/research/types';

function series(n: number, start = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ close: start + i, high: start + i + 1, low: start + i - 1, volume: 1000 }));
}

function fakeInner(overrides: Partial<EquityMarketDataProvider> = {}): EquityMarketDataProvider {
  return {
    client: {} as any,
    getQuote: jest.fn().mockResolvedValue({ ltp: 100, volume: 0, prevClose: 100 }),
    getHistoricalCandles: jest.fn().mockResolvedValue(series(400)),
    getBenchmarkCandles: jest.fn().mockResolvedValue(series(400)),
    ...overrides,
  };
}

const REF: InstrumentRef = { symbol: 'TCS', securityId: '11536', exchangeSegment: 'NSE_EQ' };

describe('CachedMarketDataProvider — same-day candle cache', () => {
  beforeEach(async () => {
    await clearCandleCacheForTests();
  });

  it('serves a second same-day request from cache without calling the inner provider again', async () => {
    const inner = fakeInner();
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    const first = await provider.getHistoricalCandles(REF, 400);
    const second = await provider.getHistoricalCandles(REF, 400);

    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('refetches once the injected "today" rolls over to a new date', async () => {
    const inner = fakeInner();
    let today = '2026-09-22';
    const provider = new CachedMarketDataProvider(inner, () => today);

    await provider.getHistoricalCandles(REF, 400);
    today = '2026-09-23';
    await provider.getHistoricalCandles(REF, 400);

    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it('serves a smaller days request from a cache entry fetched with more days, by slicing the tail', async () => {
    const inner = fakeInner({ getHistoricalCandles: jest.fn().mockResolvedValue(series(400)) });
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    await provider.getHistoricalCandles(REF, 400);
    const shorter = await provider.getHistoricalCandles(REF, 60);

    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(1); // no second fetch
    expect(shorter).toHaveLength(60);
    expect(shorter[shorter.length - 1].close).toBe(499); // the same tail as the full series
  });

  it('refetches when a request needs MORE days than what is cached', async () => {
    const inner = fakeInner();
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    await provider.getHistoricalCandles(REF, 60);
    await provider.getHistoricalCandles(REF, 400);

    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it('caches the NIFTY benchmark separately from equity symbols', async () => {
    const inner = fakeInner();
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    await provider.getBenchmarkCandles(400);
    await provider.getHistoricalCandles(REF, 400);
    await provider.getBenchmarkCandles(400);

    expect(inner.getBenchmarkCandles).toHaveBeenCalledTimes(1);
    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(1);
  });

  it('never caches getQuote — every call passes straight through', async () => {
    const inner = fakeInner();
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    await provider.getQuote(REF);
    await provider.getQuote(REF);

    expect(inner.getQuote).toHaveBeenCalledTimes(2);
  });

  it('propagates a fetch failure uncached, so the next call retries rather than reusing a stale entry', async () => {
    let calls = 0;
    const inner = fakeInner({
      getHistoricalCandles: jest.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error('network blip');
        return series(400);
      }),
    });
    const provider = new CachedMarketDataProvider(inner, () => '2026-09-22');

    await expect(provider.getHistoricalCandles(REF, 400)).rejects.toThrow('network blip');
    const result = await provider.getHistoricalCandles(REF, 400);
    expect(result).toHaveLength(400);
    expect(inner.getHistoricalCandles).toHaveBeenCalledTimes(2);
  });
});
