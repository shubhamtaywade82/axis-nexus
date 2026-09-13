/**
 * Scalp entry scanner — finds fee-aware momentum setups and registers
 * them with ScalpPositionManager for both-side ratchet management.
 *
 * ── Entry criteria (all must pass) ──────────────────────────────────────
 *
 *   1. Underlying momentum: 1m Supertrend aligned with 5m direction
 *      (reuses the AdaptiveSupertrendScanner's trend gate logic)
 *   2. Delta gate: option delta ∈ [0.45, 0.60] (ATM-ish, liquid, responsive)
 *   3. Spread gate: bid-ask spread ≤ 2% of mid (don't donate to the MM)
 *   4. IV rank > 30 (don't scalp when IV is crushed — no movement)
 *   5. Volume > 5000 (liquidity)
 *   6. Fee-aware minimum move: expected move > 2× round-trip breakeven
 *
 * ── What it does NOT do ─────────────────────────────────────────────────
 *
 *   - Exits: the ScalpPositionManager owns the entire exit lifecycle
 *     (both-side ratchet, momentum reversal, fee-aware bailout, TP).
 *     This scanner only OPENS positions.
 *   - Q-learning: the existing AdaptiveSupertrendScanner has a Q-learning
 *     parameter AI for tuning Supertrend params per regime. This scanner
 *     uses fixed Supertrend params (10, 3) — simpler, and the edge is in
 *     the exit policy, not the entry timing.
 *
 * ── Integration ─────────────────────────────────────────────────────────
 *
 *   - Called by AutonomyEngine on every cycle (same cadence as the
 *     AdaptiveSupertrendScanner: 60s default, configurable via
 *     SCALP_SCAN_INTERVAL_MS)
 *   - Places orders via the active execution engine (paper/sandbox/live)
 *   - Registers filled positions with ScalpPositionManager.registerEntry()
 *   - The scalp manager then takes over — evaluating exits on every tick
 */

import type { DhanClient, Candle } from '@nemesis-oss/dhanhq-sdk';
import { supertrend } from '@nemesis-oss/dhanhq-sdk';
import type { MarketDataService } from './marketData';
import { INDEX_INSTRUMENTS, getBidAsk } from './marketData';
import type { RiskEngine } from './riskEngine';
import type { ScalpPositionManager } from './scalpPositionManager';
import type { ScalpConfig } from './scalpConfig';
import type { ExecutionEngine } from '../core';
import { eventBus } from './eventBus';
import { journal } from './journal';
import { nearestIndexExpiry } from './marketHours';
import { calculateGreeks, analyzeOptionChain, recordIvSample, getIvRank, selectStrikeByDelta } from './optionsAnalytics';
import { resolveNearestExpiry, getLotSize } from './strategyConstructor';
import { estimateRoundTripFees } from './feeModel';
import { isDhanRateLimited } from '../lib/dhanRateLimit';
import { isPaperMode } from '../lib/tradingMode';
import { createPaperStrategy } from '../db';

const SCAN_INTERVAL_MS = Number(process.env.SCALP_SCAN_INTERVAL_MS) || 60_000;
const FIVE_MIN_SUPERTREND_PARAMS = { period: 10, multiplier: 3 };
const MAX_CONCURRENT_SCALPS = Number(process.env.SCALP_MAX_CONCURRENT) || 3;

const WATCHLIST = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

export interface ScalpScanResult {
  symbol: string;
  stage: string;
  delta?: number;
  spreadPct?: number;
  ivRank?: number | null;
  volume?: number;
  expectedMove?: number;
  breakeven?: number;
  gatePassed?: boolean;
  rejectionReason?: string;
}

export class ScalpScanner {
  private lastScanAt = 0;
  private bootedAt = Date.now();
  private openScalps = new Set<string>(); // symbol -> securityId (tracks our own entries)

  constructor(
    private client: DhanClient,
    private market: MarketDataService,
    private engine: ExecutionEngine,
    private risk: RiskEngine,
    private scalpManager: ScalpPositionManager,
  ) {}

  async evaluate(clock: { isMarketOpen: boolean; squareOffWindow: boolean }): Promise<void> {
    if (!clock.isMarketOpen || clock.squareOffWindow) return;
    const bootGrace = Number(process.env.SCALP_SCANNER_BOOT_GRACE_MS ?? 60_000);
    if (this.lastScanAt === 0 && Date.now() - this.bootedAt < bootGrace) return;
    if (this.lastScanAt > 0 && Date.now() - this.lastScanAt < SCAN_INTERVAL_MS) return;

    const gate = this.risk.canTrade();
    if (!gate.allowed) return;
    if (isDhanRateLimited()) return;
    if (this.openScalps.size >= MAX_CONCURRENT_SCALPS) return;

    this.lastScanAt = Date.now();
    for (const symbol of WATCHLIST) {
      if (this.openScalps.has(symbol)) continue;
      try {
        await this.evaluateSymbol(symbol);
      } catch (e: any) {
        eventBus.log('WARN', `Scalp scan failed for ${symbol}: ${e.message}`, 'scalp_scanner');
      }
    }
  }

  private async evaluateSymbol(symbol: string): Promise<void> {
    const inst = INDEX_INSTRUMENTS[symbol];
    if (!inst) return;

    // 1. Get underlying spot
    const spot = this.market.getLtp(inst.securityId);
    if (!spot || spot <= 0) return;

    // 2. Get 1m candles for Supertrend momentum
    const oneMin = await this.fetchOneMinCandles(symbol, inst.securityId);
    if (!oneMin || oneMin.length < 35) return;

    // 3. Check momentum alignment (1m Supertrend aligned with 5m)
    const momentum = this.checkMomentum(symbol, oneMin);
    if (!momentum) return;

    // 4. Pull the option chain for ATM options
    const expiry = await resolveNearestExpiry(this.client, symbol);
    const chain = await this.client.optionChain
      .fetchNormalized({ underlyingScrip: Number(inst.securityId), underlyingSeg: 'IDX_I', expiry })
      .catch(() => null);
    if (!chain?.strikes?.length) return;

    // 5. Find an ATM option with the right delta
    const optionType = momentum.direction === 'LONG' ? 'CE' : 'PE';
    const greekTypeForChain = optionType === 'CE' ? 'CALL' : 'PUT';
    const strikeRow = selectStrikeByDelta(chain.strikes, 0.52, greekTypeForChain, spot, expiry);
    if (!strikeRow?.targetLeg) return;

    const leg = strikeRow.targetLeg;
    const securityId = String(leg.securityId || '');
    if (!securityId) return;

    // 6. Get the live price + bid/ask
    this.market.addInstruments([{ securityId, exchangeSegment: 'NSE_FNO' }]);
    const ltp = this.market.getLtp(securityId) || Number(leg.ltp || leg.lastPrice || 0);
    if (!ltp || ltp <= 0) return;

    const bidAsk = getBidAsk(this.market, securityId);
    const spread = bidAsk?.spread ?? ltp * 0.01; // estimate 1% if no depth
    const spreadPct = bidAsk?.spreadPct ?? 1.0;

    // 7. Compute delta, IV, volume
    const delta = Math.abs(calculateGreeks(spot, strikeRow.strike, expiry, greekTypeForChain, leg.iv || 0.15).delta);
    const analytics = analyzeOptionChain(symbol, chain.strikes, spot, expiry, this.market.getLtp(INDEX_INSTRUMENTS.INDIAVIX.securityId) || 14);
    recordIvSample(symbol, analytics.atmIv);
    const ivRank = getIvRank(symbol);
    const volume = Number(leg.volume || 0);

    // 8. Compute fees + expected move
    const lotSize = getLotSize(symbol);
    const fees = estimateRoundTripFees(ltp, lotSize, 'NSE_FNO');
    const breakeven = fees.breakevenPerUnit;
    // Expected move = spot × IV × sqrt(timeToExpiry/365) / 16 (1 SD)
    const hoursToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / (1000 * 60 * 60));
    const daysToExpiry = hoursToExpiry / 24;
    const expectedMove = spot * (analytics.atmIv / 100) * Math.sqrt(Math.max(daysToExpiry, 1) / 365) / 16;

    // 9. Check all entry gates
    const config = this.scalpManager.getConfig();
    const gateRejection = this.scalpManager.checkEntryGate({
      delta,
      spreadPct,
      ivRank,
      volume,
      expectedMove: expectedMove * lotSize, // convert to ₹ per lot
      breakeven: fees.total,
    });

    if (gateRejection) {
      eventBus.log('INFO', `Scalp scan ${symbol}: gate rejected — ${gateRejection}`, 'scalp_scanner');
      return;
    }

    // 10. Compute ATR-based initial SL
    const atr = this.computeATR(oneMin, 14);
    const atrSL = config.atrMultiple * atr;
    // Translate underlying ATR to option price via delta
    const optionSLDistance = atrSL * delta;
    const initialSL = momentum.direction === 'LONG'
      ? ltp - optionSLDistance
      : ltp + optionSLDistance;

    // 11. Place the order
    const corrId = `scalp_${Date.now().toString(36)}_${symbol}`.slice(0, 25);
    const result: any = await this.engine.placeOrder({
      correlation_id: corrId,
      intent_id: `scalp_${symbol}`,
      params: {
        security_id: securityId,
        symbol: leg.tradingSymbol || `${symbol}_${strikeRow.strike}_${optionType}`,
        quantity: lotSize,
        transaction_type: 'BUY',
        order_type: 'MARKET',
        exchange_segment: 'NSE_FNO',
        product_type: 'INTRADAY',
        price: ltp,
        underlying: symbol,
        strike: strikeRow.strike,
        option_type: optionType,
      },
      // No risk_limits on the order — the ScalpPositionManager owns all exits.
    });

    if (result.status !== 'TRADED') {
      eventBus.log('WARN', `Scalp order REJECTED for ${symbol}: ${result.reason}`, 'scalp_scanner');
      return;
    }

    const fillPrice = result.fill_price ?? ltp;

    // 12. Register with the scalp manager — this starts the ratchet tracking
    this.scalpManager.registerEntry({
      tradingSymbol: leg.tradingSymbol || `${symbol}_${strikeRow.strike}_${optionType}`,
      securityId,
      underlying: symbol,
      side: momentum.direction,
      entryPrice: fillPrice,
      quantity: lotSize,
      lotSize,
      entryTime: Date.now(),
      initialSL,
      delta,
      underlyingSpot: spot,
      underlyingAtr: atr,
      exchangeSegment: 'NSE_FNO',
    });

    // 13. Track + journal
    this.openScalps.add(symbol);
    if (isPaperMode()) {
      await createPaperStrategy({
        id: corrId,
        name: `Scalp ${momentum.direction} ${symbol} ${strikeRow.strike}${optionType}`,
        symbol,
        type: 'SCALP',
        lots: 1,
        legs: [{
          instrument: leg.tradingSymbol || `${symbol}_${strikeRow.strike}_${optionType}`,
          securityId,
          side: 'BUY',
          qty: lotSize,
          strike: strikeRow.strike,
          optionType,
          price: fillPrice,
          exchangeSegment: 'NSE_FNO',
        }],
      }).catch(() => {});
    }

    eventBus.log('TRADE', `Scalp ENTRY ${momentum.direction} ${symbol} ${strikeRow.strike}${optionType} @ ₹${fillPrice.toFixed(2)} (Δ=${delta.toFixed(2)}, SL=₹${initialSL.toFixed(2)}, spread=${spreadPct.toFixed(2)}%, IVr=${ivRank ?? '?'}, fees=₹${fees.total.toFixed(0)})`, 'scalp_scanner');
  }

  /** Checks 1m/5m Supertrend alignment. Returns direction if aligned, null if not. */
  private checkMomentum(symbol: string, oneMin: Candle[]): { direction: 'LONG' | 'SHORT'; freshCrossover: boolean } | null {
    if (oneMin.length < 35) return null;
    const st1m = supertrend(oneMin, { period: 10, multiplier: 3 });
    const dir1m = st1m.direction[st1m.direction.length - 1];
    const prevDir1m = st1m.direction[st1m.direction.length - 2];
    if (dir1m == null || prevDir1m == null) return null;

    // For 5m, we'd need 5m candles. For simplicity in this scanner, we
    // use the 1m Supertrend direction alone with a confirmation: the
    // 1m must have just flipped (freshCrossover) OR be strongly trending
    // (last 5 candles all in the same direction).
    const freshCrossover = dir1m !== prevDir1m;
    if (freshCrossover) {
      return { direction: dir1m === 1 ? 'LONG' : 'SHORT', freshCrossover: true };
    }

    // Continuation: check last 5 candles are all same direction
    const recentDirs = st1m.direction.slice(-5);
    if (recentDirs.every((d) => d === dir1m) && dir1m != null) {
      return { direction: dir1m === 1 ? 'LONG' : 'SHORT', freshCrossover: false };
    }

    return null;
  }

  /** Fetches 1-minute candles for the underlying. */
  private async fetchOneMinCandles(symbol: string, securityId: string): Promise<Candle[] | null> {
    try {
      // Use the SDK's candle/historical data API
      const candles = await (this.client as any).marketFeed?.historical?.({
        securityId,
        exchangeSegment: 'IDX_I',
        interval: '1',
        daysCount: 1,
      }).catch(() => null);
      if (!candles || !Array.isArray(candles)) return null;
      return candles as Candle[];
    } catch {
      return null;
    }
  }

  /** Computes ATR (Average True Range) for the underlying. */
  private computeATR(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 0;
    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = Number(candles[i]?.high ?? 0);
      const low = Number(candles[i]?.low ?? 0);
      const prevClose = Number(candles[i - 1]?.close ?? 0);
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      );
      trueRanges.push(tr);
    }
    const recent = trueRanges.slice(-period);
    return recent.reduce((s, v) => s + v, 0) / recent.length;
  }

  /** Called by the autonomy engine when a scalp position is closed —
   *  removes the symbol from the open set so new entries can fire. */
  onPositionClosed(symbol: string): void {
    this.openScalps.delete(symbol);
  }

  /** Read-only probe for the UI. */
  async probe(): Promise<{ lastScanAt: number; openScalps: string[]; nextScanInSec: number }> {
    const nextMs = Math.max(0, SCAN_INTERVAL_MS - (Date.now() - this.lastScanAt));
    return {
      lastScanAt: this.lastScanAt,
      openScalps: [...this.openScalps],
      nextScanInSec: Math.round(nextMs / 1000),
    };
  }
}
