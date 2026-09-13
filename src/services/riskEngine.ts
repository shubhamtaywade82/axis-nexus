import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { logger } from '../lib/logger';
import { eventBus } from './eventBus';
import { journal } from './journal';
import { marketClock } from './marketHours';
import type { MarketDataService } from './marketData';
import { INDEX_INSTRUMENTS } from './marketData';
import { nearestIndexExpiry } from './marketHours';
import { calculateGreeks, getLastIv } from './optionsAnalytics';
import { PaperPortfolioSource, type PortfolioSource } from './portfolioSource';
import { getSystemState } from './systemState';
import { dhanRateLimitRemainingSec, isDhanRateLimited } from '../lib/dhanRateLimit';
import { getTradingMode, isLiveMode } from '../lib/tradingMode';
import { getTraderControls } from '../lib/dhanTraderControls';
import {
  pushAlert, getRiskState, saveRiskState,
  listPaperStrategies, updatePaperStrategyStatus,
} from '../db';

const riskLog = logger.child({ module: 'risk_engine' });

/**
 * Risk engine — computes circuit breakers from REAL account state
 * (wallet, positions marked to market, today's order flow, tick freshness)
 * and owns the kill switch.
 *
 * It runs on every order fill and on a periodic timer, independent of any
 * frontend. When a breaker trips it can arm the kill switch, which:
 *   - paper mode: closes every open paper position at the last live LTP
 *   - live mode:  invokes DhanHQ's kill switch (Trader's Control API) and
 *                 squares off intraday positions via the broker
 */

export interface RiskLimits {
  dailyLossLimit: number;        // INR, wallet + unrealized
  maxMarginUtilPct: number;      // % of total balance
  perStrategyLossLimit: number;  // INR per strategy
  maxConsecutiveLosses: number;  // trades
  maxRejectionRatePct: number;   // % rejected / total today
  staleTickSec: number;          // seconds without a tick during market hours
  maxConcurrentStrategies: number; // simultaneous RUNNING strategies, any index
  /** |net delta-equivalent notional| as % of equity. Deliberately a
   * triple/quadruple-digit-sized threshold, not a typo: an option's delta-
   * notional is the UNDERLYING's equivalent exposure, not the premium paid
   * for it — that's what leverage means. A single NIFTY ATM lot (65 ×
   * ~0.5Δ × ~24000 spot) already runs to roughly 8x the ₹100,000 default
   * paper wallet. A threshold sized like a plain margin-utilization
   * percentage (the old default was 150) makes canTrade() permanently
   * ERROR — and thus block every order — after the very first fill,
   * defeating the entire point of an autonomous multi-strategy system.
   * This default is tuned to read WARN (visible, non-blocking) around one
   * lot's worth of exposure and ERROR (blocks further same-direction
   * entries) once concentration roughly doubles that — a rough starting
   * point given the account size and lot sizes this varies with, meant to
   * be tuned to the REAL trading account's capital via
   * RISK_MAX_PORTFOLIO_DELTA_PCT, not treated as a universal constant. */
  maxPortfolioDeltaPct: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  dailyLossLimit: Number(process.env.RISK_DAILY_MAX_LOSS) || 50000,
  maxMarginUtilPct: 70,
  perStrategyLossLimit: 20000,
  maxConsecutiveLosses: 5,
  maxRejectionRatePct: 10,
  staleTickSec: Number(process.env.RISK_STALE_TICK_SEC) || 30,
  maxConcurrentStrategies: Number(process.env.RISK_MAX_CONCURRENT_STRATEGIES) || 5,
  maxPortfolioDeltaPct: Number(process.env.RISK_MAX_PORTFOLIO_DELTA_PCT) || 1000,
};

export interface CircuitBreakerRow {
  rule: string;
  threshold: string;
  current: string;
  state: 'OK' | 'WARN' | 'ERROR';
  action: string;
}

export class RiskEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private portfolio: PortfolioSource;
  private limits: RiskLimits = { ...DEFAULT_RISK_LIMITS };
  private killed = false;
  private killedReason: string | null = null;
  private killedAt: number | null = null;
  private killedDate: string | null = null; // IST date armed on — see start()
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBreakers: CircuitBreakerRow[] = [];
  private lastAlertTimes = new Map<string, number>();
  private lastEvalAt = 0;
  private tickEvalScheduled = false;
  private lastRiskEmitAt = 0;
  private evalInFlight: Promise<CircuitBreakerRow[]> | null = null;

  constructor(client: DhanClient, market: MarketDataService, portfolio: PortfolioSource = new PaperPortfolioSource()) {
    this.client = client;
    this.market = market;
    this.portfolio = portfolio;
  }

  async start(): Promise<void> {
    const persisted = await getRiskState();
    this.limits = { ...DEFAULT_RISK_LIMITS, ...(persisted.limits || {}) };
    const today = marketClock().istDate;
    if (persisted.killed && persisted.killedDate && persisted.killedDate !== today) {
      // A daily circuit breaker that survives into a new trading session is
      // stale by definition — "daily loss limit" means the budget resets
      // each day. Auto-clear rather than starting the day pre-killed.
      this.killed = false;
      this.killedReason = null;
      await saveRiskState({ killed: false, killedReason: null, killedDate: null, limits: this.limits, consecutiveLosses: persisted.consecutiveLosses });
      eventBus.log('SYSTEM', `Kill switch from ${persisted.killedDate} auto-cleared for new trading session (${today})`, 'risk_engine');
    } else {
      this.killed = !!persisted.killed;
      this.killedReason = persisted.killedReason || null;
      this.killedDate = persisted.killedDate || null;
    }

    // Re-evaluate every 5s — a fallback heartbeat, not the primary trigger.
    this.timer = setInterval(() => { void this.evaluate(); }, 5000);
    // React to fills immediately.
    eventBus.on('order', () => { void this.evaluate(); });
    // React to live ticks too — a fast adverse move (e.g. toward the daily
    // loss limit) should trip the kill switch within one tick, not wait up
    // to 5s for the timer. Coalesced: a burst of ticks in the same turn
    // triggers one evaluate(), not N — cheap now reads are in-memory only.
    eventBus.on('tick', () => this.scheduleTickEvaluate());
    eventBus.log('SYSTEM', `Risk engine armed (dailyLossLimit=₹${this.limits.dailyLossLimit}, margin=${this.limits.maxMarginUtilPct}%, losses=${this.limits.maxConsecutiveLosses})`, 'risk_engine');
  }

  private scheduleTickEvaluate(): void {
    if (this.tickEvalScheduled) return;
    this.tickEvalScheduled = true;
    // queueMicrotask, not setImmediate: ticks arrive in the same event-loop
    // turn and we want the coalesced evaluate() to run BEFORE the next I/O
    // poll (so a fast burst gets one eval, not N). setImmediate runs in
    // the check phase AFTER pending I/O — under high tick load that means
    // we'd evaluate after every I/O batch instead of once per microtask
    // drain. queueMicrotask is the right primitive for "coalesce within
    // the current turn."
    queueMicrotask(() => {
      this.tickEvalScheduled = false;
      void this.evaluate();
    });
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  async setLimits(patch: Partial<RiskLimits>): Promise<RiskLimits> {
    this.limits = { ...this.limits, ...patch };
    await saveRiskState({ killed: this.killed, killedReason: this.killedReason, killedDate: this.killedDate, limits: this.limits });
    riskLog.debug({ limits: this.limits }, 'Risk limits updated');
    return this.getLimits();
  }

  isKilled(): boolean {
    return this.killed;
  }

  /** Exposes the mode-appropriate PortfolioSource to other engines (the
   * agent's capital-allocation check, notably) so they don't need their own
   * copy of the paper/live branching this class already does. */
  getPortfolio(): PortfolioSource {
    return this.portfolio;
  }

  snapshot() {
    return {
      killed: this.killed,
      killedReason: this.killedReason,
      killedAt: this.killedAt,
      limits: this.getLimits(),
      breakers: this.lastBreakers,
      evaluatedAt: this.lastEvalAt ? new Date(this.lastEvalAt).toISOString() : null,
    };
  }

  /** Gate every order (paper or live) through this. */
  canTrade(): { allowed: boolean; reason?: string } {
    const state = getSystemState();
    if (state !== 'READY') return { allowed: false, reason: `System not ready (state=${state})` };
    if (this.killed) return { allowed: false, reason: 'Kill switch engaged' };
    const clock = marketClock();
    if (clock.squareOffWindow) return { allowed: false, reason: 'EOD square-off window — no new entries' };
    if (isDhanRateLimited()) {
      return { allowed: false, reason: `Dhan API rate limit — retry in ${dhanRateLimitRemainingSec()}s` };
    }
    // These breakers were computed by the last evaluate() cycle (runs every
    // tick) and displayed in the UI as ERROR, but nothing actually blocked
    // new entries on them — the dashboard could show red while the agent
    // kept trading. Read the same cached rows evaluate() already built.
    for (const rule of ['Margin Utilization', 'Stale Market Tick', 'Concurrent Strategies', 'Portfolio Net Delta']) {
      const row = this.lastBreakers.find((b) => b.rule === rule);
      if (row?.state === 'ERROR') return { allowed: false, reason: `${rule} breached (${row.current} vs ${row.threshold})` };
    }
    const rejectionRow = this.lastBreakers.find((b) => b.rule === 'Order Rejection Rate');
    if (rejectionRow?.state === 'WARN') {
      return { allowed: false, reason: `Order rejection rate elevated (${rejectionRow.current})` };
    }
    return { allowed: true };
  }

  /**
   * Arm the kill switch for real. Paper mode squares off every open
   * position at the freshest LTP; live mode ALSO halts order flow at the
   * broker itself via DhanHQ Trader's Control before squaring off.
   *
   * The broker call is intentionally isolated in its own try/catch: it must
   * never be able to block the actual square-off below, which is the real
   * safety mechanism. (An earlier version of this method called
   * traderControls.killSwitch()/.pnlExit() — neither exists on the SDK;
   * TraderControls only exposes setKillSwitch(status) and setPnlExit(req).
   * Because both calls used optional chaining, a wrong method name resolved
   * to undefined and silently no-opped rather than throwing — the broker's
   * own kill switch never actually engaged in live mode, while this method
   * proceeded to record brokerKillSwitch as engaged anyway. setPnlExit is
   * not used here at all: it configures the broker's own auto-exit
   * thresholds (profitValue/lossValue), which would need real, deliberately
   * chosen values this system has no basis to invent — closeAll() below
   * already handles actually exiting every position, so ACTIVATE (which
   * only blocks new order placement, exits nothing on its own) is
   * sufficient and doesn't duplicate it.)
   */
  async armKillSwitch(reason: string): Promise<{ status: string; details: any }> {
    if (this.killed) return { status: 'already_killed', details: { reason: this.killedReason } };
    this.killed = true;
    this.killedReason = reason;
    this.killedAt = Date.now();
    this.killedDate = marketClock().istDate;
    await saveRiskState({ killed: true, killedReason: reason, killedDate: this.killedDate, limits: this.limits });

    const details: any = { mode: getTradingMode(), positionsClosed: 0 };

    if (isLiveMode()) {
      const traderControls = getTraderControls(this.client);
      if (!traderControls) {
        details.brokerKillSwitchError = 'TraderControls not available on SDK client — broker kill switch could not be engaged';
        eventBus.log('ERROR', 'Broker kill switch UNAVAILABLE: SDK client has no TraderControls — proceeding to square off locally anyway', 'risk_engine');
      } else {
        try {
          await traderControls.setKillSwitch('ACTIVATE');
          details.brokerKillSwitch = 'ACTIVATE';
        } catch (e: any) {
          details.brokerKillSwitchError = e.message;
          eventBus.log('ERROR', `Broker kill switch ACTIVATE failed: ${e.message} — proceeding to square off locally anyway`, 'risk_engine');
        }
      }
    }

    try {
      const openBefore = await this.portfolio.getPositions();
      const closes = (await this.portfolio.closeAll((secId, _sym) => this.market.getFillablePrice(secId, { allowClosed: true }) ?? this.market.getLtp(secId))) as any[];
      const closedSymbols = new Set(closes.filter((c) => c && c.status === 'TRADED').map((c) => c.symbol));
      details.positionsClosed = closedSymbols.size;
      for (const c of closes) {
        if (c && c.status === 'TRADED') {
          eventBus.emit('order', { kind: 'kill_switch_fill', orderId: c.orderId, symbol: c.symbol, side: c.side, fillPrice: c.fillPrice });
        }
      }
      // Only untrack a position that was ACTUALLY flattened. closeAll can
      // return a mix of TRADED and REJECTED (a broker order rejection, or —
      // in paper mode — an insufficient-margin throw partway through the
      // loop): untracking on the mere ATTEMPT, regardless of outcome,
      // stripped stop-loss/target monitoring from a position that is still
      // open with real exposure, and (in broker mode) there is no way to
      // re-arm it later — a broker position's stopLoss/target/trailingStop
      // are always null, so reconcileMonitor can never reconstruct what
      // protection it's missing.
      for (const pos of openBefore) {
        if (pos.netQty !== 0 && closedSymbols.has(pos.tradingSymbol)) {
          this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        }
      }
      // Stop every RUNNING strategy too — this also reverses any multi-leg
      // hedge-margin credit (see updatePaperStrategyStatus), which the raw
      // position closes above don't know about.
      for (const s of await listPaperStrategies()) {
        if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
      }
    } catch (e: any) {
      details.error = e.message;
    }

    await pushAlert('ERROR', 'risk_engine', `KILL SWITCH ENGAGED: ${reason}. ${details.positionsClosed} position(s) squared off.`);
    eventBus.emit('alert', { level: 'ERROR', source: 'risk_engine', msg: `KILL SWITCH ENGAGED: ${reason}` });
    eventBus.log('ERROR', `*** KILL SWITCH ENGAGED *** reason=${reason} positionsClosed=${details.positionsClosed}`, 'risk_engine');
    eventBus.emit('system', { type: 'kill_switch', state: 'ENGAGED', reason });
    eventBus.emit('risk', this.snapshot());
    journal.append('kill', { action: 'arm', reason, details });
    return { status: 'killed', details };
  }

  async disarmKillSwitch(): Promise<{ status: string }> {
    this.killed = false;
    this.killedReason = null;
    this.killedAt = null;
    this.killedDate = null;
    await saveRiskState({ killed: false, killedDate: null, limits: this.limits });
    try {
      if (isLiveMode()) {
        const traderControls = getTraderControls(this.client);
        if (traderControls) {
          await traderControls.setKillSwitch('DEACTIVATE');
        }
      }
    } catch { /* broker may reject if not armed */ }
    eventBus.log('INFO', 'Kill switch disarmed — trading re-enabled', 'risk_engine');
    eventBus.emit('system', { type: 'kill_switch', state: 'DISENGAGED' });
    eventBus.emit('risk', this.snapshot());
    journal.append('kill', { action: 'disarm' });
    return { status: 'ok' };
  }

  /** Rupee-equivalent net directional exposure across every open position,
   * normalized across underlyings by delta (so NIFTY and SENSEX deltas are
   * comparable) — the actual professional-desk number, not a strategy count.
   * Symbol format is "<UNDERLYING><STRIKE><CE|PE>" (e.g. NIFTY24050PE),
   * which is how every position is already keyed in this system. Expiry and
   * IV aren't persisted per-position, so this approximates with the current
   * nearest weekly expiry and the underlying's last observed ATM IV
   * (getLastIv — populated by the agent's own option-chain scans), falling
   * back to a flat 15% only when this underlying hasn't been scanned yet
   * this process lifetime — a coarse but honest estimate either way,
   * refreshed every evaluate() cycle rather than pretending precision it
   * doesn't have. */
  /** A real DhanHQ trading symbol's exact string format is not the
   * synthesized "<UNDERLYING><STRIKE><CE|PE>" shape the paper engine
   * invents (see NormalizedPosition.strike's docstring) — but every
   * broker's option symbol still names its underlying at the front, so a
   * starts-with match against the known watchlist works for both. None of
   * NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX is a prefix of another, so
   * this can't cross-match. */
  private identifyUnderlying(tradingSymbol: string): string | null {
    const sym = String(tradingSymbol || '').toUpperCase();
    for (const key of Object.keys(INDEX_INSTRUMENTS)) {
      if (key === 'INDIAVIX') continue; // not an options underlying
      if (sym.startsWith(key)) return key;
    }
    return null;
  }

  private estimatePortfolioDeltaNotional(positions: any[]): number {
    let deltaNotional = 0;
    for (const p of positions) {
      const netQty = Number(p.netQty ?? p.net_qty ?? 0);
      if (netQty === 0) continue;

      const underlying = this.identifyUnderlying(p.tradingSymbol);
      if (!underlying) continue;
      const inst = (INDEX_INSTRUMENTS as any)[underlying];
      const spot = this.market.getLtp(inst.securityId);
      if (!spot) continue;

      // Prefer the broker's own strike/optionType (real DhanHQ positions —
      // see NormalizedPosition.strike) over parsing tradingSymbol, which
      // only matches the paper engine's synthesized format.
      let strike: number | null = p.strike ?? null;
      let optType: 'CALL' | 'PUT' | null = p.optionType ?? null;
      if (strike == null || optType == null) {
        const m = String(p.tradingSymbol || '').match(/^([A-Z]+?)(\d+)(CE|PE)$/);
        if (!m) continue;
        strike = Number(m[2]);
        optType = m[3] === 'CE' ? 'CALL' : 'PUT';
      }

      const expiry = nearestIndexExpiry(underlying);
      const iv = getLastIv(underlying) ?? 0.15;
      const g = calculateGreeks(spot, strike, expiry, optType, iv);
      deltaNotional += netQty * g.delta * spot;
    }
    return deltaNotional;
  }

  async evaluate(): Promise<CircuitBreakerRow[]> {
    if (this.evalInFlight) return this.evalInFlight;
    this.evalInFlight = this.runEvaluate();
    try {
      return await this.evalInFlight;
    } finally {
      this.evalInFlight = null;
    }
  }

  private async runEvaluate(): Promise<CircuitBreakerRow[]> {
    this.lastEvalAt = Date.now();
    const [wallet, positions, orderStats, strategies] = await Promise.all([
      this.portfolio.getWallet(), this.portfolio.getPositions(), this.portfolio.getTodayOrderStats(), listPaperStrategies(),
    ]);

    // unrealizedProfit, not unrealizedPnl — the latter is a paper-only
    // legacy alias db.ts's listPaperPositions() also sets; NormalizedPosition
    // (broker mode included) only carries unrealizedProfit, matching the
    // DhanHQ PositionResponse field name.
    const unrealized = positions.reduce((acc, p) => acc + (Number(p.unrealizedProfit) || 0), 0);
    const dayPnl = Number(wallet.sessionRealizedPnl) + unrealized;
    const total = Number(wallet.totalBalance) || 1;
    const utilPct = (Number(wallet.usedMargin) / total) * 100;
    const rejectionRate = orderStats.total > 0 ? (orderStats.rejected / orderStats.total) * 100 : 0;
    const runningCount = strategies.filter((s: any) => s.status === 'RUNNING').length;
    const deltaNotional = this.estimatePortfolioDeltaNotional(positions);
    const deltaPct = (Math.abs(deltaNotional) / total) * 100;
    const tickAge = this.market.tickAgeSec();
    const clock = marketClock();
    const staleErrorLimit = this.limits.staleTickSec;
    const staleWarnLimit = Math.max(10, Math.round(staleErrorLimit * 0.5));
    const isStaleError = clock.isMarketOpen && tickAge > staleErrorLimit;
    const isStaleWarn = clock.isMarketOpen && tickAge > staleWarnLimit;

    const rows: CircuitBreakerRow[] = [
      {
        rule: 'Daily Loss Limit',
        threshold: `₹${this.limits.dailyLossLimit.toLocaleString('en-IN')}`,
        current: `₹${Math.round(dayPnl).toLocaleString('en-IN')}`,
        state: dayPnl <= -this.limits.dailyLossLimit ? 'ERROR' : dayPnl <= -this.limits.dailyLossLimit * 0.6 ? 'WARN' : 'OK',
        action: 'Close all positions and arm kill switch',
      },
      {
        rule: 'Margin Utilization',
        threshold: `${this.limits.maxMarginUtilPct}%`,
        current: `${utilPct.toFixed(1)}%`,
        state: utilPct >= this.limits.maxMarginUtilPct ? 'ERROR' : utilPct >= this.limits.maxMarginUtilPct * 0.7 ? 'WARN' : 'OK',
        action: 'Block new position opens',
      },
      {
        rule: 'Consecutive Losses',
        threshold: `${this.limits.maxConsecutiveLosses} trades`,
        current: `${orderStats.consecutiveLosses} trades`,
        state: orderStats.consecutiveLosses >= this.limits.maxConsecutiveLosses ? 'ERROR' : orderStats.consecutiveLosses >= this.limits.maxConsecutiveLosses - 1 ? 'WARN' : 'OK',
        action: 'Pause strategy entries for 15 min',
      },
      {
        rule: 'Order Rejection Rate',
        threshold: `>${this.limits.maxRejectionRatePct}% today`,
        current: orderStats.total > 0 ? `${orderStats.rejected}/${orderStats.total} (${rejectionRate.toFixed(0)}%)` : '0 orders',
        state: orderStats.total >= 5 && rejectionRate > this.limits.maxRejectionRatePct ? 'WARN' : 'OK',
        action: 'Throttle order placement',
      },
      {
        rule: 'Stale Market Tick',
        threshold: `>${staleErrorLimit}s (warn >${staleWarnLimit}s)`,
        current: clock.isMarketOpen ? (tickAge === Infinity ? 'no ticks yet' : `${tickAge}s`) : 'market closed',
        state: isStaleError ? 'ERROR' : isStaleWarn ? 'WARN' : 'OK',
        action: 'Pause strategies consuming stale data',
      },
      {
        rule: 'Concurrent Strategies',
        threshold: `${this.limits.maxConcurrentStrategies}`,
        current: `${runningCount}`,
        state: runningCount >= this.limits.maxConcurrentStrategies ? 'ERROR' : runningCount >= this.limits.maxConcurrentStrategies - 1 ? 'WARN' : 'OK',
        action: 'Block new strategy deploys — correlated pile-up across indices',
      },
      {
        rule: 'Portfolio Net Delta',
        threshold: `${this.limits.maxPortfolioDeltaPct}% of equity`,
        current: `${deltaPct.toFixed(0)}% (₹${Math.round(deltaNotional).toLocaleString('en-IN')})`,
        state: deltaPct >= this.limits.maxPortfolioDeltaPct ? 'ERROR' : deltaPct >= this.limits.maxPortfolioDeltaPct * 0.7 ? 'WARN' : 'OK',
        action: 'Block new same-direction entries — aggregate directional exposure too large',
      },
      {
        rule: 'EOD Square-Off Proximity',
        threshold: '15:20 IST',
        current: clock.squareOffWindow ? 'IN WINDOW' : `${clock.istTime} IST`,
        state: clock.squareOffWindow ? 'WARN' : 'OK',
        action: 'Force-close all intraday positions',
      },
    ];

    // Alert on state transitions only — one alert per rule+target state.
    const now = Date.now();
    const nextBreakers = rows;
    for (const row of rows) {
      const prev = this.lastBreakers.find((b) => b.rule === row.rule);
      if (!prev || prev.state === row.state || row.state === 'OK') continue;
      const alertKey = `${row.rule}:${row.state}`;
      const lastAlert = this.lastAlertTimes.get(alertKey) || 0;
      if (now - lastAlert < 60_000) continue;
      this.lastAlertTimes.set(alertKey, now);
      const level = row.state === 'ERROR' ? 'ERROR' : 'WARN';
      await pushAlert(level, 'risk_engine', `${row.rule}: ${prev.state} → ${row.state} (current ${row.current}, threshold ${row.threshold}). Action: ${row.action}`);
      eventBus.emit('alert', { level, source: 'risk_engine', msg: `${row.rule} tripped — ${row.current} vs ${row.threshold}` });
      journal.append('risk_decision', { rule: row.rule, from: prev.state, to: row.state, current: row.current, threshold: row.threshold, action: row.action });
    }

    this.lastBreakers = nextBreakers;

    // Hard breakers arm the kill switch autonomously.
    if (!this.killed) {
      if (dayPnl <= -this.limits.dailyLossLimit) {
        await this.armKillSwitch(`Daily loss limit breached (₹${Math.round(dayPnl)} ≤ -₹${this.limits.dailyLossLimit})`);
      } else if (isStaleError) {
        // Stale ticks: don't kill positions, but block new entries via canTrade
        // (the autonomy engine checks this gate each cycle).
      }
    }

    // Evaluation runs every tick for fast breach detection, but broadcasting
    // the full snapshot at the same rate floods the eventBus/log bridge for
    // no UI benefit (numbers don't need to redraw faster than ~1/s). Throttle
    // the emit only — detection and kill-switch arming above are unaffected.
    if (now - this.lastRiskEmitAt >= 1000) {
      this.lastRiskEmitAt = now;
      eventBus.emit('risk', this.snapshot());
    }
    return rows;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
