import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { PositionMonitor, OrderUpdateWS, RateLimitError } from '@nemesis-oss/dhanhq-sdk';
import { hasTotpCredentials, hasExternalAuthProvider } from '../auth';
import { clearDhanRateLimit, dhanRateLimitRemainingMs, isDhanRateLimited, noteDhanRateLimit } from '../lib/dhanRateLimit';
import { isLiveMode } from '../lib/tradingMode';
import { eventBus } from './eventBus';
import { marketClock, istNow, isWsMarketWindowOpen, msUntilNextWsWindow } from './marketHours';

/**
 * Always-on market data service.
 *
 * - Primary source: DhanHQ binary WebSocket (SDK `client.ws.market`) —
 *   real-time ticks, no polling cost.
 * - Fallback source: REST `marketFeed.quote` polling when the WS is down.
 *
 * Market data always uses the **production** DhanHQ client (real-time
 * quotes/WS) in every TRADING_MODE. Order-update WS connects **live mode
 * only** — paper is local, sandbox settles synchronously via REST.
 *
 * The service starts at server boot and keeps running with ZERO frontend
 * clients attached — the autonomy loop and risk engine both consume it.
 * Frontend WS clients are pure observers.
 *
 * It also feeds the SDK's PositionMonitor (stop-loss / target / trailing
 * exits), which was previously dead code in this repo.
 */

// Verified against DhanHQ's own live instrument master
// (https://images.dhan.co/api-data/api-scrip-master.csv, NSE/BSE IDX_I
// rows) on 2026-09-03 — NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX all
// checked correct; INDIAVIX was wrong (26, a stale/guessed value — the
// real SEM_SMST_SECURITY_ID is 21) until this fix. A wrong VIX id here
// doesn't fail loudly: it just silently subscribes to and quotes whatever
// OTHER index security 26 happens to be, so this is exactly the kind of
// error that needs checking against the source, not memory.
export const INDEX_INSTRUMENTS: Record<string, { securityId: string; label: string }> = {
  NIFTY: { securityId: '13', label: 'NIFTY 50' },
  BANKNIFTY: { securityId: '25', label: 'NIFTY BANK' },
  FINNIFTY: { securityId: '27', label: 'NIFTY FIN SERVICE' },
  MIDCPNIFTY: { securityId: '442', label: 'NIFTY MID SELECT' },
  SENSEX: { securityId: '51', label: 'BSE SENSEX' },
  INDIAVIX: { securityId: '21', label: 'INDIA VIX' },
};

const INDEX_SEC_IDS = Object.values(INDEX_INSTRUMENTS).map((i) => i.securityId);
const SEC_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(INDEX_INSTRUMENTS).map(([sym, i]) => [i.securityId, sym]),
);

export interface QuoteSnapshot {
  securityId: string;
  symbol?: string;
  ltp: number;
  change: number;
  pctChange: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  oi: number;
  updatedAt: number;
  /** Bid-ask spread — populated when the DhanHQ WS sends full depth.
   *  Zero/undefined when only LTP is available (REST fallback). */
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
}

/** Returns the current bid-ask spread for an instrument, or null if
 *  no depth data is available (REST fallback mode). The scalp exit
 *  policy uses this to calculate the true cost of entry/exit. */
export function getBidAsk(market: MarketDataService, securityId: string): { bid: number; ask: number; spread: number; spreadPct: number } | null {
  const q = market.getQuote(securityId);
  if (!q || !q.bid || !q.ask || q.bid <= 0 || q.ask <= 0) return null;
  const spread = q.ask - q.bid;
  const mid = (q.bid + q.ask) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;
  return { bid: q.bid, ask: q.ask, spread, spreadPct };
}

/**
 * Translates this app's trailing-stop config — a fixed point DISTANCE off
 * the high-water mark (paper_positions.trailing_stop, the shape every
 * caller in this codebase already stores and reasons about) — into the
 * shape PositionMonitor.track() actually requires: { atr, multiplier }.
 *
 * Every call site used to pass a raw number or { distance } directly as
 * `trail`. PositionMonitor.track() only checks that `trail` is truthy and
 * then reads `trail.atr` — neither shape has that property, so `atr` was
 * always `undefined`. Its TrailManager computes
 * `candidate = highestPrice - atr * multiplier`, which is then NaN, and
 * `NaN > currentStop` is always false — the trail NEVER ADVANCES. Since
 * every leg here also sets an explicit stopLoss alongside trailingStop,
 * the practical effect was that every "trailing" stop in the system
 * silently degraded to a static stop that never trails; a trailing-only
 * position with no separate stopLoss would have had NO stop-loss
 * protection at all (its threshold would also compute as NaN).
 *
 * multiplier: 1 reproduces the intended semantic exactly: `stop =
 * highestPrice - distance`, i.e. "trail by N points off the high water
 * mark" — using the SDK's ATR-trail mechanism with the multiplier pinned
 * to 1 rather than treating `distance` as a true Average True Range.
 */
export function toTrailConfig(raw: number | { distance: number } | null | undefined): { atr: number; multiplier: number } | undefined {
  const d = Number(typeof raw === 'object' && raw !== null ? raw.distance : raw);
  if (!(d > 0)) return undefined;
  return { atr: d, multiplier: 1 };
}

export class MarketDataService {
  private client: DhanClient;
  private quotes = new Map<string, QuoteSnapshot>();     // securityId → snapshot
  private wsStarted = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsTickCount = 0;
  private restTickCount = 0;
  private lastTickAt = 0;
  private lastWsTickAt = 0;
  private source: 'ws' | 'rest' | 'none' = 'none';
  private lastWs429At = 0;                                // backoff timestamp for WebSocket 429 rate limit
  private wsListenersAttached = false;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRetryAttempts = 0;
  private wsSilenceWatch: ReturnType<typeof setInterval> | null = null;
  private extraSubscriptions = new Set<string>();        // 'SEG:SECID' keys
  private unsubEventBus: (() => void) | null = null;
  private wsConnecting = false;
  private wsConnectingAt = 0;
  private pollInFlight = false;
  /** Transition-only feed logs — avoids repeating the same status every poll/retry. */
  private feedLog = { offHours: false, noCreds: false, marketWs: false, ordersWs: false };
  readonly monitor = new PositionMonitor();

  constructor(client: DhanClient) {
    this.client = client;
  }

  async start(): Promise<void> {
    // Feed monitor exits into the bus (autonomy engine acts on them).
    // ExitSignal nests the position ({securityId, exchangeSegment, ...}) and
    // names the trigger price `price`, not `exitPrice` — reading those
    // fields flat off `signal` silently produced `undefined` for all three,
    // so autonomy's exit handler could never match a real position and
    // stop-loss/target/trailing exits never actually closed anything.
    this.monitor.on('exit', (signal: any) => {
      eventBus.emit('order', {
        kind: 'exit_signal',
        reason: signal.reason,
        positionId: signal.position?.securityId,
        securityId: signal.position?.securityId,
        pnl: signal.pnl,
        exitPrice: signal.price,
      });
    });

    // Start DhanHQ binary WS in a best-effort way. When it cannot connect
    // (no token / off-hours), the REST poller below still feeds the cache.
    this.tryStartWs();

    // Always run the REST poller as fallback + refresher. Outside market
    // hours it backs off to a slow cadence so we don't burn rate limits.
    this.schedulePolling();

    eventBus.log('SYSTEM', `Market data service started (ws=${this.wsStarted ? 'attempting' : 'unavailable'}, rest fallback armed)`, 'market_data');
  }

  private hasMcxSubscription(): boolean {
    if (process.env.MCX_ENABLED === 'true') return true;
    for (const key of this.extraSubscriptions) {
      if (key.startsWith('MCX_COMM:')) return true;
    }
    return false;
  }

  private disconnectWs(): void {
    this.wsConnecting = false;
    this.wsStarted = false;
    this.feedLog.marketWs = false;
    this.feedLog.ordersWs = false;
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    if (this.wsSilenceWatch) {
      clearInterval(this.wsSilenceWatch);
      this.wsSilenceWatch = null;
    }
    const ws: any = (this.client as any).ws;
    try { ws?.market?.disconnect?.(); } catch { /* noop */ }
    try { ws?.orders?.disconnect?.(); } catch { /* noop */ }
  }

  private tryStartWs(force = false): void {
    if (!force && !isWsMarketWindowOpen(this.hasMcxSubscription())) {
      if (!this.feedLog.offHours) {
        const nextMin = Math.round(msUntilNextWsWindow(this.hasMcxSubscription()) / 60_000);
        eventBus.log('INFO', `Outside WebSocket market hours (window: 09:10–15:35 IST) — connection deferred (${nextMin}m until open)`, 'market_data');
        this.feedLog.offHours = true;
      }
      if (this.wsStarted) this.disconnectWs();
      return;
    }
    this.feedLog.offHours = false;

    // Only bring up the DhanHQ binary WS when credentials can resolve a token
    const tokenResolvable = hasTotpCredentials() || hasExternalAuthProvider();
    if (!tokenResolvable) {
      if (!this.feedLog.noCreds) {
        eventBus.log('WARN', 'No DhanHQ credentials configured — binary WS disabled, REST polling will serve market data when a token appears', 'market_data');
        this.feedLog.noCreds = true;
      }
      return;
    }
    this.feedLog.noCreds = false;

    // Back off if recently rate-limited (429) on WebSocket
    if (this.wsConnecting) {
      // A connect() attempt that never fires open/error/close — a raw
      // socket stuck at the TCP level with no timeout enforced by the WS
      // library, e.g. a firewall silently dropping packets — would
      // otherwise leave wsConnecting true forever: every later retry hits
      // this guard and returns immediately, and nothing past this point
      // schedules another one, permanently killing the reconnect loop.
      // Treat an attempt this stale as dead and let it retry instead of
      // trusting it'll eventually settle.
      if (Date.now() - this.wsConnectingAt < 30_000) return;
      this.wsConnecting = false;
    }
    if (Date.now() - this.lastWs429At < 60_000) {
      this.scheduleWsRetry(60_000 - (Date.now() - this.lastWs429At), force);
      return;
    }

    try {
      patchOrderWsSafety();
      const ws: any = (this.client as any).ws;
      if (!ws) return;

      if (ws.market) {
        ws.market.mode = 'ticker';
        ws.market.subscribe([
          ...INDEX_SEC_IDS.map((id) => ({ exchangeSegment: 'IDX_I', securityId: id })),
          ...[...this.extraSubscriptions].map((k) => {
            const [exchangeSegment, securityId] = k.split(':');
            return { exchangeSegment, securityId };
          }),
        ]);
      }

      if (!this.wsListenersAttached) {
        this.wsListenersAttached = true;
        ws.market?.on?.('open', () => {
          this.wsConnecting = false;
          this.wsStarted = true;
          this.wsRetryAttempts = 0;
          this.lastWsTickAt = Date.now();
          if (!this.feedLog.marketWs) {
            eventBus.log('INFO', 'DhanHQ binary WebSocket connected — real-time tick stream live', 'market_data');
            this.feedLog.marketWs = true;
          }
          this.armSilenceWatch();
        });
        ws.market?.on?.('tick', (tick: any) => {
          this.wsTickCount++;
          this.lastTickAt = Date.now();
          this.lastWsTickAt = Date.now();
          this.source = 'ws';
          this.ingestTick(tick);
        });
        ws.market?.on?.('close', () => {
          this.wsConnecting = false;
          if (!this.wsStarted) return;
          this.wsStarted = false;
          // SDK BaseWS emits "close" with no args — the underlying ws code/reason are not forwarded.
          if (this.feedLog.marketWs) {
            eventBus.log('WARN', 'Market WS closed — reconnecting', 'market_data');
            this.feedLog.marketWs = false;
          }
          eventBus.emit('system', { type: 'feed_degraded', source: 'rest' });
          this.scheduleWsRetry(undefined, force);
        });
        ws.market?.on?.('error', (e: any) => {
          const msg = e?.message || String(e);
          if (msg.includes('429')) {
            const now = Date.now();
            this.wsConnecting = false;
            if (now - this.lastWs429At > 30_000) {
              eventBus.log('WARN', 'DhanHQ Market WS rate-limited (429) — backing off 60s, REST polling active', 'market_data');
            }
            this.lastWs429At = now;
            this.wsStarted = false;
            try { ws.market?.disconnect?.(); } catch { /* noop */ }
            this.requestRestRefresh();
            this.scheduleWsRetry(60_000, force);
            return;
          }
          eventBus.log('WARN', `Market WS error: ${msg}`, 'market_data');
        });

        // Live mode only — paper is local, sandbox settles via REST getById.
        if (isLiveMode()) {
          ws.orders?.on?.('open', () => {
            if (!this.feedLog.ordersWs) {
              eventBus.log('INFO', 'DhanHQ orders WebSocket connected', 'market_data');
              this.feedLog.ordersWs = true;
            }
          });
          ws.orders?.on?.('order', (order: any) => {
            eventBus.emit('order', { kind: 'order_update', order });
          });
          ws.orders?.on?.('error', (e: any) => {
            const msg = e?.message || String(e);
            if (!msg.includes('429')) {
              eventBus.log('WARN', `Orders WS error: ${msg}`, 'market_data');
            }
          });
          ws.orders?.on?.('close', () => {
            if (this.feedLog.ordersWs) {
              eventBus.log('INFO', 'Orders WS closed', 'market_data');
              this.feedLog.ordersWs = false;
            }
          });
        }
      }

      if (!ws.market?.isConnected) {
        this.wsConnecting = true;
        this.wsConnectingAt = Date.now();
        ws.market?.connect?.().catch((e: any) => {
          this.wsConnecting = false;
          const msg = e?.message || String(e);
          if (msg.includes('429')) {
            this.lastWs429At = Date.now();
            this.requestRestRefresh();
            this.scheduleWsRetry(60_000, force);
          }
        });
      } else if (!this.wsStarted) {
        this.scheduleWsRetry(undefined, force);
      }
      if (!ws.orders?.isConnected && isLiveMode()) {
        ws.orders?.connect?.().catch(() => {});
      }
    } catch (e: any) {
      eventBus.log('WARN', `DhanHQ WebSocket start failed (${e?.message || e}) — REST polling only`, 'market_data');
      this.scheduleWsRetry(undefined, force);
    }
  }

  /** A half-open socket reports connected and delivers nothing — only tick
   * arrival proves liveness. Forces a reconnect on silence during market
   * hours rather than trusting the 'open' event forever. */
  private armSilenceWatch(): void {
    if (this.wsSilenceWatch) return;
    this.wsSilenceWatch = setInterval(() => {
      if (!this.wsStarted || !marketClock().isMarketOpen) return;
      if (Date.now() - this.lastWsTickAt < 20_000) return;
      eventBus.log('WARN', 'No WS tick for 20s during market hours — forcing reconnect', 'market_data');
      this.wsStarted = false;
      try { (this.client as any).ws?.market?.disconnect?.(); } catch { /* already gone */ }
      this.scheduleWsRetry();
    }, 10_000);
  }

  // Capped exponential backoff with custom override for 429 rate limits
  private scheduleWsRetry(customDelay?: number, force = false): void {
    if (this.wsRetryTimer) return;
    if (!force && !isWsMarketWindowOpen(this.hasMcxSubscription())) return;
    this.wsRetryAttempts++;
    const delay = customDelay || Math.min(15_000 * 2 ** (this.wsRetryAttempts - 1), 5 * 60_000);
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      this.tryStartWs(force);
    }, delay);
  }

  private patchOrderWsSafety(): void {
    patchOrderWsSafety();
  }

  private schedulePolling(): void {
    const tick = async () => {
      const clock = marketClock();
      const wsWindowOpen = isWsMarketWindowOpen(this.hasMcxSubscription());

      if (wsWindowOpen && !this.wsStarted && !this.wsConnecting) {
        this.tryStartWs();
      } else if (!wsWindowOpen && (this.wsStarted || this.wsConnecting || (this.client as any).ws?.market?.isConnected)) {
        if (this.feedLog.marketWs || this.feedLog.ordersWs) {
          eventBus.log('INFO', 'Market hours ended (15:35 IST) — cleanly disconnecting DhanHQ WebSocket feed', 'market_data');
        }
        this.disconnectWs();
      }

      const wsFresh = this.wsTickCount > 0 && Date.now() - this.lastWsTickAt < 15_000;
      const backoffRemaining = dhanRateLimitRemainingMs();
      // When WS is active, REST heartbeat polls at 12s to preserve API quota while staying
      // well under the 15s WARN and 30s ERROR boundaries. If WS drops or pauses, REST polls
      // at 4s during market hours to ensure continuous fresh price feeds.
      const interval = backoffRemaining > 0 ? backoffRemaining : wsFresh ? 12_000 : clock.isMarketOpen ? 4_000 : 30_000;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(tick, interval);
      if (backoffRemaining <= 0) {
        await this.refreshRestQuotes();
      }
    };
    tick();
  }

  private requestRestRefresh(): void {
    if (!isDhanRateLimited()) void this.refreshRestQuotes();
  }

  private async refreshRestQuotes(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.pollIndices();
      await this.pollExtraInstruments();
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollIndices(): Promise<void> {
    try {
      const res = await this.client.marketFeed.quote({ IDX_I: INDEX_SEC_IDS });
      const idxData = (res.data as any)?.IDX_I || {};
      let touched = false;
      for (const [secId, symbol] of Object.entries(SEC_TO_SYMBOL)) {
        const d = idxData[secId];
        if (!d) continue;
        touched = true;
        this.ingestRestQuote(secId, symbol, d, 'IDX_I');
      }
      if (touched) {
        this.restTickCount++;
        this.lastTickAt = Date.now();
        clearDhanRateLimit();
        if (this.wsTickCount === 0 || Date.now() - this.lastWsTickAt >= 10_000) {
          this.source = 'rest';
        }
      }
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        noteDhanRateLimit({ message: e.message, retryAfterMs: e.retryAfterMs }, (msg) => {
          eventBus.log('WARN', msg.replace('broker calls', 'quote polls'), 'market_data');
        });
      } else {
        eventBus.log('WARN', `Index quote poll failed: ${e?.message || e}`, 'market_data');
      }
    }
  }

  /** Subscribe to non-index instruments (option legs held in paper positions). */
  addInstruments(instruments: Array<{ securityId: string; exchangeSegment: string }>): void {
    for (const { securityId, exchangeSegment } of instruments) {
      if (!securityId || securityId === '0') continue;
      this.extraSubscriptions.add(`${exchangeSegment}:${securityId}`);
    }
    try {
      (this.client as any).ws?.market?.subscribe?.(
        [...this.extraSubscriptions].map((k) => {
          const [exchangeSegment, securityId] = k.split(':');
          return { exchangeSegment, securityId };
        }),
      );
    } catch { /* WS down — REST poller covers extras */ }
  }

  private async pollExtraInstruments(): Promise<void> {
    if (this.extraSubscriptions.size === 0) return;
    const bySegment: Record<string, string[]> = {};
    for (const key of this.extraSubscriptions) {
      const [seg, id] = key.split(':');
      (bySegment[seg] ||= []).push(id);
    }
    try {
      const res = await this.client.marketFeed.quote(bySegment);
      const data = (res.data as any) || {};
      for (const [seg, ids] of Object.entries(bySegment)) {
        for (const id of ids) {
          const d = data[seg]?.[id];
          if (d) this.ingestRestQuote(id, undefined, d, seg);
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── ingestion ────────────────────────────────────────────────────────

  private ingestTick(tick: any): void {
    const secId = String(tick.securityId ?? tick.security_id ?? '');
    if (!secId) return;
    const symbol = SEC_TO_SYMBOL[secId];
    const prev = this.quotes.get(secId);

    // Prev-close packets update baseline without overwriting LTP with zero
    if (tick.type === 'prev-close' && typeof tick.previousClose === 'number') {
      if (prev) {
        prev.prevClose = tick.previousClose;
        prev.change = prev.ltp ? prev.ltp - prev.prevClose : 0;
        prev.pctChange = prev.prevClose ? (prev.change / prev.prevClose) * 100 : 0;
        prev.updatedAt = Date.now();
        if (symbol && prev.ltp > 0) {
          eventBus.emit('tick', { symbol, data: this.toTickPayload(prev) });
        }
      }
      return;
    }

    const ltp = Number(tick.ltp ?? tick.lastTradedPrice ?? prev?.ltp ?? 0);
    if (!ltp) return;
    const prevClose = Number(tick.close ?? prev?.prevClose ?? ltp);
    // Bid/ask — DhanHQ's binary WS sends these as top-of-book fields on
    // full-mode tick packets. The field names vary by SDK version, so
    // check all known shapes. When absent (light-mode subscription or
    // REST fallback), preserve the previous bid/ask rather than zeroing.
    const bid = Number(tick.bid ?? tick.bestBid ?? tick.bidPrice ?? prev?.bid ?? 0) || prev?.bid;
    const ask = Number(tick.ask ?? tick.bestAsk ?? tick.askPrice ?? prev?.ask ?? 0) || prev?.ask;
    const bidQty = Number(tick.bidQty ?? tick.bestBidQuantity ?? tick.bidQuantity ?? prev?.bidQty ?? 0) || prev?.bidQty;
    const askQty = Number(tick.askQty ?? tick.bestAskQuantity ?? tick.askQuantity ?? prev?.askQty ?? 0) || prev?.askQty;
    const snap: QuoteSnapshot = {
      securityId: secId,
      symbol,
      ltp,
      prevClose,
      change: ltp - prevClose,
      pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
      high: Number(tick.high ?? prev?.high ?? ltp),
      low: Number(tick.low ?? prev?.low ?? ltp),
      open: Number(tick.open ?? prev?.open ?? ltp),
      volume: Number(tick.volume ?? prev?.volume ?? 0),
      oi: Number(tick.oi ?? tick.openInterest ?? prev?.oi ?? 0),
      updatedAt: Date.now(),
      bid: bid && bid > 0 ? bid : undefined,
      ask: ask && ask > 0 ? ask : undefined,
      bidQty: bidQty && bidQty > 0 ? bidQty : undefined,
      askQty: askQty && askQty > 0 ? askQty : undefined,
    };
    this.quotes.set(secId, snap);

    // Feed the SDK PositionMonitor for stop-loss/target/trailing exits.
    try {
      this.monitor.onTick({
        type: 'ticker',
        responseCode: 0, messageLength: 0, exchangeSegmentCode: 0,
        exchangeSegment: String(tick.exchangeSegment || 'IDX_I'),
        securityId: secId,
        ltp, ltt: Math.floor(Date.now() / 1000),
        raw: Buffer.alloc(0),
      } as any);
    } catch { /* monitor defensive */ }

    eventBus.emit('tick', { symbol, securityId: secId, data: this.toTickPayload(snap) });
  }

  private ingestRestQuote(secId: string, symbol: string | undefined, d: any, exchangeSegment: string): void {
    const ltp = Number(d.lastTradedPrice || d.last_price || d.ltp || 0);
    if (!ltp) return;
    const ohlc = d.ohlc || {};
    const prevClose = Number(ohlc.close || d.close || d.prevClose || ltp);
    const prev = this.quotes.get(secId);
    // REST quote — DhanHQ's marketFeed.quote response includes bid/ask
    // in the depth object when available.
    const depth = d.depth || d.marketDepth || {};
    const topBid = depth.buy?.[0] || depth.bids?.[0] || {};
    const topAsk = depth.sell?.[0] || depth.asks?.[0] || {};
    const bid = Number(topBid.price ?? topBid.bidPrice ?? d.bid ?? prev?.bid ?? 0) || prev?.bid;
    const ask = Number(topAsk.price ?? topAsk.askPrice ?? d.ask ?? prev?.ask ?? 0) || prev?.ask;
    const snap: QuoteSnapshot = {
      securityId: secId,
      symbol,
      ltp,
      prevClose,
      change: ltp - prevClose,
      pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
      high: Number(ohlc.high || d.high || ltp),
      low: Number(ohlc.low || d.low || ltp),
      open: Number(ohlc.open || d.open || ltp),
      volume: Number(d.volume || 0),
      oi: Number(d.oi || d.openInterest || 0),
      updatedAt: Date.now(),
      bid: bid && bid > 0 ? bid : undefined,
      ask: ask && ask > 0 ? ask : undefined,
      bidQty: Number(topBid.quantity ?? topBid.qty ?? 0) || undefined,
      askQty: Number(topAsk.quantity ?? topAsk.qty ?? 0) || undefined,
    };
    this.quotes.set(secId, snap);

    try {
      this.monitor.onTick({
        type: 'ticker',
        responseCode: 0, messageLength: 0, exchangeSegmentCode: 0,
        exchangeSegment,
        securityId: secId,
        ltp, ltt: Math.floor(Date.now() / 1000),
        raw: Buffer.alloc(0),
      } as any);
    } catch { /* monitor defensive */ }

    eventBus.emit('tick', { symbol, securityId: secId, data: this.toTickPayload(snap) });
  }

  private toTickPayload(s: QuoteSnapshot) {
    return {
      securityId: s.securityId,
      ltp: s.ltp,
      change: Number(s.change.toFixed(2)),
      pctChange: Number(s.pctChange.toFixed(2)),
      high: s.high, low: s.low, open: s.open, prevClose: s.prevClose,
      volume: s.volume, oi: s.oi,
      timestamp: s.updatedAt,
    };
  }

  // ── queries ──────────────────────────────────────────────────────────

  /** Display-only. Returns the last-known price at any age, including
   * off-hours — a closed-market ticker showing yesterday's close is
   * correct, not stale. NEVER use this to decide a fill or gate a trade —
   * use getFillablePrice() for that; see its docstring for why. */
  getLtp(securityId: string | number): number | null {
    const snap = this.quotes.get(String(securityId));
    if (!snap || !snap.ltp) return null;
    const clock = marketClock();
    if (clock.isMarketOpen && Date.now() - snap.updatedAt > 5 * 60_000) return null;
    return snap.ltp;
  }

  /** The ONLY price source any execution path may use — order fills,
   * strategy seeding, position sizing. getLtp()'s staleness guard only
   * applied during market hours, so a boot outside market hours (or a
   * feed outage) returned an arbitrarily old cached price with no bound at
   * all, and callers that saw null from getLtp() (e.g. seedStandardStrategies)
   * fell back to a HARDCODED FAKE SPOT rather than skipping — both are real
   * incidents this closes. Refuses outside market hours unless explicitly
   * allowed (backtests / manual overrides), and always enforces a tight age
   * bound regardless of hours. */
  getFillablePrice(securityId: string | number, opts: { allowClosed?: boolean; maxAgeMs?: number } = {}): number | null {
    const clock = marketClock();
    if (!clock.isMarketOpen && !opts.allowClosed) return null;
    const snap = this.quotes.get(String(securityId));
    if (!snap || !snap.ltp || snap.ltp <= 0) return null;
    // schedulePolling() backs the REST poll interval off to 30s off-hours
    // (vs 3s during market hours) — a 15s bound tuned for live market-hours
    // fills rejected the SAME still-freshest-available quote for roughly
    // half of every 30s off-hours cycle, purely by timing luck: whether
    // seedStandardStrategies' spot lookups, EOD square-off, or the kill
    // switch's close-all price happened to run just after a poll (fresh)
    // or just before the next one (same value, now "stale"). allowClosed
    // callers are explicitly the off-hours-tolerant ones, so give them a
    // bound comfortably above that poll interval instead of silently
    // inheriting the market-hours-tuned default.
    const maxAgeMs = opts.maxAgeMs ?? (opts.allowClosed ? 40_000 : 15_000);
    if (Date.now() - snap.updatedAt > maxAgeMs) return null;
    return snap.ltp;
  }

  getQuote(securityId: string | number): QuoteSnapshot | null {
    return this.quotes.get(String(securityId)) || null;
  }

  getIndices(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [sym, inst] of Object.entries(INDEX_INSTRUMENTS)) {
      const snap = this.quotes.get(inst.securityId);
      out[sym] = snap ? {
        ltp: snap.ltp,
        change: Number(snap.change.toFixed(2)),
        pct: Number(snap.pctChange.toFixed(2)),
        high: snap.high, low: snap.low, open: snap.open, prevClose: snap.prevClose,
        updatedAt: snap.updatedAt,
      } : null;
    }
    return out;
  }

  /** Seconds since the freshest tick of any instrument. */
  tickAgeSec(): number {
    return this.lastTickAt ? Math.round((Date.now() - this.lastTickAt) / 1000) : Infinity;
  }

  stats() {
    const wsFresh = this.wsTickCount > 0 && Date.now() - this.lastWsTickAt < 10_000;
    return {
      source: this.source,
      wsConnected: this.wsStarted && wsFresh,
      wsTicks: this.wsTickCount,
      restTicks: this.restTickCount,
      trackedInstruments: this.quotes.size,
      extraSubscriptions: this.extraSubscriptions.size,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      tickAgeSec: this.tickAgeSec() === Infinity ? null : this.tickAgeSec(),
      istTime: istNow().toLocaleTimeString('en-GB', { hour12: false }),
    };
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.unsubEventBus?.();
    this.disconnectWs();
  }
}

// Exported for direct unit testing — the surrounding class methods that
// call this require a live WS connection attempt to reach it, but the
// patch itself has no dependency on `this` or any connection state.
export function patchOrderWsSafety(): void {
  // Two independent one-time patches, each guarded by its OWN flag name,
  // checked with hasOwnProperty rather than a plain truthy read. They used
  // to share one `__safetyPatched` name on two prototypes in the SAME
  // chain — BaseWS.prototype is OrderUpdateWS.prototype's direct parent —
  // so setting it on the base prototype below made a plain
  // `OrderUpdateWS.prototype.__safetyPatched` read `true` too, via
  // inheritance, even though it had never been set on OrderUpdateWS.
  // prototype itself. That made the SECOND patch's own guard see "already
  // patched" on its very first run and return immediately — the
  // concatenated-JSON/malformed-frame onMessage patch below never
  // installed, so a Dhan frame containing two concatenated `{...}{...}`
  // objects hit the SDK's raw onMessage and could throw inside the socket
  // handler instead of being safely split and parsed.
  const baseProto = Object.getPrototypeOf(OrderUpdateWS.prototype);
  if (baseProto && !Object.prototype.hasOwnProperty.call(baseProto, '__connectSafetyPatched')) {
    baseProto.__connectSafetyPatched = true;
    const origConnect = baseProto.connect;
    baseProto.connect = async function (this: any) {
      if (typeof this.listenerCount === 'function' && this.listenerCount('error') === 0) {
        this.on('error', () => { /* prevent unhandled EventEmitter throw */ });
      }
      return origConnect.apply(this, arguments as any);
    };
  }

  // ws fires 'open' during setSocket while readyState is still CONNECTING;
  // SDK onOpen (sync + async) calls send() immediately and throws, which
  // kills the reconnect loop and blanks the UI control plane.
  if (baseProto && !Object.prototype.hasOwnProperty.call(baseProto, '__sendSafetyPatched')) {
    baseProto.__sendSafetyPatched = true;
    const origSend = baseProto.send;
    const WS_OPEN = 1;
    const WS_CONNECTING = 0;
    baseProto.send = function (this: any, payload: unknown) {
      const conn = this.connection;
      if (!conn) return;
      if (conn.readyState === WS_OPEN) {
        try { origSend.call(this, payload); } catch { /* socket died mid-send */ }
        return;
      }
      if (conn.readyState !== WS_CONNECTING) return;
      setImmediate(() => {
        try {
          if (this.connection?.readyState === WS_OPEN) origSend.call(this, payload);
        } catch { /* closed before deferred send */ }
      });
    };
  }

  // DhanHQ servers use WebSocket transport-level pings, not client-side JSON {"type":"ping"}.
  // The SDK default BaseWS.startHeartbeat sets a 10s pongTimeout that forcibly closes the
  // connection when no JSON pong is returned, causing a reconnect storm every 30 seconds.
  if (baseProto && !Object.prototype.hasOwnProperty.call(baseProto, '__heartbeatSafetyPatched')) {
    baseProto.__heartbeatSafetyPatched = true;
    baseProto.startHeartbeat = function (this: any) {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      this.pingInterval = setInterval(() => {
        try {
          if (this.connection?.readyState === 1 && typeof this.connection.ping === 'function') {
            this.connection.ping();
          }
        } catch { /* connection dropped mid-ping */ }
      }, this.pingIntervalMs || 30_000);
      this.pingInterval.unref?.();
    };
  }

  const proto = (OrderUpdateWS as any)?.prototype;
  if (!proto || Object.prototype.hasOwnProperty.call(proto, '__onMessageSafetyPatched')) return;
  proto.__onMessageSafetyPatched = true;
  const origOnMessage = proto.onMessage;
  proto.onMessage = function (data: any) {
    try {
      const raw = typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf8') : null);
      if (!raw) return;
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
      if (trimmed.includes('}{')) {
        const parts = trimmed.split(/(?<=\})(?=\{)/);
        for (const part of parts) {
          try {
            const parsed = JSON.parse(part);
            if (parsed.Type === 'order_alert' && parsed.Data) {
              const state = {
                orderId: typeof parsed.Data.OrderNo === 'string' ? parsed.Data.OrderNo : undefined,
                correlationId: typeof parsed.Data.CorrelationId === 'string' && parsed.Data.CorrelationId.length > 0 ? parsed.Data.CorrelationId : undefined,
                status: typeof parsed.Data.Status === 'string' ? parsed.Data.Status : undefined,
                tradedQty: typeof parsed.Data.TradedQty === 'number' ? parsed.Data.TradedQty : undefined,
                averageTradedPrice: typeof parsed.Data.AvgTradedPrice === 'number' ? parsed.Data.AvgTradedPrice : undefined,
                securityId: typeof parsed.Data.SecurityId === 'string' ? parsed.Data.SecurityId : undefined,
                raw: parsed.Data,
              };
              (this as any).orderStore?.upsert?.(state);
              this.emit('order', state);
            }
          } catch { /* ignore malformed part */ }
        }
        return;
      }
      origOnMessage.call(this, data);
    } catch {
      // Guard against malformed JSON or heartbeat frames from Dhan
    }
  };
}

// Apply before any DhanHQ WS connect() — tryStartWs also calls this, but
// module-load guarantees OrderUpdateWS.onOpen cannot race ahead on import.
patchOrderWsSafety();
