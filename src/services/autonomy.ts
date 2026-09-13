import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { journal } from './journal';
import { marketClock, istNow } from './marketHours';
import type { MarketDataService } from './marketData';
import { toTrailConfig } from './marketData';
import type { RiskEngine } from './riskEngine';
import type { AgentOrchestrator } from './agent';
import type { AdaptiveSupertrendScanner } from './adaptiveSupertrendScanner';
import type { ScalpScanner } from './scalpScanner';
import type { ResearchOrchestrator } from './research/researchOrchestrator';
import { LongOptionPositionManager } from './longOptionPositionManager';
import {
  listPaperStrategies, updatePaperStrategyStatus, pushAlert,
  reconcileLedger, correctLedgerFromPostgres, closeParentStrategyIfFlat,
} from '../db';
import { PaperPortfolioSource, type PortfolioSource } from './portfolioSource';
import { shouldEmitKeyedLog } from '../lib/logPolicy';
import { getTradingMode, isSandboxMode } from '../lib/tradingMode';

/**
 * Autonomy engine — the heartbeat that keeps the system trading when no
 * frontend is attached.
 *
 * Runs every 2s during market hours (30s off-hours):
 *   1. Marks all open paper positions to market from live ticks.
 *   2. Acts on PositionMonitor exit signals autonomously.
 *   3. Enforces strategy loss limits.
 *   4. Periodically scans for autonomous option opportunities (09:20-15:15 IST).
 *   5. Closes every position at 15:20 IST EOD square-off.
 */
export const MAX_CONCURRENT_POSITIONS = 4;

export class AutonomyEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;
  private portfolio: PortfolioSource;
  private agent: AgentOrchestrator | null = null;
  private research: ResearchOrchestrator | null = null;
  private scanner: AdaptiveSupertrendScanner | null = null;
  private scalpScanner: ScalpScanner | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private scanEnabled = process.env.AUTONOMOUS_SCAN_ENABLED !== 'false';
  private running = false;
  private lastCycleAt = 0;
  private lastScanAt = 0;
  private bootedAt = Date.now();
  private lastLedgerCheckAt = 0;
  private lastStaleWarnAt = 0;
  private cycles = 0;
  private eodDone = false;
  private eodDate = '';
  private handledExits = new Set<string>();
  private unsubBus: Array<() => void> = [];
  private tickMarkScheduled = false;
  readonly longOptionManager: LongOptionPositionManager;

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine, portfolio: PortfolioSource = new PaperPortfolioSource()) {
    this.client = client;
    this.market = market;
    this.risk = risk;
    this.portfolio = portfolio;
    this.longOptionManager = new LongOptionPositionManager(market, portfolio);
  }

  setAgent(agent: AgentOrchestrator): void {
    this.agent = agent;
  }

  setResearch(research: ResearchOrchestrator): void {
    this.research = research;
  }

  getScanner(): AdaptiveSupertrendScanner | null {
    return this.scanner;
  }

  setScanner(scanner: AdaptiveSupertrendScanner): void {
    this.scanner = scanner;
    eventBus.log('SYSTEM', 'Adaptive Supertrend scanner armed (1m/5m, naked ATM CE/PE)', 'adaptive_supertrend');
    void scanner.warmup();
  }

  setScalpScanner(scanner: ScalpScanner): void {
    this.scalpScanner = scanner;
    eventBus.log('SYSTEM', 'Scalp scanner armed (fee-aware momentum + delta/spread/IV gates)', 'scalp_scanner');
  }

  setScanEnabled(on: boolean): void {
    this.scanEnabled = on;
    eventBus.log('SYSTEM', `Autonomous market scanner ${on ? 'ENABLED' : 'DISABLED'}`, 'autonomy');
  }

  async start(): Promise<void> {
    this.eodDate = istNow().toISOString().slice(0, 10);
    this.eodDone = false;

    // EOD latch recovery: a crash after squareOffAll() ran but before
    // `eodDone = true` was set in memory (or a simple process restart
    // inside the 15:20–15:30 window) would re-run EOD square-off against
    // already-flat positions. The journal is the durable record of this
    // — an `eod` entry for today means square-off already fired. Read
    // it back on start so a restart never re-squares a flat book.
    // (Same epistemic posture as crossCheckJournalOnBoot: the journal is
    // an audit trail, not a source of truth — but for a one-shot daily
    // latch it IS the most authoritative record, since it's written
    // atomically with the square-off itself.)
    try {
      const todayEntries = journal.readTodayEntries(this.eodDate);
      const hasEodEntry = todayEntries.some((e) => e.kind === 'eod');
      if (hasEodEntry) {
        this.eodDone = true;
        eventBus.log('SYSTEM', `EOD latch recovered from journal — square-off already fired today (${this.eodDate}), will not re-fire`, 'autonomy');
      }
    } catch {
      // Journal read failure is non-fatal — fall through to default
      // (eodDone = false), which means square-off will run if the
      // window is open. Safe-side: prefer re-attempting a no-op close
      // over skipping a needed square-off.
    }

    this.unsubBus.push(eventBus.on('order', async (env) => {
      const p = env.payload || {};
      if (p.kind !== 'exit_signal') return;
      await this.handleExitSignal(p);
    }));

    // Mark-to-market + portfolio push on every live tick, not just the 2s
    // cycle below — position P&L should move the instant a real price does.
    // Coalesced: a burst of ticks across several instruments in the same
    // turn triggers one recompute, not N. The interval loop remains as a
    // fallback heartbeat (EOD/limits/scan still run on their own cadence).
    this.unsubBus.push(eventBus.on('tick', () => this.scheduleTickMark()));

    this.scheduleNext(1000);
    eventBus.log('SYSTEM', `Autonomy engine started (mode=${getTradingMode()}, EOD 15:20 IST, scanner=${this.scanEnabled})`, 'autonomy');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    eventBus.log('SYSTEM', `Autonomy engine ${on ? 'RESUMED' : 'PAUSED'} by control plane`, 'autonomy');
    eventBus.emit('system', { type: 'autonomy', enabled: on });
    if (on && !this.timer) this.scheduleNext(100);
  }

  isEnabled(): boolean { return this.enabled; }

  stats() {
    return {
      enabled: this.enabled,
      scanEnabled: this.scanEnabled,
      longOptionPolicyEnabled: this.longOptionManager.isEnabled(),
      cycles: this.cycles,
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastCycleAgoSec: this.lastCycleAt ? Math.round((Date.now() - this.lastCycleAt) / 1000) : null,
      eodDone: this.eodDone,
      clock: marketClock(),
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), delayMs);
  }

  private async cycle(): Promise<void> {
    if (this.running) { this.scheduleNext(2000); return; }
    this.running = true;
    try {
      const clock = marketClock();
      this.cycles++;
      this.lastCycleAt = Date.now();

      if (clock.istDate !== this.eodDate) {
        this.eodDate = clock.istDate;
        this.eodDone = false;
        // Roll the journal to a fresh per-day file too — without this a
        // process that stays up across midnight would keep appending
        // every subsequent day's entries into yesterday's file forever.
        journal.open(clock.istDate);
        eventBus.log('SYSTEM', `Journal rolled to new trading day: ${clock.istDate}`, 'autonomy');
      }

      if (this.enabled) {
        const mark = await this.portfolio.markToMarket((secId) => this.market.getFillablePrice(secId, { allowClosed: true, maxAgeMs: 60_000 }));
        if (clock.isMarketOpen && mark.staleCount > 0 && Date.now() - this.lastStaleWarnAt > 60_000) {
          this.lastStaleWarnAt = Date.now();
          eventBus.log('WARN', `${mark.staleCount} open position(s) marked from a stale price (no fresh quote in 60s)`, 'autonomy');
        }
        await this.longOptionManager.evaluate(clock.squareOffWindow);
        await this.reconcileMonitor();
        await this.reconcileUnmanagedLivePositions();
        await this.reconcileLedgerAgainstPostgres();
        await this.publishPortfolioSnapshot();
        await this.enforceStrategyLimits();

        if (clock.squareOffWindow && !this.eodDone && !this.risk.isKilled()) {
          await this.squareOffAll('EOD square-off window (15:20 IST)');
          this.eodDone = true;
        }

        await this.evaluateAutonomousScan(clock);
        if (this.scanner) await this.scanner.evaluate(clock);
        if (this.scalpScanner) await this.scalpScanner.evaluate(clock);
      }

      const nextDelay = clock.isMarketOpen ? 2000 : 30000;
      this.scheduleNext(nextDelay);
    } catch (e: any) {
      eventBus.log('ERROR', `Autonomy cycle error: ${e.message}`, 'autonomy');
      this.scheduleNext(5000);
    } finally {
      this.running = false;
    }
  }

  private async evaluateAutonomousScan(clock: ReturnType<typeof marketClock>): Promise<void> {
    if (!this.scanEnabled || !this.agent || !clock.isMarketOpen || clock.squareOffWindow) return;
    const bootGrace = Number(process.env.AUTONOMOUS_SCAN_BOOT_GRACE_MS ?? 45_000);
    if (Date.now() - this.bootedAt < bootGrace) return;
    const cooldown = Number(process.env.AUTONOMOUS_SCAN_INTERVAL_MS) || 180_000;
    if (Date.now() - this.lastScanAt < cooldown) return;

    const gate = this.risk.canTrade();
    if (!gate.allowed) return;

    // Skip heavy multi-index option chain pulls if circuit breakers are in error state
    const breakers = this.risk.snapshot().breakers || [];
    if (breakers.some((b) => b.state === 'ERROR')) return;

    // Portfolio-abstraction-aware — check real open position cap
    const positions = await this.portfolio.getPositions();
    if (positions.filter((p) => p.netQty !== 0).length >= MAX_CONCURRENT_POSITIONS) return;

    this.lastScanAt = Date.now();
    try {
      await this.agent.run('Autonomous options scan and execute across all watchlist indices (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, MIDCPNIFTY)', 'autonomous_scanner');
    } catch { /* agent busy or skipped */ }
  }

  private async handleExitSignal(p: any): Promise<void> {
    const key = `${p.positionId}_${p.reason}_${Math.floor(Date.now() / 60000)}`;
    if (this.handledExits.has(key)) return;
    this.handledExits.add(key);
    if (this.handledExits.size > 200) this.handledExits.clear();

    eventBus.log('WARN', `Exit signal (${p.reason}) for ${p.securityId}`, 'autonomy');
    try {
      const positions = await this.portfolio.getPositions();
      const pos = positions.find((x) => String(x.securityId) === String(p.securityId) && x.netQty !== 0);
      if (pos) {
        const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
        // A triggered stop (hard SL or trailing) crosses the spread on the
        // adverse move that fired it — priced with extra slippage vs. a
        // target hit or a manual close, which fill more like a resting order.
        const kind = p.reason === 'stop_loss' || p.reason === 'trailing_stop' ? 'STOP' : 'EXIT';
        const res = await this.portfolio.closePosition({ securityId: String(pos.securityId), exchangeSegment: pos.exchangeSegment }, ltp, kind);
        this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        eventBus.log('TRADE', `Auto-exit ${pos.tradingSymbol}: ${res.status} @ ₹${ltp} (${p.reason})`, 'autonomy');
        await closeParentStrategyIfFlat(pos.tradingSymbol, await this.portfolio.getPositions());
      }
    } catch (e: any) {
      eventBus.log('ERROR', `Auto-exit failed: ${e.message}`, 'autonomy');
    }
  }

  /**
   * Reconciles PositionMonitor's in-memory tracked set against the actual
   * open-position ledger, once per cycle. Two directions of drift, both
   * silent until now:
   *
   *  - Orphaned monitor entries: a tracked position with no matching open
   *    position (its close path failed to untrack it, or a bug elsewhere
   *    leaves it dangling). Left alone, RE-ENTERING the same security later
   *    would inherit the PREVIOUS trade's stop/target and could exit
   *    immediately at a price that has nothing to do with the new position.
   *  - Missing protection: an open position in the ledger with a
   *    stop/target/trailing-stop configured that ISN'T tracked (a restart
   *    that predates this reconciler, or a track() call that silently
   *    failed). Left alone, the position trades with no protection at all
   *    until a human notices.
   *
   * Every correction is logged AND alerted — drift here means the risk
   * layer was blind to something, which is exactly what should never pass
   * silently.
   */
  private async reconcileMonitor(): Promise<void> {
    const positions = await this.portfolio.getPositions();
    const open = new Map<string, any>();
    for (const p of positions) {
      if (p.netQty !== 0 && p.securityId && p.securityId !== '0') {
        open.set(`${p.exchangeSegment || 'NSE_FNO'}:${p.securityId}`, p);
      }
    }

    const tracked = this.market.monitor.tracked();
    for (const t of tracked) {
      const key = `${t.exchangeSegment}:${t.securityId}`;
      if (open.has(key)) continue;
      this.market.monitor.untrack(t.exchangeSegment, t.securityId);
      if (shouldEmitKeyedLog(`reconcile:untrack:${key}`, 300_000)) {
        eventBus.log('WARN', `Reconciler: untracked stale monitor entry ${key} — no matching open position`, 'autonomy');
        await pushAlert('WARN', 'autonomy', `Monitor/position drift corrected: untracked stale entry ${key}`);
      }
    }

    // Re-check after untracking above rather than reusing `tracked` — keeps
    // the two passes independent instead of assuming untrack() synchronously
    // affects a stale local list correctly (it does, but this is cheap and
    // makes that assumption unnecessary to reason about).
    const trackedKeys = new Set(this.market.monitor.tracked().map((t) => `${t.exchangeSegment}:${t.securityId}`));
    for (const [key, p] of open) {
      if (trackedKeys.has(key)) continue;
      if (!p.stopLoss && !p.target && !p.trailingStop) continue;
      this.market.monitor.track({
        securityId: String(p.securityId),
        exchangeSegment: p.exchangeSegment || 'NSE_FNO',
        quantity: p.netQty,
        entryPrice: p.netQty > 0 ? p.buyAvg : p.sellAvg,
        stopLoss: p.stopLoss ?? undefined,
        target: p.target ?? undefined,
        trail: toTrailConfig(p.trailingStop),
      });
      if (shouldEmitKeyedLog(`reconcile:rearm:${key}`, 300_000)) {
        eventBus.log('WARN', `Reconciler: re-armed missing protection for ${key}`, 'autonomy');
        await pushAlert('WARN', 'autonomy', `Monitor/position drift corrected: re-armed protection for ${key}`);
      }
    }
  }

  /**
   * Live-mode-only safety net, and the reason it's a SEPARATE pass from
   * reconcileMonitor above rather than a branch inside it: DhanHQ's
   * positions API never reports what stop-loss/target/trailing-stop a
   * position is SUPPOSED to have — unlike the paper ledger, which persists
   * those fields in Postgres, a broker position's stopLoss/target/
   * trailingStop (NormalizedPosition) are ALWAYS null (see
   * BrokerPortfolioSource's docstring). That means reconcileMonitor's
   * "untracked open position with nothing configured to re-arm → nothing to
   * do" branch is silently unreachable for every broker position — it can
   * never re-arm protection it has no way to know about, and would treat a
   * genuinely unmanaged live position exactly like an intentionally naked
   * paper leg.
   *
   * PositionMonitor's tracked set is this app's ENTIRE memory of which live
   * positions carry protection — track() is called exactly once, inline,
   * right after a live fill (see LiveExecutionEngine.placeOrder). So a
   * broker position this process isn't tracking is always one of two
   * things: this app placed it and then lost track (a crash mid-flow, a
   * bug), or it was opened by something entirely outside this app's control
   * (a manual trade, another process, a broker-side action). Either way,
   * real capital is exposed with NO stop-loss anywhere — the trading rules
   * this system operates under make that mandatory, not optional.
   *
   * There is no safe way to reconstruct a guessed stop-loss for it (e.g.
   * from the day's journal) — a reconstructed value could be stale, wrong,
   * or simply absent if the position predates this boot, and resuming
   * silent management on a guess is worse than stopping. So the only
   * correct response is to flatten it immediately and halt autonomous
   * trading for a human to review, exactly the "broker wins, square off the
   * difference, arm a sticky kill" contract this reconciler exists for.
   */
  private async reconcileUnmanagedLivePositions(): Promise<void> {
    if (this.portfolio.kind !== 'broker') return;

    const positions = await this.portfolio.getPositions();
    const trackedKeys = new Set(this.market.monitor.tracked().map((t) => `${t.exchangeSegment}:${t.securityId}`));

    for (const p of positions) {
      if (p.netQty === 0 || !p.securityId || p.securityId === '0') continue;
      if (isSandboxMode() && !this.portfolio.isOpenOnBroker(p)) continue;
      const key = `${p.exchangeSegment || 'NSE_FNO'}:${p.securityId}`;
      if (trackedKeys.has(key)) continue;
      if (this.longOptionManager.isEnabled() && this.longOptionManager.getState(p.tradingSymbol)) continue;

      const msg = `UNMANAGED LIVE POSITION: ${p.tradingSymbol} (${key}, netQty=${p.netQty}) is open at the broker with no stop-loss/target/trailing-stop tracked by this process. Flattening immediately and halting autonomous trading.`;
      eventBus.log('ERROR', msg, 'autonomy');
      await pushAlert('ERROR', 'autonomy', msg);
      journal.append('risk_decision', {
        rule: 'Unmanaged Live Position', from: 'OK', to: 'ERROR', current: `${key} netQty=${p.netQty}`,
        threshold: 'every open broker position must be tracked by PositionMonitor', action: 'Squared off and armed kill switch',
      });

      const closeResult = await this.portfolio.closePosition({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment }).catch((e: any) => ({ status: 'REJECTED' as const, reason: e.message }));
      eventBus.log(
        closeResult.status === 'TRADED' ? 'TRADE' : 'ERROR',
        `Unmanaged position square-off ${p.tradingSymbol}: ${closeResult.status}${closeResult.reason ? ` (${closeResult.reason})` : ''}`,
        'autonomy',
      );

      if (!this.risk.isKilled()) {
        await this.risk.armKillSwitch(`Unmanaged live position detected: ${p.tradingSymbol} (${key})`);
      }
    }
  }

  /**
   * Compares the in-memory ledger (the read path every position/wallet
   * query goes through) against what's actually durable in Postgres, once
   * a minute — a handful of indexed queries, not worth running every 2s
   * cycle. They're expected to always agree; a mismatch means a write
   * silently diverged (a commit that appeared to fail but partially
   * applied, a manual SQL change, a future bug that updates one store and
   * not the other). Postgres is the durable source of truth, so every
   * correction pulls mem back in line with it — consistent with the
   * monitor/position reconciler above: auto-correct AND alert loudly,
   * never silently.
   */
  private async reconcileLedgerAgainstPostgres(): Promise<void> {
    // In-memory-vs-Postgres drift only exists for the paper ledger — broker
    // mode has no local mem mirror to drift from Postgres, it reads the
    // account straight from DhanHQ on every poll. (The equivalent check for
    // broker mode — local book vs the actual broker book — is a separate,
    // not-yet-built reconciler; see PortfolioSource's docstring.)
    if (this.portfolio.kind !== 'paper') return;
    if (Date.now() - this.lastLedgerCheckAt < 60_000) return;
    this.lastLedgerCheckAt = Date.now();

    const report = await reconcileLedger();
    if (report.ok) return;

    const summary = [
      ...report.mismatches.map((m) => `${m.subject}.${m.field}: mem=${m.mem} pg=${m.postgres}`),
      ...report.missingInPostgres.map((s) => `${s}: open in mem, no Postgres row`),
      ...report.missingInMem.map((s) => `${s}: open in Postgres, missing from mem`),
    ].join('; ');

    eventBus.log('ERROR', `Ledger drift detected — correcting mem from Postgres: ${summary}`, 'autonomy');
    await pushAlert('ERROR', 'autonomy', `Ledger drift corrected (Postgres wins): ${summary}`);
    journal.append('risk_decision', { rule: 'Ledger Consistency', from: 'OK', to: 'ERROR', current: summary, threshold: 'mem === postgres', action: 'Corrected mem from Postgres' });

    await correctLedgerFromPostgres(report);
    await this.publishPortfolioSnapshot();
  }

  private async publishPortfolioSnapshot(): Promise<void> {
    try {
      const [positions, wallet] = await Promise.all([this.portfolio.getPositions(), this.portfolio.getWallet()]);
      eventBus.emit('portfolio', { positions, funds: wallet, markedAt: Date.now() });
    } catch { /* snapshot failure is non-fatal */ }
  }

  private scheduleTickMark(): void {
    if (this.tickMarkScheduled || !this.enabled) return;
    this.tickMarkScheduled = true;
    // queueMicrotask (see riskEngine.scheduleTickEvaluate for the why):
    // coalesce a burst of ticks into one markToMarket+snapshot run within
    // the current event-loop turn, rather than running once per tick.
    queueMicrotask(async () => {
      this.tickMarkScheduled = false;
      try {
        // this.portfolio.markToMarket() already calls markPositionsToMarket()
        // internally in paper mode (PaperPortfolioSource delegates there) —
        // a second direct call here duplicated that work in paper mode and,
        // in broker mode, marked an irrelevant/empty paper position set
        // instead of anything the portfolio abstraction already covers.
        await this.portfolio.markToMarket((secId) => this.market.getFillablePrice(secId, { allowClosed: true, maxAgeMs: 60_000 }));
        await this.publishPortfolioSnapshot();
      } catch { /* the 2s cycle below is the fallback */ }
    });
  }

  private async enforceStrategyLimits(): Promise<void> {
    const limit = this.risk.getLimits().perStrategyLossLimit;
    const strategies = await listPaperStrategies();
    const positions = await this.portfolio.getPositions();
    const posMap = new Map(positions.map((p) => [p.tradingSymbol, p]));

    for (const strat of strategies) {
      if (strat.status !== 'RUNNING') continue;
      let pnl = 0;
      for (const leg of strat.legs || []) {
        const pos = posMap.get(leg.instrument);
        if (pos) pnl += Number(pos.realizedProfit || 0) + Number(pos.unrealizedProfit || 0);
      }
      if (pnl <= -limit) {
        eventBus.log('WARN', `Strategy ${strat.name} loss limit breached (₹${pnl} ≤ -₹${limit})`, 'autonomy');
        await this.closeStrategyLegs(strat, positions);
        await updatePaperStrategyStatus(strat.id, 'STOPPED');
        await this.publishPortfolioSnapshot();
      }
    }
  }

  private async closeStrategyLegs(strat: any, positions: any[]): Promise<void> {
    for (const leg of strat.legs || []) {
      const pos = positions.find((p) => p.tradingSymbol === leg.instrument);
      if (pos && pos.netQty !== 0) {
        const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
        await this.portfolio.closePosition({ securityId: String(leg.securityId || pos.securityId), exchangeSegment: leg.exchangeSegment || pos.exchangeSegment }, ltp).catch(() => {});
        this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      }
    }
  }

  async squareOffAll(reason: string): Promise<number> {
    eventBus.log('WARN', `Square-off triggered: ${reason}`, 'autonomy');
    const positions = await this.portfolio.getPositions();
    let closed = 0;
    for (const pos of positions) {
      if (pos.netQty === 0) continue;
      const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
      await this.portfolio.closePosition({ securityId: String(pos.securityId), exchangeSegment: pos.exchangeSegment }, ltp).catch(() => {});
      this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      closed++;
    }
    for (const s of await listPaperStrategies()) {
      if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
    }
    eventBus.log('TRADE', `Square-off complete: ${closed} position(s) closed`, 'autonomy');
    journal.append('eod', { reason, closed });
    await this.publishPortfolioSnapshot();
    return closed;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubBus.forEach((u) => u());
  }
}
