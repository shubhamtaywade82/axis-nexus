import { EventEmitter } from 'events';
import { shouldEmitBusLog, type BusLogLevel } from '../lib/logPolicy';

/**
 * Central event bus. Every backend service (market data, risk engine,
 * autonomy loop, agent orchestrator, paper engine) publishes here.
 *
 * The bus fans events out to:
 *  - WebSocket hub (frontend control plane, zero or more clients)
 *  - Redis pub/sub (Rails sidecar compatibility, best-effort)
 *
 * The bus itself is transport-agnostic: services never know whether a
 * frontend is attached. This is what lets the backend run free of the UI.
 */

export type Channel =
  | 'tick'          // market data updates (indices, instrument LTPs)
  | 'log'           // structured system logs
  | 'alert'         // risk + system alerts (persisted)
  | 'telemetry'     // agent ReAct step events
  | 'risk'          // circuit breaker / risk state snapshots
  | 'portfolio'     // positions / orders / funds snapshots
  | 'order'         // fills, rejections, cancellations
  | 'system'        // lifecycle: boot, mode changes, kill switch
  | 'scalp'         // scalp position state: ratchet levels, entry/exit, PnL
  | 'expert_trade'; // NSE equity trade-idea lifecycle: created, triggered, target/stop/expiry

export interface Envelope<T = any> {
  channel: Channel;
  ts: number;
  payload: T;
}

type Handler = (env: Envelope) => void;

// Per-channel ring buffer sizes. Ticks fire far more often than everything
// else combined (every instrument, every price move) — a single shared
// buffer meant ticks evicted all log/alert/telemetry history within
// seconds of market open, so a newly-connected dashboard's hydration
// snapshot was ticks and nothing else. Each channel now keeps its own
// history at a size suited to how it's actually consumed: a dashboard
// wants the LATEST ticks (a handful is enough), but real depth on
// logs/alerts/orders/telemetry for anything investigative.
const HISTORY_LIMITS: Record<Channel, number> = {
  tick: 50,
  log: 500,
  alert: 500,
  telemetry: 500,
  risk: 100,
  portfolio: 50,
  order: 500,
  system: 200,
  scalp: 200,
  expert_trade: 200,
};

const ALL_CHANNELS = Object.keys(HISTORY_LIMITS) as Channel[];

interface HistoryEntry { seq: number; env: Envelope }

export class EventBus {
  private emitter = new EventEmitter();
  private wsClients = new Set<(env: Envelope) => void>();
  private redisSink: ((channel: string, message: string) => Promise<void>) | null = null;
  private historyByChannel: Record<Channel, HistoryEntry[]> = {
    tick: [], log: [], alert: [], telemetry: [], risk: [], portfolio: [], order: [], system: [], scalp: [], expert_trade: [],
  };
  // Tie-breaker for recent()'s merge sort — Date.now() has 1ms resolution,
  // and two envelopes on different channels emitted in the same event-loop
  // tick (routine: a fill triggers both an 'order' and a 'log' emit) can
  // share a timestamp. Sorting by ts alone would then order them by which
  // channel happened to be iterated first, not by which actually happened
  // first.
  private seq = 0;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /** Services subscribe locally (in-process). */
  on(channel: Channel | '*', handler: Handler): () => void {
    const wrapped = channel === '*' ? handler : (env: Envelope) => {
      if (env.channel === channel) handler(env);
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /** The WebSocket hub registers its per-client senders here. */
  attachWsClient(send: (env: Envelope) => void): () => void {
    this.wsClients.add(send);
    return () => this.wsClients.delete(send);
  }

  /** Redis publisher (optional, best-effort Rails bridge). */
  setRedisSink(sink: ((channel: string, message: string) => Promise<void>) | null): void {
    this.redisSink = sink;
  }

  emit<T>(channel: Channel, payload: T): void {
    const env: Envelope<T> = { channel, ts: Date.now(), payload };
    const buf = this.historyByChannel[channel];
    buf.push({ seq: ++this.seq, env: env as Envelope });
    const limit = HISTORY_LIMITS[channel];
    // splice rather than repeated shift() — a burst of ticks pushing the
    // buffer well over its limit in one turn would otherwise shift() one
    // at a time; this trims it back to size in one call regardless.
    if (buf.length > limit) buf.splice(0, buf.length - limit);

    this.emitter.emit('event', env as Envelope);

    for (const send of this.wsClients) {
      try { send(env as Envelope); } catch { /* dead client — hub cleans up */ }
    }

    if (this.redisSink) {
      this.redisSink(`dhan:events:${channel}`, JSON.stringify(payload)).catch(() => {});
    }
  }

  /**
   * Recent events across the requested channels (or all), oldest first.
   * Each channel's OWN ring buffer is the source — callers that want a
   * bounded hydration slice per channel (rather than one merged slice a
   * high-volume channel like `tick` can dominate) should slice per-channel
   * themselves, e.g. by calling this once per channel. See marketStream.ts.
   */
  recent(sinceTs?: number, channels?: Channel[]): Envelope[] {
    const chans = channels || ALL_CHANNELS;
    const merged: HistoryEntry[] = [];
    for (const c of chans) {
      for (const item of this.historyByChannel[c]) {
        if (!sinceTs || item.env.ts > sinceTs) merged.push(item);
      }
    }
    merged.sort((a, b) => a.env.ts - b.env.ts || a.seq - b.seq);
    return merged.map((item) => item.env);
  }

  log(level: BusLogLevel, message: string, source: string): void {
    if (!shouldEmitBusLog(level, source, message)) return;
    this.emit('log', {
      level, message, source,
      reqId: `req_${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    });
  }
}

export const eventBus = new EventBus();
