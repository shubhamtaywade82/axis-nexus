import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AppState, ToastType } from './types';
import { initialAppState } from '../utils/initialState';
import { api } from '../services/api';
import { useBackendStream, type Envelope } from '../hooks/useBackendStream';

interface Toast {
  id: number;
  msg: string;
  type: ToastType;
}

/** Side effects an envelope wants fired after the batch it arrived in is
 * applied — accumulated across a whole rAF batch and coalesced to at most
 * one call each, rather than once per envelope (a batch of several fills
 * in one frame previously meant several redundant refreshPortfolio calls). */
interface PendingEffects {
  refreshPortfolio: boolean;
  refreshControlState: boolean;
}

/**
 * Which side effects one envelope wants fired, independent of and computed
 * BEFORE any setState call — deliberately not mutated from inside a
 * setState updater (see onEnvelope below for why: a functional updater can
 * run later than the call that scheduled it, and reading a flag it was
 * supposed to have mutated by "now" is a race, not a guarantee).
 */
function getEnvelopeEffects(env: Envelope): PendingEffects {
  const effects: PendingEffects = { refreshPortfolio: false, refreshControlState: false };
  if (env.channel === 'order') {
    if ((env.payload || {}).kind === 'fill') {
      effects.refreshPortfolio = true;
      effects.refreshControlState = true;
    }
  } else if (env.channel === 'system') {
    const type = (env.payload || {}).type;
    if (type === 'kill_switch') {
      effects.refreshPortfolio = true;
      effects.refreshControlState = true;
    } else if (type === 'agent_run_complete') {
      effects.refreshPortfolio = true;
    } else if (type === 'autonomy') {
      effects.refreshControlState = true;
    }
  }
  return effects;
}

/**
 * Pure state transition for one backend envelope — no setState call of its
 * own, and no side channel out. Every WS message used to call setState
 * directly in the hook's onmessage handler, one React commit per envelope;
 * under DhanHQ's 'full' feed mode with option legs subscribed this could
 * re-render the tree hundreds of times a second. AppProvider now buffers
 * incoming envelopes and reduces a whole batch through this function in a
 * single setState per animation frame (see onEnvelope below) — this
 * function is what makes that reduction possible without duplicating the
 * per-channel logic.
 */
function applyEnvelope(prev: AppState, env: Envelope): AppState {
  switch (env.channel) {
    case 'tick': {
      const p = env.payload || {};
      const ltp = Number(p.data?.ltp ?? p.ltp ?? 0);
      if (!ltp || ltp <= 0) return prev;
      const secId = String(p.securityId || p.data?.securityId || '');
      const sym = p.symbol || (secId === '13' ? 'NIFTY' : secId === '25' ? 'BANKNIFTY' : secId === '51' ? 'SENSEX' : secId === '21' ? 'INDIAVIX' : secId === '27' ? 'FINNIFTY' : secId === '442' ? 'MIDCPNIFTY' : undefined);

      const nextIndices = sym ? {
        ...prev.indices,
        [sym]: {
          ltp,
          change: p.data?.change ?? 0,
          pct: p.data?.pctChange ?? p.data?.pct ?? 0,
          high: p.data?.high ?? 0,
          low: p.data?.low ?? 0,
          open: p.data?.open ?? 0,
          prevClose: p.data?.prevClose ?? 0,
          spot: ltp,
        },
      } : prev.indices;

      const nextPositions = secId ? prev.positions.map((pos) => {
        if (String(pos.securityId) === secId) {
          const net = Number(pos.netQty ?? pos.net_qty ?? 0);
          const buyAvg = Number(pos.buyAvg ?? pos.buy_avg ?? 0);
          const sellAvg = Number(pos.sellAvg ?? pos.sell_avg ?? 0);
          const unrealized = net !== 0 ? (net > 0 ? (ltp - buyAvg) * net : (sellAvg - ltp) * Math.abs(net)) : 0;
          const realized = Number(pos.realizedProfit ?? pos.realized_pnl ?? 0);
          const pnl = Number((realized + unrealized).toFixed(2));
          return { ...pos, ltp, pnl, unrealizedPnl: unrealized, unrealizedProfit: unrealized };
        }
        return pos;
      }) : prev.positions;

      const nextQuotes = secId ? {
        ...(prev.quotes || {}),
        [secId]: {
          ltp,
          oi: p.data?.oi,
          volume: p.data?.volume,
          change: p.data?.change,
          pct: p.data?.pctChange,
        },
      } : prev.quotes;

      return { ...prev, indices: nextIndices, positions: nextPositions, quotes: nextQuotes };
    }
    case 'log': {
      const p = env.payload || {};
      const id = env.ts + prev.logIdCounter;
      const logs = [...prev.logs, { id, time: p.time || new Date().toLocaleTimeString('en-GB', { hour12: false }), level: p.level || 'INFO', message: p.message || '', source: p.source || 'system', reqId: p.reqId || '-' }];
      return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs, logIdCounter: prev.logIdCounter + 1 };
    }
    case 'alert': {
      const p = env.payload || {};
      const alert = { id: env.ts + prev.alertIdCounter, time: new Date().toLocaleTimeString('en-GB', { hour12: false }), level: p.level || 'INFO', msg: p.msg || p.message || '', read: false, source: p.source || 'system' };
      const alerts = [...prev.alerts, alert];
      return { ...prev, alerts: alerts.length > 200 ? alerts.slice(-200) : alerts, alertIdCounter: prev.alertIdCounter + 1 };
    }
    case 'telemetry': {
      const p = env.payload || {};
      return {
        ...prev,
        telemetryEvents: [...prev.telemetryEvents.slice(-399), {
          id: p.id || `ev_${env.ts}`,
          runId: p.runId,
          triggeredBy: p.triggeredBy,
          agent: p.agent || 'planner',
          type: p.type || 'ACT',
          engine: p.engine,
          time: p.time || new Date().toLocaleTimeString('en-GB', { hour12: false }),
          summary: p.summary,
          tool: p.tool,
          response: p.response,
          duration: p.duration,
        }],
        agentTokens: prev.agentTokens + Math.ceil((p.summary || '').length / 4),
        agentDhanCalls: prev.agentDhanCalls + (p.tool ? 1 : 0),
      };
    }
    case 'risk': {
      const p = env.payload || {};
      return {
        ...prev,
        killed: !!p.killed,
        live: !p.killed,
        circuitBreakers: (p.breakers || []).map((b: any) => ({
          rule: b.rule, threshold: b.threshold, current: b.current, state: b.state, action: b.action,
        })),
      };
    }
    case 'portfolio': {
      const p = env.payload || {};
      if (!p.positions) return prev;
      return {
        ...prev,
        positions: p.positions,
        funds: p.funds ? { ...prev.funds, ...p.funds } : prev.funds,
      };
    }
    case 'order': {
      return prev;
    }
    case 'system': {
      const p = env.payload || {};
      if (p.type === 'connected' || p.type === 'pong') return prev;
      if (p.type === 'kill_switch') {
        return { ...prev, killed: p.state === 'ENGAGED', live: p.state !== 'ENGAGED' };
      }
      if (p.type === 'agent_run_complete') {
        return { ...prev, agentRunning: false };
      }
      return prev;
    }
    default:
      return prev;
  }
}

interface AppContextValue {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  showToast: (msg: string, type?: ToastType) => void;
  openModal: (content: ReactNode) => void;
  closeModal: () => void;
  toasts: Toast[];
  modalContent: ReactNode | null;
  addSystemLog: (level: string, message: string, source?: string) => void;
  refreshPortfolio: () => Promise<void>;
  refreshControlState: () => Promise<void>;
  connected: boolean;        // backend HTTP reachable
  streamConnected: boolean;  // backend WS stream live
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialAppState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalContent, setModalContent] = useState<ReactNode | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const toastIdRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshPortfolio = useCallback(async () => {
    try {
      const [positions, orders, funds, strategies] = await Promise.all([
        api.positions().catch(() => null),
        api.orders().catch(() => null),
        api.funds().catch(() => null),
        api.strategies().catch(() => null),
      ]);
      setState((prev) => ({
        ...prev,
        positions: Array.isArray(positions) ? positions : prev.positions,
        orders: Array.isArray(orders) ? orders : prev.orders,
        funds: typeof funds === 'object' && funds !== null ? { ...prev.funds, ...funds } : prev.funds,
        strategies: Array.isArray(strategies) ? strategies : prev.strategies,
      }));
    } catch {
      // Ignore background sync errors
    }
  }, []);

  const refreshControlState = useCallback(async () => {
    try {
      const [ctrl, alerts, health] = await Promise.all([
        api.controlState().catch(() => null),
        api.alerts(50).catch(() => null),
        api.health().catch(() => null),
      ]);
      if (ctrl) {
        setState((prev) => ({
          ...prev,
          killed: !!ctrl.risk?.killed,
          live: !ctrl.risk?.killed,
          circuitBreakers: (ctrl.risk?.breakers || []).map((b: any) => ({
            rule: b.rule, threshold: b.threshold, current: b.current, state: b.state, action: b.action,
          })),
          agentStatus: ctrl.agent?.personas || prev.agentStatus,
          agentRunning: !!ctrl.agent?.running,
          marketSource: ctrl.market?.source || prev.marketSource,
          marketWsConnected: !!ctrl.market?.wsConnected,
          marketTickAgeSec: ctrl.market?.tickAgeSec ?? null,
          llmMode: ctrl.agent?.llm || prev.llmMode,
          persistence: health?.persistence || prev.persistence,
        }));
      }
      if (Array.isArray(alerts)) {
        setState((prev) => ({ ...prev, alerts: alerts.map((a: any) => ({ id: a.id, time: a.time, level: a.level, msg: a.msg, read: a.read ?? false })) }));
      }
    } catch {
      // Ignore
    }
  }, []);

  const refreshIndices = useCallback(async () => {
    try {
      const res = await api.indices();
      const clean = Object.fromEntries(Object.entries(res?.indices || {}).filter(([, v]) => v != null));
      if (Object.keys(clean).length > 0) {
        setState((prev) => ({ ...prev, indices: clean as any }));
      }
    } catch {
      // Backend returns honest empties when no live data — keep previous
    }
  }, []);

  const addSystemLog = useCallback((level: string, message: string, source = 'system') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const reqId = `req_${Math.random().toString(36).substring(2, 8)}`;
    setState((prev) => {
      const logs = [...prev.logs, { id, time, level, message, source, reqId }];
      return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs };
    });
  }, []);

  // ── boot: REST snapshot, then WS telemetry ─────────────────────────
  useEffect(() => {
    let mounted = true;

    async function boot() {
      try {
        const health = await api.health();
        if (!mounted) return;
        setConnected(true);
        setState((prev) => ({
          ...prev,
          killed: !!health.killed,
          live: !health.killed,
          uptimeSeconds: Math.floor(health.uptime || 0),
          tradingMode: (health.mode as AppState['tradingMode']) || 'paper',
          persistence: health.persistence || prev.persistence,
        }));
      } catch {
        if (mounted) setConnected(false);
      }

      await Promise.all([
        refreshIndices(),
        refreshPortfolio(),
        refreshControlState(),
      ]);
    }

    boot();

    // When WebSocket is connected, live events push state instantly.
    // When WS is disconnected, fallback to REST polling.
    const interval = setInterval(async () => {
      try {
        if (!streamConnectedRef.current) {
          await Promise.all([refreshIndices(), refreshPortfolio(), refreshControlState()]);
        }
      } catch {
        /* noop */
      }
    }, 5000);

    // Local 1s clock tick; syncs health periodically without REST spam
    const uptimeInterval = setInterval(async () => {
      if (!mounted) return;
      setState((prev) => {
        const realized = Number(prev.funds.sessionRealizedPnl ?? prev.funds.realizedPnl ?? 0);
        const unrealized = prev.positions.reduce((acc, p) => acc + (p.unrealizedProfit || p.unrealizedPnl || 0), 0);
        const totalPnl = realized + unrealized;
        const pnlHistory = [...prev.pnlHistory, { t: Date.now(), v: Math.round(totalPnl) }];
        // 1 point/sec for a full NSE session (09:15-15:30) — chart shows the
        // actual intraday curve, not a rolling few-minute window.
        const SESSION_POINTS_CAP = 6.5 * 60 * 60;
        if (pnlHistory.length > SESSION_POINTS_CAP) pnlHistory.shift();
        return {
          ...prev,
          uptimeSeconds: prev.uptimeSeconds + 1,
          pnlHistory,
        };
      });
    }, 1000);

    return () => {
      mounted = false;
      clearInterval(interval);
      clearInterval(uptimeInterval);
    };
  }, [refreshIndices, refreshPortfolio, refreshControlState]);

  const streamConnectedRef = useRef(false);
  streamConnectedRef.current = streamConnected;

  // ── WS envelope dispatch ────────────────────────────────────────────
  // Envelopes are buffered and reduced through applyEnvelope() in a single
  // setState per animation frame, rather than once per envelope. The
  // backend already conflates ticks server-side (~10Hz per instrument,
  // see BUS-01/02), but a burst of several envelopes across ticks/orders/
  // logs can still arrive in the same JS turn — this makes one React
  // commit per frame the actual guarantee, not an accident of batching.
  const pendingEnvelopes = useRef<Envelope[]>([]);
  const frameRef = useRef<number | null>(null);

  const onEnvelope = useCallback((env: Envelope) => {
    pendingEnvelopes.current.push(env);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const batch = pendingEnvelopes.current;
      pendingEnvelopes.current = [];
      // Scanned BEFORE calling setState, not mutated from inside its
      // updater: React does not guarantee a functional updater runs
      // eagerly — it can defer to the render phase whenever the fiber
      // already has other pending lanes, which a ~10Hz tick stream makes
      // routine. Reading a flag the updater was "supposed to" have set by
      // the very next line raced that deferral and silently dropped every
      // post-fill refreshPortfolio()/refreshControlState() call whenever
      // React lost that race — undetectable without heavy load, since
      // idle sessions rarely hit a pending lane.
      let refreshPortfolioNeeded = false;
      let refreshControlStateNeeded = false;
      for (const env of batch) {
        const e = getEnvelopeEffects(env);
        refreshPortfolioNeeded = refreshPortfolioNeeded || e.refreshPortfolio;
        refreshControlStateNeeded = refreshControlStateNeeded || e.refreshControlState;
      }
      setState((prev) => batch.reduce((acc, e) => applyEnvelope(acc, e), prev));
      if (refreshPortfolioNeeded) void refreshPortfolio();
      if (refreshControlStateNeeded) void refreshControlState();
    });
  }, [refreshPortfolio, refreshControlState]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const stream = useBackendStream(onEnvelope);
  useEffect(() => {
    setStreamConnected(stream.connected);
    if (stream.connected) setConnected(true);
  }, [stream.connected]);

  const showToast = useCallback((msg: string, type: ToastType = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const openModal = useCallback((content: ReactNode) => {
    setModalContent(content);
  }, []);

  const closeModal = useCallback(() => {
    setModalContent(null);
  }, []);

  return (
    <AppContext.Provider value={{ state, setState, showToast, openModal, closeModal, toasts, modalContent, addSystemLog, refreshPortfolio, refreshControlState, connected, streamConnected }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
