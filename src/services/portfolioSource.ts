import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { InstrumentKey } from '../lib/instrumentKey';
import { isValidSecurityId, keysMatch, toInstrumentKey } from '../lib/instrumentKey';
import { eventBus } from './eventBus';
import { journal } from './journal';
import type { FillKind } from './fillModel';
import { redisPublisher } from '../auth';
import {
  listPaperPositions, getPaperWallet, markPositionsToMarket,
  closePaperPosition, closeAllPaperPositions, getTodayOrderStats as getPaperTodayOrderStats,
  pushAlert,
} from '../db';
import { marketClock } from './marketHours';
import { buildSandboxPlaceRequest, roundToTick } from './sandboxInstruments';
import { INDEX_INSTRUMENTS } from './marketData';
import { parseOptionSymbol } from './optionsAnalytics';
import { resolveNearestExpiry } from './strategyConstructor';
import { shouldEmitKeyedLog } from '../lib/logPolicy';
import {
  clearDhanRateLimit, isDhanRateLimited, isRateLimitError, noteDhanRateLimit,
} from '../lib/dhanRateLimit';
import { brokerJournalMode } from '../lib/tradingMode';

/**
 * Normalizes RiskEngine's and AutonomyEngine's view of "the account" across
 * paper and live trading modes, closing the gap named LIVE-01: before this
 * abstraction existed, both engines called the paper db.ts functions
 * UNCONDITIONALLY regardless of TRADING_MODE — in live mode the daily-loss
 * breaker read an empty paper wallet (₹0), EOD square-off closed paper
 * positions while real ones stayed open, and the kill switch's
 * "positions closed" count was fabricated from an empty paper book. That is
 * why core.ts refuses to boot in live mode until this exists.
 *
 * NormalizedPosition mirrors the DhanHQ v2 PositionResponse field names
 * (buyQty/buyAvg/sellQty/sellAvg/netQty/realizedProfit/unrealizedProfit) —
 * the paper engine's own shape was already modelled on it, so both sources
 * produce the same shape with no lossy translation either direction.
 *
 * IMPORTANT — broker P&L semantics are asserted from the SDK's TYPE
 * DECLARATIONS, not verified against a live DhanHQ account (this
 * environment has no broker credentials or market access to confirm real
 * runtime behavior). Two assumptions a reviewer with real account access
 * should verify before this runs against real capital:
 *   1. That a position flattened intraday still appears in
 *      positions.list() with netQty=0 and realizedProfit populated for the
 *      rest of the trading day (this is standard broker behavior and is
 *      how the paper engine's own mem.positions already works, but it is
 *      NOT independently confirmed against DhanHQ specifically here).
 *   2. That FundLimitResponse.utilizedAmount is a fair stand-in for
 *      "margin currently blocked" for the daily-loss/margin-utilization
 *      breakers — DhanHQ's fund-limit endpoint does not report a
 *      dedicated realized-P&L figure, so session P&L for live mode is
 *      DERIVED by summing positions[].realizedProfit, not read from a
 *      single authoritative field the way the paper wallet's
 *      session_realized_base is.
 */

export interface NormalizedPosition {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  buyQty: number;
  buyAvg: number;
  sellQty: number;
  sellAvg: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
  pnl: number;
  costPrice: number;
  ltp: number;
  marginBlocked: number;
  stopLoss: number | null;
  target: number | null;
  trailingStop: number | null;
  /** Sourced from DhanHQ's own drvStrikePrice/drvOptionType (broker mode
   * only — paper positions leave these null; consumers needing an option's
   * strike/side fall back to parsing the synthesized tradingSymbol, which
   * only paper mode's format supports). Prefer these over parsing
   * tradingSymbol wherever available: a real DhanHQ trading symbol's exact
   * string format is not the synthesized "<UNDERLYING><STRIKE><CE|PE>"
   * shape the paper engine invents, so a regex built for the latter
   * silently matches nothing against a real broker symbol. */
  strike: number | null;
  optionType: 'CALL' | 'PUT' | null;
}

export interface WalletSnapshot {
  availableMargin: number;
  usedMargin: number;
  realizedPnl: number;
  sessionRealizedPnl: number;
  unrealizedPnl: number;
  totalCharges: number;
  netRealizedPnl: number;
  totalBalance: number;
  equity: number;
}

export interface CloseResult {
  status: 'TRADED' | 'REJECTED' | 'noop';
  symbol?: string;
  orderId?: string;
  fillPrice?: number;
  reason?: string;
  [key: string]: any;
}

export type LtpResolver = (securityId: string, symbol: string) => number | null;

const resolvedSecurityIdBySymbol = new Map<string, string>();

function resolutionCacheKey(pos: Pick<NormalizedPosition, 'tradingSymbol' | 'exchangeSegment'>): string {
  return `${pos.exchangeSegment}:${String(pos.tradingSymbol).toUpperCase()}`;
}

/** Resolves a missing/placeholder securityId from strike + option type, using
 * the live option chain when broker positions only carry a synthesized symbol. */
export async function resolvePositionSecurityId(
  client: DhanClient,
  pos: Pick<NormalizedPosition, 'tradingSymbol' | 'securityId' | 'exchangeSegment' | 'strike' | 'optionType'>,
  opts: { rateLimited?: () => boolean } = {},
): Promise<string | null> {
  if (isValidSecurityId(pos.securityId)) return String(pos.securityId);
  if (opts.rateLimited?.()) return null;

  const cacheKey = resolutionCacheKey(pos);
  const cached = resolvedSecurityIdBySymbol.get(cacheKey);
  if (cached) return cached;

  let underlying: string | null = null;
  let strike = pos.strike;
  let optType = pos.optionType;
  const parsed = parseOptionSymbol(pos.tradingSymbol);
  if (parsed) {
    underlying = parsed.underlying;
    strike ??= parsed.strike;
    optType ??= parsed.type;
  }
  const index = underlying ? INDEX_INSTRUMENTS[underlying] : null;
  if (!index || strike == null || !optType || !underlying) return null;

  const expiry = await resolveNearestExpiry(client, underlying);
  const chain = await client.optionChain?.fetchNormalized?.({
    underlyingScrip: Number(index.securityId),
    underlyingSeg: 'IDX_I',
    expiry,
  }).catch(() => null);
  const row = chain?.strikes?.find((r: any) => Number(r.strike) === strike);
  if (!row) return null;
  const leg = optType === 'CALL' ? (row as any).call ?? (row as any).ce : (row as any).put ?? (row as any).pe;
  const secId = leg?.securityId;
  if (!secId) return null;
  const resolved = String(secId);
  resolvedSecurityIdBySymbol.set(cacheKey, resolved);
  return resolved;
}

export interface OrderFlowStats {
  total: number;
  filled: number;
  rejected: number;
  consecutiveLosses: number;
}

export interface PortfolioSource {
  readonly kind: 'paper' | 'broker';
  getPositions(): Promise<NormalizedPosition[]>;
  getWallet(): Promise<WalletSnapshot>;
  /** Feeds the Order Rejection Rate and Consecutive Losses breakers. Paper
   * already derives this from db.ts's own order log — PaperPortfolioSource
   * delegates there. Broker mode has no equivalent server-side report
   * (DhanHQ's position/funds APIs don't track "was my last order
   * rejected" or a loss streak), so BrokerPortfolioSource builds its own:
   * recordOrderOutcome() (called by LiveExecutionEngine) tallies total/
   * rejected directly, and consecutiveLosses is inferred by diffing
   * realizedProfit across successive position polls — see its docstring
   * for the disclosed limitation that gives it. */
  getTodayOrderStats(): Promise<OrderFlowStats>;
  recordOrderOutcome(outcome: { status: 'TRADED' | 'REJECTED' }): void;
  /** Paper: marks open positions from live ticks. Broker: the account's
   * own unrealizedProfit is already server-computed from real prices, so
   * this just forces a fresh poll rather than doing any local math. */
  markToMarket(ltpResolver: LtpResolver): Promise<{ totalUnrealized: number; staleCount: number }>;
  closePosition(key: InstrumentKey, priceHint?: number, kind?: FillKind, quantity?: number, tradingSymbol?: string): Promise<CloseResult>;
  closeAll(ltpResolver: LtpResolver): Promise<CloseResult[]>;
  /** True when this leg is open on the real broker account (not paper-ledger only). */
  isOpenOnBroker(pos: Pick<NormalizedPosition, 'tradingSymbol' | 'securityId' | 'exchangeSegment'>): boolean;
  /** Forces the next read to bypass any internal cache. Paper mode's mem
   * reads are always current, so this is a no-op there; BrokerPortfolioSource
   * uses it to force a fresh poll right after a fill changes the account —
   * see its own docstring for why that matters. */
  invalidate(): void;
}

// ── paper ────────────────────────────────────────────────────────────────

/** Thin wrapper over the existing db.ts paper functions — zero behavior
 * change versus calling them directly, which is what every caller did
 * before this abstraction existed. */
export class PaperPortfolioSource implements PortfolioSource {
  readonly kind = 'paper' as const;

  async getPositions(): Promise<NormalizedPosition[]> {
    return listPaperPositions() as unknown as Promise<NormalizedPosition[]>;
  }

  async getWallet(): Promise<WalletSnapshot> {
    return getPaperWallet();
  }

  async getTodayOrderStats(): Promise<OrderFlowStats> {
    return getPaperTodayOrderStats();
  }

  /** No-op: db.ts's executePaperOrder already writes every fill/rejection
   * to mem.orders itself — getTodayOrderStats() reads that directly, so
   * paper mode has nothing extra to record here. */
  recordOrderOutcome(): void { /* see docstring */ }

  async markToMarket(ltpResolver: LtpResolver) {
    return markPositionsToMarket(ltpResolver);
  }

  async closePosition(key: InstrumentKey, priceHint?: number, kind?: FillKind, _quantity?: number, tradingSymbol?: string): Promise<CloseResult> {
    const target = !isValidSecurityId(key.securityId) && tradingSymbol ? tradingSymbol : key;
    return closePaperPosition(target, priceHint, undefined, kind) as unknown as Promise<CloseResult>;
  }

  async closeAll(ltpResolver: LtpResolver): Promise<CloseResult[]> {
    return closeAllPaperPositions(ltpResolver) as unknown as Promise<CloseResult[]>;
  }

  isOpenOnBroker(_pos: Pick<NormalizedPosition, 'tradingSymbol' | 'securityId' | 'exchangeSegment'>): boolean {
    return false;
  }

  /** No-op: mem is always current, there is no cache to invalidate. */
  invalidate(): void { /* see docstring */ }
}

// ── broker ───────────────────────────────────────────────────────────────

function normalizeBrokerPosition(p: any): NormalizedPosition {
  const netQty = Number(p.netQty ?? 0);
  const buyAvg = Number(p.buyAvg ?? 0);
  const sellAvg = Number(p.sellAvg ?? 0);
  const realized = Number(p.realizedProfit ?? 0);
  const unrealized = Number(p.unrealizedProfit ?? 0);
  return {
    tradingSymbol: String(p.tradingSymbol ?? '').toUpperCase(),
    securityId: String(p.securityId ?? '0'),
    exchangeSegment: String(p.exchangeSegment ?? 'NSE_FNO'),
    productType: String(p.productType ?? 'INTRADAY'),
    buyQty: Number(p.buyQty ?? 0),
    buyAvg,
    sellQty: Number(p.sellQty ?? 0),
    sellAvg,
    netQty,
    realizedProfit: realized,
    unrealizedProfit: unrealized,
    pnl: realized + unrealized,
    costPrice: Number(p.costPrice ?? (netQty >= 0 ? buyAvg : sellAvg)),
    // DhanHQ's PositionResponse doesn't carry a live LTP field directly —
    // it's derived from cost + unrealized/netQty, the same relationship
    // the paper engine's own listPaperPositions() uses.
    ltp: netQty !== 0 ? Number((netQty > 0 ? buyAvg : sellAvg) + unrealized / netQty).valueOf() : Number(p.costPrice ?? 0),
    marginBlocked: 0, // not reported per-position by DhanHQ; wallet-level utilizedAmount covers the breaker's actual need
    // DhanHQ positions carry no local stop/target/trailing-stop config —
    // that protection lives entirely in PositionMonitor for both modes.
    stopLoss: null,
    target: null,
    trailingStop: null,
    strike: p.drvStrikePrice != null ? Number(p.drvStrikePrice) : null,
    optionType: p.drvOptionType === 'CALL' || p.drvOptionType === 'PUT' ? p.drvOptionType : null,
  };
}

function emptyWallet(): WalletSnapshot {
  return { availableMargin: 0, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0, unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 0, equity: 0 };
}

/**
 * Polls the real DhanHQ account on a fixed cadence (default 3s — the same
 * order of magnitude as the market-data REST fallback poll elsewhere in
 * this codebase) rather than on every caller, since RiskEngine.evaluate()
 * runs on every tick/fill plus a 5s timer and would otherwise hammer the
 * account/positions endpoints far past any sane rate limit. Concurrent
 * callers during a poll share the one in-flight request rather than each
 * starting their own.
 *
 * A failed poll serves the last-known snapshot rather than throwing —
 * matching the read-degrades-gracefully posture of getFillablePrice() and
 * the REST market-data fallback — and marks `degraded` so a caller that
 * cares (the broker reconciler, /api/health) can tell freshness from
 * failure.
 */
export class BrokerPortfolioSource implements PortfolioSource {
  readonly kind = 'broker' as const;
  private client: DhanClient;
  private pollIntervalMs: number;
  private cachedPositions: NormalizedPosition[] = [];
  private cachedWallet: WalletSnapshot = emptyWallet();
  // lastPollAt: last SUCCESSFUL refresh (what isDegraded()/lastPolledAt()
  // report freshness against). lastAttemptAt: last time a poll was
  // ATTEMPTED, successful or not — this is what ensureFresh() throttles on.
  // Splitting these matters: a broker outage or a 429 would otherwise leave
  // lastPollAt frozen at its last success forever, permanently defeating the
  // throttle (Date.now() - lastPollAt < pollIntervalMs never re-becomes
  // true) and turning every subsequent tick into a fresh positions.list()/
  // funds.getLimit() call — exactly the hammering this class exists to
  // prevent, and self-sustaining under a rate limit.
  private lastPollAt = 0;
  private lastAttemptAt = 0;
  private pollPromise: Promise<void> | null = null;
  private degraded = false;

  // Order-flow tracking (see PortfolioSource.getTodayOrderStats docstring):
  // total/rejected come from recordOrderOutcome() calls the execution
  // engine makes directly; consecutiveLosses is INFERRED by diffing
  // realizedProfit across successive polls, since DhanHQ's APIs report
  // position state, not a fill-by-fill P&L history. Day-scoped like every
  // other session figure in this codebase.
  private statsDate = '';
  private orderTotal = 0;
  private orderRejected = 0;
  private consecutiveLosses = 0;
  private realizedProfitBySymbol = new Map<string, number>();
  private closeBlockedUntil = new Map<string, number>();

  constructor(client: DhanClient, pollIntervalMs = 3000) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
  }

  private rollStatsIfNewDay(): void {
    const today = marketClock().istDate;
    if (this.statsDate === today) return;
    this.statsDate = today;
    this.orderTotal = 0;
    this.orderRejected = 0;
    this.consecutiveLosses = 0;
    // Deliberately NOT cleared: realizedProfitBySymbol. A position carried
    // over a day boundary still needs its LAST KNOWN realizedProfit as the
    // diff baseline for the next poll — clearing it would read the
    // position's entire multi-day realized total as "since the last poll"
    // on the first poll of the new day, one giant false loss/gain signal.
  }

  isDegraded(): boolean { return this.degraded; }
  lastPolledAt(): number { return this.lastPollAt; }

  /** Forces the NEXT read to poll rather than serve the cache, regardless
   * of how recently the last poll ran. Used right after a live fill: the
   * cached snapshot from before the fill doesn't yet contain the new/
   * changed position, and reconcileMonitor/reconcileUnmanagedLivePositions
   * (autonomy.ts) would otherwise judge PositionMonitor's already-updated
   * tracked set against that stale snapshot and "correct" a position that
   * is not actually orphaned — untracking it, then on the following cycle
   * flattening it and arming the kill switch as an "unmanaged" position. */
  invalidate(): void {
    this.lastAttemptAt = 0;
  }

  private async ensureFresh(force = false): Promise<void> {
    if (this.isBrokerRateLimited()) return;
    // Checked BEFORE the throttle: poll() sets lastAttemptAt synchronously
    // as its very first statement, so a concurrent caller arriving while a
    // poll is already in flight would otherwise see "an attempt just
    // started" and bail out early serving the STALE pre-poll cache, instead
    // of dedup-ing onto the in-flight request like it's supposed to.
    if (this.pollPromise) return this.pollPromise;
    if (!force && Date.now() - this.lastAttemptAt < this.effectivePollIntervalMs()) return;
    this.pollPromise = this.poll().finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  private effectivePollIntervalMs(): number {
    if (this.brokerMode() !== 'sandbox') return this.pollIntervalMs;
    const brokerOpen = this.cachedPositions.filter((p) => p.netQty !== 0);
    if (brokerOpen.length === 0) return Math.max(this.pollIntervalMs, 30_000);
    return this.pollIntervalMs;
  }

  private isBrokerRateLimited(): boolean {
    return isDhanRateLimited();
  }

  private noteBrokerRateLimit(err?: { message?: string; retryAfterMs?: number }): void {
    noteDhanRateLimit(err, (msg) => eventBus.log('WARN', msg, 'portfolio_source'));
  }

  private clearBrokerRateLimit(): void {
    clearDhanRateLimit();
  }

  private async maybeRefreshBrokerSnapshot(force = false): Promise<void> {
    if (this.isBrokerRateLimited()) return;
    await this.ensureFresh(force);
  }

  private async poll(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const [positionsRes, fundsRes] = await Promise.all([
        this.client.positions.list(),
        this.client.funds.getLimit(),
      ]);
      const positions = (positionsRes || []).map(normalizeBrokerPosition);
      this.detectClosesFromRealizedDiff(positions);
      const sessionRealizedPnl = positions.reduce((s, p) => s + p.realizedProfit, 0);
      const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedProfit, 0);
      const availableMargin = Number((fundsRes as any)?.availabelBalance ?? 0);
      const usedMargin = Number((fundsRes as any)?.utilizedAmount ?? 0);
      this.cachedPositions = positions;
      this.cachedWallet = {
        availableMargin,
        usedMargin,
        // Live mode has no separate "lifetime" realized figure the way the
        // paper wallet does (initial_balance + accumulated realized_pnl) —
        // DhanHQ reports account balance, not a running P&L ledger. Both
        // fields report the same session-derived number here; a caller
        // wanting genuine lifetime P&L in live mode needs the broker's
        // ledger/statement API, out of scope for the risk gate's needs.
        realizedPnl: sessionRealizedPnl,
        sessionRealizedPnl,
        unrealizedPnl,
        totalCharges: 0, // not separately reported by getLimit(); charges are already netted into realizedProfit
        netRealizedPnl: sessionRealizedPnl,
        totalBalance: availableMargin + usedMargin,
        equity: Number((availableMargin + usedMargin + unrealizedPnl).toFixed(2)),
      };
      this.lastPollAt = Date.now();
      this.degraded = false;
      this.clearBrokerRateLimit();
      if (this.brokerMode() === 'sandbox') await this.checkMarginDrift();
    } catch (e: any) {
      this.degraded = true;
      const msg = String(e?.message || e);
      if (isRateLimitError(msg)) {
        this.noteBrokerRateLimit(e);
      } else if (shouldEmitKeyedLog('portfolio_source:poll_failed', 60_000)) {
        eventBus.log('WARN', `Broker portfolio poll failed: ${msg} — serving last-known snapshot`, 'portfolio_source');
      }
    }
  }

  /** Sandbox margin can go stuck-blocked behind orders that never resolve
   * (DhanHQ's sandbox OMS leaving them in TRANSIT indefinitely) with zero
   * matching positions anywhere — the dashboard would otherwise just show a
   * confusing "margin used, no positions" split with no explanation. Throttled
   * heavily since it costs an extra orders.list() call the normal poll
   * doesn't need. */
  private async checkMarginDrift(): Promise<void> {
    if (!shouldEmitKeyedLog('portfolio_source:margin_drift_check', 5 * 60_000)) return;
    const paperWallet = await getPaperWallet().catch(() => null);
    if (!paperWallet) return;
    const drift = Number((this.cachedWallet.usedMargin - paperWallet.usedMargin).toFixed(2));
    if (drift <= 100) return;
    const pending = await listPendingBrokerOrders(this.client).catch(() => []);
    await pushAlert('WARN', 'portfolio_source', `Sandbox margin drift (current ₹${drift.toLocaleString('en-IN')} blocked, 0 tracked positions, ${pending.length} pending order(s)) — see /api/portfolio/margin/reconcile`);
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    await this.ensureFresh();
    if (this.brokerMode() === 'sandbox') return this.mergeSandboxPositions();
    return this.cachedPositions;
  }

  /** Sandbox reads broker funds/positions but stores SL/target on the paper
   * ledger. Merging both avoids reconcileMonitor seeing a tracked monitor
   * entry with "no matching open position" when broker and paper disagree. */
  private async mergeSandboxPositions(): Promise<NormalizedPosition[]> {
    const paper = (await listPaperPositions()).filter((p) => p.netQty !== 0);
    const brokerOpen = this.cachedPositions.filter((p) => p.netQty !== 0);
    if (brokerOpen.length === 0) return paper as unknown as NormalizedPosition[];
    const byKey = new Map(brokerOpen.map((p) => [`${p.exchangeSegment}:${p.securityId}`, { ...p }]));
    for (const pp of paper) {
      const key = `${pp.exchangeSegment || 'NSE_FNO'}:${pp.securityId}`;
      const existing = byKey.get(key);
      if (existing) {
        if (pp.stopLoss != null) existing.stopLoss = pp.stopLoss;
        if (pp.target != null) existing.target = pp.target;
        if (pp.trailingStop != null) existing.trailingStop = pp.trailingStop;
      } else {
        byKey.set(key, pp as unknown as NormalizedPosition);
      }
    }
    return [...byKey.values()];
  }

  async getWallet(): Promise<WalletSnapshot> {
    await this.ensureFresh();
    if (this.brokerMode() !== 'sandbox') return this.cachedWallet;
    return this.withSandboxPaperWallet(this.cachedWallet);
  }

  /** Sandbox fills land at Dhan *and* on the local paper ledger. When the
   * local book still has open legs the broker API has never seen (429
   * rejects, restarts, paper-only closes), margin and net-worth must follow
   * the paper wallet — not the broker's empty ₹50k sandbox allocation. */
  private async withSandboxPaperWallet(brokerWallet: WalletSnapshot): Promise<WalletSnapshot> {
    const paperOpen = (await listPaperPositions()).filter((p) => Number(p.netQty ?? 0) !== 0);
    if (paperOpen.length === 0) return brokerWallet;
    const paperWallet = await getPaperWallet().catch(() => null);
    if (!paperWallet) return brokerWallet;
    return {
      ...brokerWallet,
      availableMargin: Number(paperWallet.availableMargin),
      usedMargin: Number(paperWallet.usedMargin),
      totalBalance: Number(paperWallet.totalBalance),
      realizedPnl: Number(paperWallet.realizedPnl ?? paperWallet.sessionRealizedPnl ?? 0),
      sessionRealizedPnl: Number(paperWallet.sessionRealizedPnl ?? paperWallet.realizedPnl ?? 0),
      netRealizedPnl: Number(paperWallet.netRealizedPnl ?? paperWallet.sessionRealizedPnl ?? 0),
      totalCharges: Number(paperWallet.totalCharges ?? 0),
      unrealizedPnl: Number(paperWallet.unrealizedPnl ?? brokerWallet.unrealizedPnl),
      equity: Number(paperWallet.equity ?? brokerWallet.equity),
    };
  }

  /** Compares this poll's realizedProfit per symbol against the last poll's
   * to infer a close that happened between them, incrementing or resetting
   * the consecutive-loss streak. DISCLOSED LIMITATION: this only detects
   * closes at POLL granularity (default 3s) — two losing closes inside the
   * same poll window are indistinguishable from one, and their combined
   * realized delta is still correctly negative, so this under-counts the
   * NUMBER of losses in that rare case without misjudging their direction. */
  private detectClosesFromRealizedDiff(positions: NormalizedPosition[]): void {
    this.rollStatsIfNewDay();
    for (const p of positions) {
      const prev = this.realizedProfitBySymbol.get(p.tradingSymbol);
      if (prev !== undefined) {
        const delta = p.realizedProfit - prev;
        if (delta < 0) this.consecutiveLosses++;
        else if (delta > 0) this.consecutiveLosses = 0;
        // delta === 0: nothing closed since the last poll — streak unchanged.
      }
      this.realizedProfitBySymbol.set(p.tradingSymbol, p.realizedProfit);
    }
  }

  async getTodayOrderStats(): Promise<OrderFlowStats> {
    this.rollStatsIfNewDay();
    return {
      total: this.orderTotal,
      filled: this.orderTotal - this.orderRejected,
      rejected: this.orderRejected,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  /** Called by LiveExecutionEngine right after every order outcome —
   * DhanHQ's account APIs report position/fund STATE, not a log of this
   * app's own order attempts, so nothing else can build the rejection-rate
   * breaker's input in live mode. */
  recordOrderOutcome(outcome: { status: 'TRADED' | 'REJECTED' }): void {
    this.rollStatsIfNewDay();
    this.orderTotal++;
    if (outcome.status === 'REJECTED') this.orderRejected++;
  }

  async markToMarket(ltpResolver: LtpResolver): Promise<{ totalUnrealized: number; staleCount: number }> {
    if (this.brokerMode() === 'sandbox') {
      const mark = await markPositionsToMarket(ltpResolver);
      await this.maybeRefreshBrokerSnapshot(false);
      const brokerOpen = this.cachedPositions.filter((p) => p.netQty !== 0);
      const paperOpen = (await listPaperPositions()).filter((p) => Number(p.netQty ?? 0) !== 0);
      if (brokerOpen.length === 0 && paperOpen.length > 0) {
        const paperWallet = await getPaperWallet().catch(() => null);
        if (paperWallet) {
          this.cachedWallet.usedMargin = Number(paperWallet.usedMargin);
          this.cachedWallet.availableMargin = Number(paperWallet.availableMargin);
          this.cachedWallet.totalBalance = Number(paperWallet.totalBalance);
        }
      }
      this.cachedWallet.unrealizedPnl = mark.totalUnrealized;
      this.cachedWallet.equity = Number((this.cachedWallet.totalBalance + mark.totalUnrealized).toFixed(2));
      return mark;
    }
    await this.ensureFresh();
    return { totalUnrealized: this.cachedWallet.unrealizedPnl, staleCount: this.degraded ? this.cachedPositions.length : 0 };
  }

  private async findOpenPosition(key: InstrumentKey, tradingSymbol?: string): Promise<NormalizedPosition | undefined> {
    const positions = await this.getPositions();
    const byKey = positions.find((p) => p.netQty !== 0 && keysMatch(toInstrumentKey(p), key));
    if (byKey) return byKey;
    if (!tradingSymbol) return undefined;
    const sym = tradingSymbol.toUpperCase();
    return positions.find((p) => p.netQty !== 0 && p.tradingSymbol.toUpperCase() === sym);
  }

  isOpenOnBroker(pos: NormalizedPosition): boolean {
    return this.isBrokerOpen(pos);
  }

  private isBrokerOpen(pos: NormalizedPosition): boolean {
    const sym = pos.tradingSymbol.toUpperCase();
    return this.cachedPositions.some(
      (p) => p.netQty !== 0 && (
        keysMatch(toInstrumentKey(p), toInstrumentKey(pos)) || p.tradingSymbol.toUpperCase() === sym
      ),
    );
  }

  private isCloseRateLimited(symbol: string): boolean {
    return Date.now() < (this.closeBlockedUntil.get(symbol.toUpperCase()) ?? 0);
  }

  private noteCloseRateLimit(symbol: string): void {
    this.closeBlockedUntil.set(symbol.toUpperCase(), Date.now() + 60_000);
  }

  private async closeSandboxPaperOnly(pos: NormalizedPosition, reason: string): Promise<CloseResult> {
    const fallbackPrice = pos.costPrice || pos.buyAvg || pos.sellAvg || 100;
    const limitPrice = roundToTick(pos.ltp > 0 ? pos.ltp : fallbackPrice, 5);
    const paperClose = await closePaperPosition(pos.tradingSymbol, limitPrice, async () => 0, 'EXIT');
    if (paperClose.status !== 'TRADED') {
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: paperClose.message || 'Paper close failed' };
    }
    eventBus.log('TRADE', `Sandbox paper close ${pos.tradingSymbol} (${reason})`, 'portfolio_source');
    return { status: 'TRADED', symbol: pos.tradingSymbol, fillPrice: paperClose.fillPrice };
  }

  private async resolvePositionForClose(pos: NormalizedPosition): Promise<NormalizedPosition> {
    if (isValidSecurityId(pos.securityId)) return pos;
    const resolved = await resolvePositionSecurityId(this.client, pos, { rateLimited: () => this.isBrokerRateLimited() });
    return resolved ? { ...pos, securityId: resolved } : pos;
  }

  /** Places a REAL reversing MARKET order — no priceHint/kind: a market
   * order lets the broker fill at its own best price, which is more
   * correct for real capital than forcing a specific price the way the
   * paper fill model does. */
  private brokerMode(): 'sandbox' | 'live' {
    return brokerJournalMode();
  }

  private async reversePosition(pos: NormalizedPosition, reason: string, quantity?: number): Promise<CloseResult> {
    const mode = this.brokerMode();
    if (this.isCloseRateLimited(pos.tradingSymbol)) {
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: 'Close cooling down after rate limit — retry shortly' };
    }
    if (mode === 'sandbox' && !this.isBrokerOpen(pos)) {
      return this.closeSandboxPaperOnly(pos, reason);
    }

    const transactionType = pos.netQty > 0 ? 'SELL' : 'BUY';
    const qty = Math.min(quantity ?? Math.abs(pos.netQty), Math.abs(pos.netQty));
    const fallbackPrice = pos.costPrice || pos.buyAvg || pos.sellAvg || 100;
    const limitPrice = roundToTick(pos.ltp > 0 ? pos.ltp : fallbackPrice, 5);
    pos = await this.resolvePositionForClose(pos);

    if (!isValidSecurityId(pos.securityId)) {
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: 'Cannot resolve instrument securityId for close' };
    }

    const correlationId = `c_${pos.securityId || pos.tradingSymbol}_${Date.now().toString(36)}`.slice(0, 25);

    journal.append('order_intent', {
      correlation_id: correlationId, mode,
      params: { security_id: pos.securityId, quantity: qty, transaction_type: transactionType, exchange_segment: pos.exchangeSegment, product_type: pos.productType },
    });

    try {
      const placeReq = mode === 'sandbox'
        ? buildSandboxPlaceRequest({
          correlationId, securityId: pos.securityId, exchangeSegment: pos.exchangeSegment,
          transactionType, orderType: 'MARKET', quantity: qty, price: limitPrice, productType: pos.productType,
        })
        : {
          correlationId, securityId: pos.securityId, exchangeSegment: pos.exchangeSegment as any,
          transactionType: transactionType as any, orderType: 'MARKET' as any, quantity: qty, price: 0,
          productType: pos.productType as any,
        };
      const placed: any = await this.client.orders.place(placeReq);
      const orderId = placed?.data?.orderId ?? placed?.orderId;
      const settled: any = orderId ? await this.client.orders.getById(orderId).catch(() => placed?.data ?? placed) : placed?.data ?? placed;
      const fillPrice = Number(settled?.averagePrice ?? settled?.price ?? 0) || undefined;

      const fillPayload = {
        correlation_id: correlationId, mode, is_paper: false, symbol: pos.tradingSymbol,
        security_id: pos.securityId, quantity: qty, transaction_type: transactionType,
        order_id: orderId, fill_price: fillPrice, filled_at: new Date().toISOString(), reason,
      };
      eventBus.log('TRADE', `Broker close ${transactionType} ${qty} ${pos.tradingSymbol} (${reason})`, 'portfolio_source');
      eventBus.emit('order', { kind: 'fill', ...fillPayload });
      journal.append('order_result', { status: 'TRADED', ...fillPayload });
      redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});

      if (mode === 'sandbox') {
        await closePaperPosition(toInstrumentKey(pos), limitPrice, async () => 0, 'EXIT').catch(() => {});
      }

      this.invalidate();
      return { status: 'TRADED', symbol: pos.tradingSymbol, orderId, fillPrice };
    } catch (e: any) {
      const errMsg = String(e.message || 'Close rejected');
      if (isRateLimitError(errMsg)) {
        this.noteCloseRateLimit(pos.tradingSymbol);
        this.noteBrokerRateLimit({ message: errMsg });
      }
      const friendly = isRateLimitError(errMsg)
        ? 'Dhan API rate limit exceeded — wait a few seconds and retry. Sandbox paper-only positions close locally without broker calls.'
        : errMsg;
      eventBus.log('ERROR', `Broker close FAILED for ${pos.tradingSymbol}: ${errMsg}`, 'portfolio_source');
      journal.append('order_result', { correlation_id: correlationId, status: 'REJECTED', reason: errMsg, mode });
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: friendly };
    }
  }

  async closePosition(key: InstrumentKey, _priceHint?: number, _kind?: FillKind, quantity?: number, tradingSymbol?: string): Promise<CloseResult> {
    await this.ensureFresh(false);
    let pos = await this.findOpenPosition(key, tradingSymbol);
    if (!pos) {
      await this.ensureFresh(true);
      pos = await this.findOpenPosition(key, tradingSymbol);
    }
    if (!pos) return { status: 'noop', reason: 'No open position found', securityId: key.securityId };
    if (this.isCloseRateLimited(pos.tradingSymbol)) {
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: 'Close cooling down after rate limit — retry shortly' };
    }
    if (this.brokerMode() === 'sandbox' && !this.isBrokerOpen(pos)) {
      return this.closeSandboxPaperOnly(pos, 'manual close');
    }
    await this.ensureFresh(true);
    return this.reversePosition(pos, 'manual close', quantity);
  }

  async closeAll(_ltpResolver: LtpResolver): Promise<CloseResult[]> {
    await this.ensureFresh(false);
    const open = (await this.getPositions()).filter((p) => p.netQty !== 0);
    const results: CloseResult[] = [];
    for (const pos of open) {
      results.push(await this.reversePosition(pos, 'square-off'));
    }
    return results;
  }
}

// ── margin reconcile (sandbox/live diagnostics) ─────────────────────────

export interface MarginReconcileReport {
  mode: string;
  healthy: boolean;
  notes: string[];
  broker: { usedMargin: number; availableMargin: number; totalBalance: number; equity: number };
  paperLedger: { usedMargin: number; availableMargin: number; openCount: number };
  positions: { brokerOpen: number; paperOpen: number; brokerOnly: string[]; paperOnly: string[] };
  pendingOrders: Array<{ id: string; instrument: string; side: string; qty: number; status: string }>;
  drift: { brokerVsPaperUsed: number };
}

function openSymbols(positions: Array<{ netQty: number; tradingSymbol: string }>): Set<string> {
  return new Set(positions.filter((p) => p.netQty !== 0).map((p) => p.tradingSymbol));
}

function symDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((s) => !b.has(s));
}

async function listPendingBrokerOrders(client: DhanClient): Promise<MarginReconcileReport['pendingOrders']> {
  const raw = await client.orders.list().catch(() => []);
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => ['PENDING', 'TRANSIT'].includes(String(r.orderStatus ?? '')))
    .map((r) => ({
      id: String(r.orderId ?? ''),
      instrument: String(r.tradingSymbol ?? ''),
      side: String(r.transactionType ?? ''),
      qty: Number(r.quantity ?? 0),
      status: String(r.orderStatus ?? 'PENDING'),
    }));
}

/** Compares Dhan's fund-limit margin against the local paper ledger and
 * open-position books — surfaces stale collateral, pending-order blocks,
 * and broker/local position drift in sandbox/live mode. */
export async function buildMarginReconcileReport(
  client: DhanClient,
  portfolio: PortfolioSource,
): Promise<MarginReconcileReport> {
  const mode = brokerJournalMode();
  const [fundsRes, brokerPositions, paperWallet, paperPositions] = await Promise.all([
    client.funds.getLimit().catch(() => ({})),
    portfolio.getPositions(),
    getPaperWallet(),
    listPaperPositions(),
  ]);
  const usedMargin = Number((fundsRes as any)?.utilizedAmount ?? 0);
  const availableMargin = Number((fundsRes as any)?.availabelBalance ?? 0);
  const totalBalance = usedMargin + availableMargin;
  const unrealized = brokerPositions.reduce((s, p) => s + p.unrealizedProfit, 0);
  const pendingOrders = await listPendingBrokerOrders(client);

  const brokerSyms = openSymbols(brokerPositions);
  const paperSyms = openSymbols(paperPositions);
  const brokerVsPaperUsed = Number((usedMargin - paperWallet.usedMargin).toFixed(2));

  const notes: string[] = [];
  if (pendingOrders.length > 0) {
    notes.push(`${pendingOrders.length} pending order(s) may still block margin at the broker`);
  }
  if (brokerVsPaperUsed > 100) {
    notes.push(`Broker utilizedAmount exceeds local paper ledger by ₹${brokerVsPaperUsed.toLocaleString('en-IN')}`);
  }
  const brokerOnly = symDiff(brokerSyms, paperSyms);
  const paperOnly = symDiff(paperSyms, brokerSyms);
  if (brokerOnly.length) notes.push(`Open at broker but not in local book: ${brokerOnly.join(', ')}`);
  if (paperOnly.length) notes.push(`Open in local book but not at broker: ${paperOnly.join(', ')}`);

  const healthy = notes.length === 0;
  return {
    mode,
    healthy,
    notes,
    broker: {
      usedMargin, availableMargin, totalBalance,
      equity: Number((totalBalance + unrealized).toFixed(2)),
    },
    paperLedger: {
      usedMargin: paperWallet.usedMargin,
      availableMargin: paperWallet.availableMargin,
      openCount: paperSyms.size,
    },
    positions: {
      brokerOpen: brokerSyms.size,
      paperOpen: paperSyms.size,
      brokerOnly,
      paperOnly,
    },
    pendingOrders,
    drift: { brokerVsPaperUsed },
  };
}

export async function buildPaperMarginReconcileReport(): Promise<MarginReconcileReport> {
  const wallet = await getPaperWallet();
  const positions = await listPaperPositions();
  const open = positions.filter((p) => p.netQty !== 0);
  return {
    mode: 'paper',
    healthy: true,
    notes: ['Paper mode: margin is derived from open-position margin_blocked sums'],
    broker: {
      usedMargin: wallet.usedMargin,
      availableMargin: wallet.availableMargin,
      totalBalance: wallet.totalBalance,
      equity: wallet.equity,
    },
    paperLedger: {
      usedMargin: wallet.usedMargin,
      availableMargin: wallet.availableMargin,
      openCount: open.length,
    },
    positions: {
      brokerOpen: open.length,
      paperOpen: open.length,
      brokerOnly: [],
      paperOnly: [],
    },
    pendingOrders: [],
    drift: { brokerVsPaperUsed: 0 },
  };
}
