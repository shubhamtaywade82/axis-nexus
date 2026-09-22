import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { pool, dbMode } from '../../db';
import { moduleLogger } from '../../lib/logger';
import { istParts } from '../marketHours';
import type { InstrumentRef, Candle } from '../research/types';

const log = moduleLogger('expert_trade_candle_cache');

/**
 * The subset of `MarketDataProvider` (services/research/dataProviders.ts)
 * the Expert Trade Engine actually calls. `MarketDataProvider` already
 * satisfies this structurally — this interface exists so `scan()` can take
 * either the real provider or `CachedMarketDataProvider` without either one
 * knowing about the other.
 */
export interface EquityMarketDataProvider {
  readonly client: DhanClient;
  getQuote(ref: InstrumentRef): Promise<{ ltp: number; volume: number; prevClose: number }>;
  getBenchmarkCandles(days?: number): Promise<Candle[]>;
  getHistoricalCandles(ref: InstrumentRef, days?: number): Promise<Candle[]>;
}

interface CacheEntry {
  candles: Candle[];
  days: number;
  cachedDate: string; // IST calendar date the entry was fetched on, e.g. "2026-09-22"
  cachedAt: number;
}

const memCache = new Map<string, CacheEntry>();

export async function initCandleCache(): Promise<void> {
  if (dbMode() !== 'postgres') return;
  const sql = `
    CREATE TABLE IF NOT EXISTS expert_trade_candle_cache (
      cache_key VARCHAR(64) PRIMARY KEY,
      candles JSONB NOT NULL,
      days INTEGER NOT NULL,
      cached_date VARCHAR(10) NOT NULL,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  try {
    await pool.query(sql);
    log.info('Expert trade candle cache table initialized successfully');
  } catch (e: any) {
    log.warn({ err: e.message }, 'Failed to initialize expert_trade_candle_cache in Postgres');
  }
}

async function readEntry(key: string): Promise<CacheEntry | null> {
  if (dbMode() === 'postgres') {
    try {
      const res = await pool.query('SELECT candles, days, cached_date FROM expert_trade_candle_cache WHERE cache_key = $1', [key]);
      if (res.rows.length) {
        const row = res.rows[0];
        return { candles: typeof row.candles === 'string' ? JSON.parse(row.candles) : row.candles, days: row.days, cachedDate: row.cached_date, cachedAt: 0 };
      }
    } catch (e: any) {
      log.warn({ key, err: e.message }, 'Candle cache read failed, falling back to memory');
    }
  }
  return memCache.get(key) ?? null;
}

async function writeEntry(key: string, entry: CacheEntry): Promise<void> {
  memCache.set(key, entry);
  if (dbMode() !== 'postgres') return;
  const q = `
    INSERT INTO expert_trade_candle_cache (cache_key, candles, days, cached_date, cached_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (cache_key) DO UPDATE SET candles = EXCLUDED.candles, days = EXCLUDED.days, cached_date = EXCLUDED.cached_date, cached_at = NOW();
  `;
  try {
    await pool.query(q, [key, JSON.stringify(entry.candles), entry.days, entry.cachedDate]);
  } catch (e: any) {
    log.warn({ key, err: e.message }, 'Candle cache write failed');
  }
}

export async function clearCandleCacheForTests(): Promise<void> {
  memCache.clear();
  if (dbMode() === 'postgres') {
    await pool.query('DELETE FROM expert_trade_candle_cache').catch(() => {});
  }
}

/**
 * Wraps a `MarketDataProvider` with a same-day cache for daily OHLCV.
 *
 * A daily candle series only gains a new bar once per trading day (after
 * close), so "fetched today" is a correct, simple invalidation rule — no
 * TTL guessing. This turns a repeated scan (interactive "Scan Now" after
 * the scheduled post-market scan already ran, or the same symbol appearing
 * across two universes in one session) from N historical-endpoint round
 * trips into N cache reads, without touching DhanHQ at all.
 *
 * Quotes are never cached here — `getQuote` passes straight through, since
 * an LTP is stale the instant it's read and caching it would be actively
 * wrong, not just wasteful.
 */
export class CachedMarketDataProvider implements EquityMarketDataProvider {
  constructor(
    private readonly inner: EquityMarketDataProvider,
    /** Injectable so tests can simulate a day rollover without faking the
     * system clock — mirrors marketHours.ts's own `now` override pattern. */
    private readonly today: () => string = () => istParts().dateStr,
  ) {}

  get client(): DhanClient { return this.inner.client; }

  getQuote(ref: InstrumentRef) {
    return this.inner.getQuote(ref);
  }

  async getBenchmarkCandles(days = 400): Promise<Candle[]> {
    return this.cached('NIFTY|IDX_I', days, () => this.inner.getBenchmarkCandles(days));
  }

  async getHistoricalCandles(ref: InstrumentRef, days = 200): Promise<Candle[]> {
    return this.cached(`${ref.symbol}|${ref.exchangeSegment}`, days, () => this.inner.getHistoricalCandles(ref, days));
  }

  private async cached(key: string, days: number, fetcher: () => Promise<Candle[]>): Promise<Candle[]> {
    const today = this.today();
    const entry = await readEntry(key);
    if (entry && entry.cachedDate === today && entry.days >= days) {
      return entry.candles.slice(-days);
    }
    // Fetch errors propagate uncached and unmodified — a dropped request
    // must read as a dropped request to the caller (screener.ts's own
    // fetch-failure handling depends on this), never silently answered from
    // a stale cache entry.
    const candles = await fetcher();
    await writeEntry(key, { candles, days, cachedDate: today, cachedAt: Date.now() });
    return candles;
  }
}
