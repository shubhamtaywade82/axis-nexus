import { WebSocket } from 'ws';
import { eventBus, type Envelope, type Channel } from '../services/eventBus';
import { marketClock } from '../services/marketHours';
import { moduleLogger } from '../lib/logger';
import { WsClientMessageSchema } from '../lib/routeSchemas';

/**
 * WebSocket hub — the backend→frontend telemetry stream.
 *
 * Protocol (frontend is a pure consumer):
 *   Server → Client: { channel, ts, payload } envelopes on channels:
 *     tick | log | alert | telemetry | risk | portfolio | order | system
 *   Client → Server:
 *     { type: 'subscribe', channels: [...] }   — filter (default: all)
 *     { type: 'unsubscribe' }
 *     { type: 'ping' }                          — server replies pong
 *
 * On connect the client receives a hydration snapshot
 * (recent logs, alerts, telemetry, risk state) so a late-attaching UI
 * shows real history immediately — no fabricated seed data.
 *
 * Two things every client here must be protected from:
 *  - Tick volume: with option legs subscribed under the DhanHQ 'full' feed
 *    mode, ticks fire far faster than a UI needs to redraw a number. Ticks
 *    are conflated per-instrument and flushed on a fixed cadence instead of
 *    forwarded one-for-one.
 *  - A slow client: sending into a socket the OS can't drain fast enough
 *    grows Node's internal write buffer without bound. Every send checks
 *    `ws.bufferedAmount` first and drops rather than queues when a client
 *    has fallen behind.
 */

const ALL_CHANNELS: Channel[] = ['tick', 'log', 'alert', 'telemetry', 'risk', 'portfolio', 'order', 'system'];
// Per-channel hydration depth — each channel gets its OWN bounded slice of
// history rather than one merged-then-sliced(-60) list, which a bursty
// channel (ticks) could dominate entirely, starving the others out of the
// snapshot a late-attaching dashboard needs most (recent logs and alerts).
const HYDRATION_LIMITS: Partial<Record<Channel, number>> = {
  tick: 20, portfolio: 5, risk: 5, log: 40, alert: 40, telemetry: 40,
};

const TICK_FLUSH_MS = 100; // ~10Hz — well above human perception for a number redrawing
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB — beyond this the client isn't keeping up

const log = moduleLogger('ws');

interface ClientEntry {
  channels: Set<Channel>;
  send: (env: Envelope) => void;
  pendingTicks: Map<string, Envelope>; // per-instrument key → latest tick only
  flushTimer: ReturnType<typeof setInterval>;
  dropped: number;
}

export class MarketStreamManager {
  private clients = new Map<WebSocket, ClientEntry>();

  subscribe(ws: WebSocket): void {
    const flushTicks = () => {
      const entry = this.clients.get(ws);
      if (!entry || entry.pendingTicks.size === 0) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        entry.dropped += entry.pendingTicks.size;
        entry.pendingTicks.clear();
        return;
      }
      for (const env of entry.pendingTicks.values()) {
        try { ws.send(JSON.stringify(env)); } catch { /* dead socket cleaned on close */ }
      }
      entry.pendingTicks.clear();
    };

    const entry: ClientEntry = {
      channels: new Set<Channel>(ALL_CHANNELS),
      pendingTicks: new Map(),
      dropped: 0,
      flushTimer: setInterval(flushTicks, TICK_FLUSH_MS),
      send: (env: Envelope) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (env.channel === 'tick') {
          // Conflate: only the newest price per instrument survives to the
          // next flush — a UI never needs every intermediate print.
          const key = String((env.payload as any)?.securityId ?? (env.payload as any)?.symbol ?? '?');
          entry.pendingTicks.set(key, env);
          return;
        }
        // Everything else is discrete (a fill, an alert, a log line) and
        // must never be silently coalesced — only dropped, and only when
        // the client has genuinely fallen behind.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { entry.dropped++; return; }
        try { ws.send(JSON.stringify(env)); } catch { /* dead socket cleaned on close */ }
      },
    };
    this.clients.set(ws, entry);
    log.info({ clients: this.clients.size }, 'WS client connected');

    // Hydrate with real recent history — one bounded slice PER CHANNEL, so
    // ticks (capped at 20 here) can't crowd out log/alert/telemetry history.
    for (const [channel, limit] of Object.entries(HYDRATION_LIMITS) as Array<[Channel, number]>) {
      for (const env of eventBus.recent(undefined, [channel]).slice(-limit)) {
        try { entry.send(env); } catch { /* ignore */ }
      }
    }
    ws.send(JSON.stringify({
      channel: 'system', ts: Date.now(),
      payload: { type: 'connected', channels: ALL_CHANNELS, clock: marketClock() },
    }));

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        // Malformed JSON — send a typed error back so a debugging client
        // can see why its message was ignored, rather than silent drop.
        ws.send(JSON.stringify({ channel: 'system', ts: Date.now(), payload: { type: 'error', error: 'invalid JSON' } }));
        return;
      }
      // Validate the message shape with zod — a malformed `channels` array,
      // an unknown message type, or extra fields all surface as a typed
      // error envelope rather than silently misbehaving.
      const result = WsClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        const issue = result.error.issues[0];
        ws.send(JSON.stringify({
          channel: 'system', ts: Date.now(),
          payload: { type: 'error', error: issue ? `${issue.path.join('.') || 'msg'}: ${issue.message}` : 'invalid message' },
        }));
        return;
      }
      const msg = result.data;
      if (msg.type === 'subscribe') {
        entry.channels = msg.channels ? new Set<Channel>(msg.channels) : new Set<Channel>(ALL_CHANNELS);
        ws.send(JSON.stringify({ channel: 'system', ts: Date.now(), payload: { type: 'subscribed', channels: [...entry.channels] } }));
      } else if (msg.type === 'unsubscribe') {
        entry.channels = new Set();
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ channel: 'system', ts: Date.now(), payload: { type: 'pong' } }));
      }
    });
  }

  unsubscribe(ws: WebSocket): void {
    const entry = this.clients.get(ws);
    if (entry) {
      clearInterval(entry.flushTimer);
      if (entry.dropped > 0) log.warn({ dropped: entry.dropped }, 'WS client fell behind — envelopes dropped rather than queued');
    }
    this.clients.delete(ws);
    log.info({ clients: this.clients.size }, 'WS client disconnected');
  }

  /** Attach the hub to the central bus (called once at boot). */
  attach(): void {
    eventBus.attachWsClient((env) => {
      for (const entry of this.clients.values()) {
        if (entry.channels.has(env.channel)) {
          try { entry.send(env); } catch { /* dead socket cleaned on close */ }
        }
      }
    });
  }

  stats() {
    return {
      clients: this.clients.size,
      channels: ALL_CHANNELS,
      totalDropped: [...this.clients.values()].reduce((sum, e) => sum + e.dropped, 0),
    };
  }
}
