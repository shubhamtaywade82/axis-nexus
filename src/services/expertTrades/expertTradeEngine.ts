import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { MarketDataService } from '../marketData';
import { eventBus } from '../eventBus';
import { moduleLogger } from '../../lib/logger';
import { MarketDataProvider } from '../research/dataProviders';
import { resolveUniverse, NSE_ALL_EQUITIES_ID, type ExchangePreference } from '../research/universe';
import { computePerformance } from '../research/performance';
import type { Candle, InstrumentRef, PerformanceMetrics } from '../research/types';
import { computeFeatures } from './features';
import { detectSetups } from './setupEngine';
import { buildLevels, computeMetrics, resolveHorizon, MIN_RR1 } from './levelEngine';
import { computeMarketRegime, scoreSetup } from './scoringEngine';
import { evaluateTransition } from './lifecycle';
import { hasOpenExpertTrade, saveExpertTrade, updateExpertTrade, listExpertTrades } from './repository';
import type { ExpertTrade, ExpertTradeFeatures, ExpertTradeLevels, ExpertTradeMetrics, ExpertTradeScanSummary, ExpertTradeSetupType, MarketRegime } from './types';
import { OPEN_STATES } from './types';

const log = moduleLogger('expert_trade_engine');

const HISTORY_DAYS = 400;
/** ₹5cr/day, same floor the equity screener already enforces (screener.ts)
 * — a position that cannot be entered or exited without moving the price
 * has no business being turned into an executable setup. */
const MIN_AVG_TRADED_VALUE = 5_00_00_000;
/** A full-NSE scan issues one historical-candle fetch per symbol. Left
 * unbounded, NSE_ALL_EQUITIES is 2000+ symbols and several minutes of
 * throttled calls — real, but not something to default an interactive
 * "Scan Now" button to. Bounded here; a scheduled off-hours job can raise
 * this once the market-data caching layer described in the architecture
 * brief (section 21) exists to make it cheap. */
const DEFAULT_MAX_UNIVERSE = 150;
const DEFAULT_MAX_PUBLISHED = 15;
/** A NEW idea whose entry never triggers within this window is stale. */
const ENTRY_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

export interface ExpertTradeScanOptions {
  universe?: string;
  exchange?: ExchangePreference;
  maxUniverse?: number;
  maxPublished?: number;
}

/**
 * Orchestrates the full Trade Idea pipeline: universe -> liquidity filter
 * -> features -> setup detection -> entry/stop/target -> R:R validation ->
 * scoring -> publish. Read-only with respect to the broker — it never
 * places an order; it only produces `ExpertTrade` records for the REST API
 * / frontend to display and for a human (or a future execution bridge,
 * deliberately out of scope here) to act on.
 */
export class ExpertTradeEngine {
  private readonly provider: MarketDataProvider;
  private lastScanSummary: ExpertTradeScanSummary | null = null;
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(private readonly client: DhanClient, private readonly market: MarketDataService) {
    this.provider = new MarketDataProvider(client, market);
  }

  getStatus(): ExpertTradeScanSummary | null {
    return this.lastScanSummary;
  }

  /** Starts the periodic lifecycle re-evaluation loop (NOT the scan — that
   * stays manual/on-demand via `scan()`, matching researchScheduler's
   * separation of "find new ideas" from "check on ones we already have"). */
  start(intervalMs = 60_000): void {
    if (this.lifecycleTimer) return;
    this.lifecycleTimer = setInterval(() => {
      this.evaluateLifecycle().catch((e) => log.warn({ err: e.message }, 'Lifecycle evaluation cycle failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
    this.lifecycleTimer = null;
  }

  async scan(options: ExpertTradeScanOptions = {}): Promise<ExpertTradeScanSummary> {
    if (this.scanning) {
      throw new Error('A scan is already in progress');
    }
    this.scanning = true;
    const startedAt = Date.now();
    try {
      const universe = options.universe || NSE_ALL_EQUITIES_ID;
      const exchange = options.exchange || 'NSE';
      const maxUniverse = Math.min(options.maxUniverse ?? DEFAULT_MAX_UNIVERSE, 500);
      const maxPublished = options.maxPublished ?? DEFAULT_MAX_PUBLISHED;

      const benchmark = await this.provider.getBenchmarkCandles(HISTORY_DAYS);
      if (benchmark.length < 60) {
        throw new Error(`Benchmark (NIFTY) history unavailable — got ${benchmark.length} candles. Refusing to scan.`);
      }
      const benchmarkPerf = computePerformance(benchmark);
      if (!benchmarkPerf) throw new Error('Failed to compute benchmark performance metrics');
      const regime = computeMarketRegime(benchmarkPerf);

      const resolved = await resolveUniverse(this.client, universe, exchange);
      const instruments = resolved.slice(0, maxUniverse);
      if (resolved.length > maxUniverse) {
        log.warn(
          { universe, resolved: resolved.length, cap: maxUniverse },
          'Universe truncated for this scan — raise maxUniverse or scan in batches for full coverage',
        );
      }

      let candidatesConsidered = 0;
      let skippedExisting = 0;
      let skippedIlliquid = 0;
      let skippedFetchFailed = 0;
      const detected: ExpertTrade[] = [];

      for (const inst of instruments) {
        if (await hasOpenExpertTrade(inst.symbol)) {
          skippedExisting++;
          continue;
        }

        let candles: Candle[];
        try {
          candles = await this.provider.getHistoricalCandles(inst, HISTORY_DAYS);
        } catch {
          skippedFetchFailed++;
          continue;
        }

        const perf = computePerformance(candles, benchmark);
        if (!perf) continue;
        if (perf.avgTradedValue < MIN_AVG_TRADED_VALUE) {
          skippedIlliquid++;
          continue;
        }

        const features = computeFeatures(candles, perf);
        if (!features) continue;
        candidatesConsidered++;

        const trade = this.buildBestTrade(inst, candles, features, perf, regime, startedAt);
        if (trade) detected.push(trade);
      }

      detected.sort((a, b) => b.setup.score - a.setup.score);
      const published = detected.slice(0, maxPublished);
      for (const trade of published) {
        await saveExpertTrade(trade);
        eventBus.emit('expert_trade', { type: 'expert_trade.created', trade });
      }

      const summary: ExpertTradeScanSummary = {
        scannedAt: startedAt,
        universe,
        exchange,
        regime,
        totalResolved: resolved.length,
        totalScreened: instruments.length,
        candidatesConsidered,
        setupsDetected: detected.length,
        published: published.length,
        skippedExisting,
        skippedIlliquid,
        skippedFetchFailed,
        durationMs: Date.now() - startedAt,
      };
      this.lastScanSummary = summary;
      eventBus.log('SYSTEM', `Expert Trade scan complete: ${summary.published} published from ${summary.candidatesConsidered} candidates (${summary.durationMs}ms)`, 'expert_trade_engine');
      return summary;
    } finally {
      this.scanning = false;
    }
  }

  /** Runs setup detection + level construction + scoring for one
   * instrument, returning the single best-scoring valid setup (a symbol
   * only ever gets one open idea at a time). */
  private buildBestTrade(
    inst: InstrumentRef,
    candles: Candle[],
    features: ExpertTradeFeatures,
    perf: PerformanceMetrics,
    regime: MarketRegime,
    now: number,
  ): ExpertTrade | null {
    const setups = detectSetups(candles, features, perf);
    let best: { setupType: ExpertTradeSetupType; levels: ExpertTradeLevels; metrics: ExpertTradeMetrics; score: number; conviction: number } | null = null;

    for (const { type, strength } of setups) {
      const levels = buildLevels(type, features);
      if (!levels) continue;
      const horizon = resolveHorizon(type);
      const metrics = computeMetrics(levels, horizon);
      if (metrics.rr1 < MIN_RR1) continue;
      const { score, conviction } = scoreSetup(type, strength, features, metrics, regime);
      if (!best || score > best.score) {
        best = { setupType: type, levels, metrics, score, conviction };
      }
    }
    if (!best) return null;

    const horizon = resolveHorizon(best.setupType);
    const { thesis, invalidation } = describeSetup(best.setupType, inst.symbol, features, best.levels);

    return {
      id: `xt_${now}_${inst.symbol.toLowerCase()}`,
      symbol: inst.symbol,
      name: inst.name || inst.symbol,
      sector: inst.sector || 'Unclassified',
      securityId: inst.securityId,
      exchangeSegment: inst.exchangeSegment,
      exchange: inst.exchangeSegment === 'BSE_EQ' ? 'BSE' : 'NSE',
      direction: 'LONG',
      horizon,
      setup: { type: best.setupType, score: best.score, conviction: best.conviction },
      market: { regime },
      levels: best.levels,
      metrics: best.metrics,
      thesis,
      invalidation,
      state: 'NEW',
      createdAt: now,
      expiresAt: now + ENTRY_VALIDITY_MS,
      lastEvaluatedAt: now,
      lastEvaluatedPrice: features.price,
    };
  }

  /** Re-evaluates every open (NEW/ACTIVE/TARGET_1) trade against the
   * latest tradable price — cheap: one cached LTP lookup per open trade,
   * no candle fetch, no re-running setup detection. */
  async evaluateLifecycle(): Promise<void> {
    const open = await listExpertTrades({ state: OPEN_STATES, limit: 200 });
    for (const trade of open) {
      const cmp = this.market.getLtp(trade.securityId) ?? this.market.getFillablePrice(trade.securityId, { allowClosed: true });
      if (!cmp || !(cmp > 0)) continue;

      const prevState = trade.state;
      const updated = evaluateTransition(trade, cmp, Date.now());
      await updateExpertTrade(updated);
      if (updated.state !== prevState) {
        eventBus.emit('expert_trade', { type: `expert_trade.${updated.state.toLowerCase()}`, trade: updated });
        eventBus.log('SYSTEM', `Expert Trade ${updated.symbol} (${updated.setup.type}) ${prevState} -> ${updated.state} @ ${cmp}`, 'expert_trade_engine');
      }
    }
  }
}

function describeSetup(
  setupType: ExpertTradeSetupType,
  symbol: string,
  f: ExpertTradeFeatures,
  levels: ExpertTradeLevels,
): { thesis: string[]; invalidation: string[] } {
  const fmt = (n: number) => n.toFixed(2);
  const thesis: string[] = [];

  if (setupType === 'BREAKOUT') {
    thesis.push(`Closed above the 20-day resistance of ₹${fmt(f.structure.resistance20d)} on ${(f.volume.relativeVolume ?? 1).toFixed(1)}x average volume`);
    thesis.push(`Trading above the 50-day average — the breakout has trend support behind it`);
  } else if (setupType === 'BREAKOUT_RETEST') {
    thesis.push(`Pulled back to retest the ₹${fmt(f.structure.resistance20d)} breakout level while holding above it`);
    thesis.push(`RSI(14) at ${fmt(f.momentum.rsi14 ?? 0)} shows momentum intact through the pullback`);
  } else if (setupType === 'TREND_PULLBACK') {
    thesis.push(`Primary uptrend intact — above a rising 200-day average, ADX(14) at ${fmt(f.momentum.adx14 ?? 0)} confirms trend strength`);
    thesis.push(`RSI(14) at ${fmt(f.momentum.rsi14 ?? 0)} shows a cooled-off pullback rather than a broken trend`);
  } else if (setupType === 'BASE_EXPANSION') {
    thesis.push(`20-day range compressed into a base, now expanding on ${(f.volume.relativeVolume ?? 1).toFixed(1)}x average volume`);
    thesis.push(`Pressing the top of the base at ₹${fmt(f.structure.resistance20d)} with volume confirmation`);
  } else {
    thesis.push(`Outperforming NIFTY by ${fmt(f.relativeStrength.vs60d ?? 0)}% over 60 days with ADX(14) at ${fmt(f.momentum.adx14 ?? 0)}`);
    thesis.push(`No resistance within 3% overhead — room for the trend to continue`);
  }
  thesis.push(`Risk ₹${fmt(levels.entry - levels.stopLoss)}/share for a potential ₹${fmt(levels.target2 - levels.entry)}/share to target 2`);

  const invalidation = [
    `Daily close below ₹${fmt(levels.invalidationLevel)} before entry negates the setup`,
    `Stop-loss at ₹${fmt(levels.stopLoss)} once triggered`,
  ];

  return { thesis, invalidation };
}
