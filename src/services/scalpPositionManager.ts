/**
 * Scalp position manager — tracks open scalp positions, evaluates the
 * both-side ratchet exit policy on every tick, and emits real-time
 * state via the EventBus 'scalp' channel.
 *
 * This is the scalp equivalent of LongOptionPositionManager — it owns
 * the lifecycle of scalp positions (entry → ratchet updates → exit)
 * and publishes a state snapshot every tick so the frontend can render
 * the trailing SL/floor/TP levels in real time.
 *
 * ── Real-time emission strategy ─────────────────────────────────────────
 *
 * Every tick (coalesced via queueMicrotask, same pattern as
 * RiskEngine.scheduleTickEvaluate) triggers:
 *   1. Re-evaluate the exit policy for each open position
 *   2. If EXIT → close the position via PortfolioSource, emit an 'exit'
 *      envelope, and record the trade in the scalp history
 *   3. If HOLD → emit a 'tick' envelope with the updated trailing levels
 *
 * The frontend subscribes to the 'scalp' channel and receives:
 *   - { type: 'entry', position: ScalpState } on new scalp open
 *   - { type: 'tick', positions: ScalpState[] } on every tick (all open)
 *   - { type: 'exit', position: ScalpState, decision: ScalpDecision, pnl: number }
 *   - { type: 'config', config: ScalpConfig } on config change
 *   - { type: 'stats', stats: ScalpStats } after every exit
 */

import type { MarketDataService } from './marketData';
import { getBidAsk } from './marketData';
import type { PortfolioSource } from './portfolioSource';
import { eventBus } from './eventBus';
import { journal } from './journal';
import { evaluateScalpExit, type ScalpState, type ScalpDecision } from './scalpExitPolicy';
import { DEFAULT_SCALP_CONFIG, type ScalpConfig } from './scalpConfig';
import { calculateRoundTripFees, minProfitableCapture } from './feeModel';
import { getLotSize } from './strategyConstructor';
import { calculateGreeks } from './optionsAnalytics';
import { INDEX_INSTRUMENTS } from './marketData';
import { nearestIndexExpiry } from './marketHours';
import { getLastIv } from './optionsAnalytics';
import { marketClock } from './marketHours';
import { shouldEmitKeyedLog } from '../lib/logPolicy';

export interface ScalpEntry {
  tradingSymbol: string;
  securityId: string;
  underlying: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  lotSize: number;
  entryTime: number;
  initialSL: number;
  delta: number;
  underlyingSpot: number;
  underlyingAtr: number;
  exchangeSegment: string;
}

export interface ScalpExitRecord {
  positionId: string;
  tradingSymbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;           // net of fees
  fees: number;
  holdMs: number;
  exitReason: string;
  exitAction: string;
  peakR: number;
  entryTime: number;
  exitTime: number;
}

export interface ScalpStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  netPnl: number;
  avgHoldMs: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;   // gross profit / gross loss
  bestTrade: number;
  worstTrade: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

export interface ScalpTickEnvelope {
  type: 'entry' | 'tick' | 'exit' | 'config' | 'stats';
  positions?: ScalpState[];
  position?: ScalpState;
  decision?: ScalpDecision;
  pnl?: number;
  fees?: number;
  config?: ScalpConfig;
  stats?: ScalpStats;
  ts: number;
}

const MAX_HISTORY = 100;

export class ScalpPositionManager {
  private positions = new Map<string, ScalpState>();
  private history: ScalpExitRecord[] = [];
  private config: ScalpConfig = { ...DEFAULT_SCALP_CONFIG };
  private enabled = false;
  private unsubBus: Array<() => void> = [];
  private tickScheduled = false;
  private lastEmitAt = 0;
  private consecutiveWins = 0;
  private consecutiveLosses = 0;

  constructor(
    private market: MarketDataService,
    private portfolio: PortfolioSource,
  ) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    // Listen to ticks — coalesced so a burst of ticks triggers one
    // evaluate cycle, not N (same pattern as RiskEngine).
    this.unsubBus.push(eventBus.on('tick', () => this.scheduleEvaluate()));
    // Also evaluate on order fills (a new scalp entry needs immediate tracking)
    this.unsubBus.push(eventBus.on('order', (env) => {
      const p = env.payload || {};
      if (p.kind === 'fill' && p.is_paper !== false) {
        // A fill might be a new scalp entry — check if we should track it.
        // For now, entries are registered explicitly via registerEntry().
        // This listener is for immediate re-evaluation after a fill.
        this.scheduleEvaluate();
      }
    }));
    eventBus.log('SYSTEM', `Scalp position manager started (minCapture=₹${this.config.minCapturePerLot}, ratchet tiers=${this.config.ratchet.length})`, 'scalp');
    this.emit({ type: 'config', config: this.config, ts: Date.now() });
  }

  stop(): void {
    this.enabled = false;
    this.unsubBus.forEach((u) => u());
    this.unsubBus = [];
  }

  isEnabled(): boolean { return this.enabled; }

  getConfig(): ScalpConfig { return { ...this.config }; }

  setConfig(patch: Partial<ScalpConfig>): void {
    this.config = { ...this.config, ...patch };
    eventBus.log('SYSTEM', `Scalp config updated: ${JSON.stringify(patch)}`, 'scalp');
    this.emit({ type: 'config', config: this.config, ts: Date.now() });
  }

  /** Registers a new scalp position — called by the entry scanner or manually. */
  registerEntry(entry: ScalpEntry): string {
    const positionId = `scalp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const fees = calculateRoundTripFees(entry.entryPrice, entry.entryPrice, entry.quantity, entry.exchangeSegment as 'NSE_FNO' | 'BSE_FNO');
    const feesPerLot = fees.perLot;

    const state: ScalpState = {
      positionId,
      tradingSymbol: entry.tradingSymbol,
      securityId: entry.securityId,
      underlying: entry.underlying,
      side: entry.side,
      entryPrice: entry.entryPrice,
      currentPrice: entry.entryPrice,
      peakPrice: entry.entryPrice,
      lotSize: entry.lotSize,
      quantity: entry.quantity,
      underlyingSpot: entry.underlyingSpot,
      underlyingPeak: entry.underlyingSpot,
      underlyingAtr: entry.underlyingAtr,
      delta: entry.delta,
      initialRisk: Math.abs(entry.entryPrice - entry.initialSL),
      initialSL: entry.initialSL,
      currentSL: entry.initialSL,
      currentFloor: entry.entryPrice,
      currentTP: entry.entryPrice + (this.config.minCapturePerLot * 2) / entry.lotSize,
      entryTime: entry.entryTime,
      holdMs: 0,
      rMultiple: 0,
      activeTier: 0,
      givebackUsed: 0,
      feesPerLot,
      breakevenPrice: entry.entryPrice + feesPerLot,
      profitSoFar: -fees.total,
      peakProfit: -fees.total,
      momentumReversed: false,
      momentumStrength: 0,
    };

    this.positions.set(positionId, state);
    eventBus.log('TRADE', `Scalp ENTRY ${entry.side} ${entry.tradingSymbol} @ ₹${entry.entryPrice.toFixed(2)} (SL ₹${entry.initialSL.toFixed(2)}, fees ₹${fees.total.toFixed(0)}, R=risk₹${(state.initialRisk * entry.quantity).toFixed(0)})`, 'scalp');
    journal.append('scalp_entry', { positionId, ...entry, fees: fees.total });
    this.emit({ type: 'entry', position: state, ts: Date.now() });
    return positionId;
  }

  /** Evaluates all open positions against the exit policy. Called on every tick. */
  private async evaluate(): Promise<void> {
    if (!this.enabled || this.positions.size === 0) return;
    const now = Date.now();

    for (const [positionId, state] of this.positions) {
      // Update current price from live market data
      const ltp = this.market.getLtp(state.securityId);
      if (ltp && ltp > 0) {
        state.currentPrice = ltp;
        // Update peak (for LONG, peak is highest; for SHORT, lowest)
        if (state.side === 'LONG' && ltp > state.peakPrice) state.peakPrice = ltp;
        if (state.side === 'SHORT' && (ltp < state.peakPrice || state.peakPrice === state.entryPrice)) state.peakPrice = ltp;
      }

      // Update underlying spot + peak
      const underlyingInst = INDEX_INSTRUMENTS[state.underlying];
      if (underlyingInst) {
        const spot = this.market.getLtp(underlyingInst.securityId);
        if (spot && spot > 0) {
          state.underlyingSpot = spot;
          if (state.side === 'LONG' && spot > state.underlyingPeak) state.underlyingPeak = spot;
          if (state.side === 'SHORT' && (spot < state.underlyingPeak || state.underlyingPeak === state.entryPrice)) state.underlyingPeak = spot;
        }
      }

      // Evaluate the exit policy
      const decision = evaluateScalpExit(state, this.config, now);
      // Update state with the snapshot from the decision
      this.positions.set(positionId, decision.stateSnapshot);

      if (decision.action !== 'HOLD') {
        // Execute the exit
        await this.executeExit(positionId, decision);
      }
    }

    // Emit a tick envelope with all open positions — throttled to ~2/sec
    // so the frontend gets smooth but not overwhelming updates.
    if (now - this.lastEmitAt >= 500) {
      this.lastEmitAt = now;
      const openPositions = [...this.positions.values()];
      if (openPositions.length > 0) {
        this.emit({ type: 'tick', positions: openPositions, ts: now });
      }
    }
  }

  private async executeExit(positionId: string, decision: ScalpDecision): Promise<void> {
    const state = this.positions.get(positionId);
    if (!state) return;

    const exitPrice = decision.exitPrice ?? state.currentPrice;
    const fees = calculateRoundTripFees(state.entryPrice, exitPrice, state.quantity);
    const grossPnl = state.side === 'LONG'
      ? (exitPrice - state.entryPrice) * state.quantity
      : (state.entryPrice - exitPrice) * state.quantity;
    const netPnl = grossPnl - fees.total;

    // Close the position via PortfolioSource
    try {
      await this.portfolio.closePosition(
        { securityId: state.securityId, exchangeSegment: 'NSE_FNO' },
        exitPrice,
        'EXIT',
      );
    } catch (e: any) {
      eventBus.log('ERROR', `Scalp exit FAILED for ${state.tradingSymbol}: ${e.message}`, 'scalp');
      // Don't remove from tracking — retry on next tick
      return;
    }

    // Record the trade
    const record: ScalpExitRecord = {
      positionId,
      tradingSymbol: state.tradingSymbol,
      side: state.side,
      entryPrice: state.entryPrice,
      exitPrice,
      quantity: state.quantity,
      pnl: netPnl,
      fees: fees.total,
      holdMs: Date.now() - state.entryTime,
      exitReason: decision.reason,
      exitAction: decision.action,
      peakR: state.rMultiple,
      entryTime: state.entryTime,
      exitTime: Date.now(),
    };

    this.history.unshift(record);
    if (this.history.length > MAX_HISTORY) this.history.pop();
    this.positions.delete(positionId);

    // Update consecutive win/loss streaks
    if (netPnl > 0) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }

    const icon = netPnl >= 0 ? '✅' : '❌';
    eventBus.log('TRADE', `${icon} Scalp EXIT ${state.tradingSymbol} @ ₹${exitPrice.toFixed(2)} (${decision.action}) — PnL ₹${netPnl.toFixed(0)} (fees ₹${fees.total.toFixed(0)}, ${record.holdMs / 1000 | 0}s, ${state.rMultiple.toFixed(1)}R peak)`, 'scalp');
    journal.append('scalp_exit', record);

    this.emit({
      type: 'exit',
      position: state,
      decision,
      pnl: netPnl,
      fees: fees.total,
      ts: Date.now(),
    });
    this.emit({ type: 'stats', stats: this.computeStats(), ts: Date.now() });
  }

  private computeStats(): ScalpStats {
    const trades = this.history;
    if (trades.length === 0) {
      return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, totalFees: 0, netPnl: 0, avgHoldMs: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, bestTrade: 0, worstTrade: 0, consecutiveWins: 0, consecutiveLosses: 0 };
    }
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalFees = trades.reduce((s, t) => s + t.fees, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const avgHoldMs = trades.reduce((s, t) => s + t.holdMs, 0) / trades.length;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnl,
      totalFees,
      netPnl: totalPnl,
      avgHoldMs,
      avgWin,
      avgLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      bestTrade: Math.max(...trades.map((t) => t.pnl)),
      worstTrade: Math.min(...trades.map((t) => t.pnl)),
      consecutiveWins: this.consecutiveWins,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  private scheduleEvaluate(): void {
    if (this.tickScheduled || !this.enabled) return;
    this.tickScheduled = true;
    queueMicrotask(async () => {
      this.tickScheduled = false;
      try { await this.evaluate(); }
      catch (e: any) {
        if (shouldEmitKeyedLog('scalp:evaluate_error', 30_000)) {
          eventBus.log('ERROR', `Scalp evaluate error: ${e.message}`, 'scalp');
        }
      }
    });
  }

  private emit(env: ScalpTickEnvelope): void {
    eventBus.emit('scalp', env);
  }

  // ── Read API for REST routes ──────────────────────────────────────────

  getOpenPositions(): ScalpState[] {
    return [...this.positions.values()];
  }

  getHistory(limit = 50): ScalpExitRecord[] {
    return this.history.slice(0, limit);
  }

  getStats(): ScalpStats {
    return this.computeStats();
  }

  /** Checks whether a potential scalp entry passes all entry gates.
   *  Returns null if approved, or a string explaining why it was rejected. */
  checkEntryGate(params: {
    delta: number;
    spreadPct: number;
    ivRank: number | null;
    volume: number;
    expectedMove: number;
    breakeven: number;
  }): string | null {
    const c = this.config;
    if (params.delta < c.deltaGate.min || params.delta > c.deltaGate.max) {
      return `Delta ${params.delta.toFixed(2)} outside gate [${c.deltaGate.min}, ${c.deltaGate.max}]`;
    }
    if (params.spreadPct > c.maxSpreadPct) {
      return `Spread ${params.spreadPct.toFixed(2)}% > max ${c.maxSpreadPct}%`;
    }
    if (params.ivRank !== null && params.ivRank < c.minIvRank) {
      return `IV rank ${params.ivRank} < min ${c.minIvRank}`;
    }
    if (params.volume < c.minVolume) {
      return `Volume ${params.volume} < min ${c.minVolume}`;
    }
    if (params.expectedMove < params.breakeven * c.minExpectedMoveMultiple) {
      return `Expected move ₹${params.expectedMove.toFixed(0)} < ${c.minExpectedMoveMultiple}× breakeven ₹${params.breakeven.toFixed(0)}`;
    }
    return null;
  }
}
