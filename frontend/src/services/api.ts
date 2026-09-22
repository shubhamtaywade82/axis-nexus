import { log } from './logger';
import type { ExpertTrade, ExpertTradeScanSummary, ExpertTradeSchedulerStatus, ExpertTradeStatsResponse } from '../types/expertTrades';

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Optional bearer token for the control plane.
 *
 * The backend (src/server.ts) makes CONTROL_PLANE_TOKEN MANDATORY when
 * CONTROL_PLANE_HOST is not loopback, and optional (but enforced if set)
 * on loopback. The frontend reads it from VITE_CONTROL_PLANE_TOKEN at
 * build time — set it in frontend/.env.local when running the backend
 * with the token enabled, otherwise every request returns 401.
 *
 * This is deliberately a build-time constant, not a runtime fetch — a
 * runtime fetch would itself need to be unauthenticated to get the token,
 * which defeats the point. For a hosted deployment, bake the token into
 * the build via CI secrets.
 */
const CONTROL_PLANE_TOKEN = import.meta.env.VITE_CONTROL_PLANE_TOKEN || '';

/** Returns the WS URL with ?token= appended when a token is configured. */
export function wsUrlWithToken(path: string): string {
  const defaultHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const base = import.meta.env.VITE_WS_URL || `ws://${defaultHost}:3003${path}`;
  if (!CONTROL_PLANE_TOKEN) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(CONTROL_PLANE_TOKEN)}`;
}

/**
 * Central API client.
 *
 * Every request carries an `x-request-id` (UUID) — the backend echoes
 * it in logs AND on the response, so a failed order can be traced from
 * the UI click through every backend log line. Failed requests are
 * reported to the client-log ingest with endpoint, status, duration
 * and the correlation id.
 *
 * When VITE_CONTROL_PLANE_TOKEN is set, every request also carries an
 * `Authorization: Bearer <token>` header — the backend's timing-safe
 * compare (src/lib/authToken.ts) validates it before any route handler
 * runs. The header is omitted on /api/health (the backend explicitly
 * exempts health from the token gate, and an unauthenticated health
 * ping lets the dashboard show "backend down" cleanly).
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
        // Attach the bearer token on every request except /api/health
        // (which is exempt server-side and shouldn't 401 just because
        // the dashboard booted before the operator finished typing the
        // token into .env.local).
        ...(CONTROL_PLANE_TOKEN && path !== '/api/health'
          ? { Authorization: `Bearer ${CONTROL_PLANE_TOKEN}` }
          : {}),
        ...(options?.headers ?? {}),
      },
    });
  } catch (e) {
    // Network-level failure (backend down / DNS / CORS) — no response exists.
    log.error('API unreachable', {
      endpoint: path,
      method: options?.method ?? 'GET',
      durationMs: Math.round(performance.now() - started),
      kind: 'network-error',
    }, requestId);
    throw e instanceof Error ? e : new Error(`Network error calling ${path}`);
  }

  const durationMs = Math.round(performance.now() - started);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // A 401 with no token configured is a configuration error, not a
    // transient failure — surface a clear message rather than the generic
    // "Unauthorized" so the operator knows to set VITE_CONTROL_PLANE_TOKEN.
    if (res.status === 401 && !CONTROL_PLANE_TOKEN) {
      throw new Error('Backend requires a control-plane token (returned 401). Set VITE_CONTROL_PLANE_TOKEN in frontend/.env.local and rebuild.');
    }
    log.error('API request failed', {
      endpoint: path,
      method: options?.method ?? 'GET',
      status: res.status,
      statusText: res.statusText,
      durationMs,
      serverError: body?.error,
    }, requestId);
    throw new Error(body.error || `API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

/** Exported for pages that need custom endpoints (e.g. /api/scalp/*). */
export { request as apiRequest };

export const api = {
  health: () => request<{ status: string; mode: string; persistence: string; killed: boolean; autonomy: boolean; marketSource: string; uptime: number }>('/api/health'),

  indices: () => request<{ indices: Record<string, { ltp: number; change: number; pct: number; high: number; low: number; open: number; prevClose: number; updatedAt?: number } | null>; stale: boolean; source: string; error: string | null }>('/api/market/indices'),

  optionChain: (symbol: string, expiry?: string) => request<{ strikes: Array<{ strike: number; ce: any; pe: any }>; underlying: string; expiry: string }>(`/api/market/option-chain/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),

  expiries: (symbol: string) => request<{ expiries: string[]; underlying: string }>(`/api/market/expiries/${symbol}`),

  greeks: (symbol: string) => request<{ symbol: string; spot: number; expiry: string; strikes: Array<{ strike: number; ce: any; pe: any }> }>(`/api/market/greeks?symbol=${symbol}`),

  optionsAnalysis: (params?: { symbol?: string; days?: number; interval?: string; expiryFlag?: string }) => {
    const q = new URLSearchParams();
    if (params?.symbol) q.set('symbol', params.symbol);
    if (params?.days) q.set('days', String(params.days));
    if (params?.interval) q.set('interval', params.interval);
    if (params?.expiryFlag) q.set('expiryFlag', params.expiryFlag);
    return request<any>(`/api/market/options-analysis?${q.toString()}`);
  },

  quote: (securityId: string, exchange = 'NSE_FNO') => request<any>(`/api/market/quote/${securityId}?exchange=${exchange}`),

  portfolioSummary: () => request<any>('/api/portfolio/summary'),
  positions: () => request<any[]>('/api/portfolio/positions'),
  orders: () => request<any[]>('/api/portfolio/orders'),
  cancelOrder: (orderId: string, correlationId?: string) =>
    request<any>(`/api/portfolio/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ correlationId }),
    }),
  cancelAllOrders: () => request<{ cancelledCount: number }>('/api/portfolio/orders/cancel-all', { method: 'POST' }),
  trades: () => request<any[]>('/api/portfolio/trades'),
  funds: () => request<any>('/api/portfolio/funds'),
  holdings: () => request<any[]>('/api/portfolio/holdings'),
  profile: () => request<any>('/api/portfolio/profile'),

  strategies: () => request<any[]>('/api/portfolio/strategies'),
  deployStrategy: (strat: any) => request<any>('/api/portfolio/paper/strategy/deploy', { method: 'POST', body: JSON.stringify(strat) }),
  updateStrategyStatus: (id: string, status: string) => request<any>('/api/portfolio/paper/strategy/status', { method: 'POST', body: JSON.stringify({ id, status }) }),
  executeStrategy: (id: string) => request<any>('/api/portfolio/paper/strategy/execute', { method: 'POST', body: JSON.stringify({ id }) }),
  closeStrategy: (id: string) => request<any>('/api/portfolio/paper/strategy/close', { method: 'POST', body: JSON.stringify({ id }) }),
  calculateMargin: (items: any[]) => request<any>('/api/portfolio/margin/calculate', { method: 'POST', body: JSON.stringify({ items }) }),
  marginReconcile: () => request<any>('/api/portfolio/margin/reconcile'),

  placePaperOrder: (order: { symbol: string; quantity: number; transactionType: 'BUY' | 'SELL'; price?: number; orderType?: string; productType?: string; securityId?: string }) =>
    request<any>('/api/portfolio/paper/order', {
      method: 'POST',
      body: JSON.stringify(order),
    }),

  closePaperPosition: (key: { securityId: string; exchangeSegment: string; tradingSymbol?: string }, ltp?: number) =>
    request<any>('/api/portfolio/paper/positions/close', {
      method: 'POST',
      body: JSON.stringify({ ...key, ltp }),
    }),

  closePosition: (key: { securityId: string; exchangeSegment: string; tradingSymbol?: string }, ltp?: number) =>
    request<any>('/api/portfolio/positions/close', {
      method: 'POST',
      body: JSON.stringify({ ...key, ltp }),
    }),

  closeAllPositions: () =>
    request<any>('/api/portfolio/positions/close-all', { method: 'POST', body: JSON.stringify({}) }),

  resetPaperWallet: (initialBalance = 100000) =>
    request<any>('/api/portfolio/paper/wallet/reset', {
      method: 'POST',
      body: JSON.stringify({ initialBalance }),
    }),

  // ── control plane ─────────────────────────────────────────────────
  controlState: () => request<any>('/api/control/state'),

  armKillSwitch: (reason?: string) =>
    request<any>('/api/control/kill', { method: 'POST', body: JSON.stringify({ confirm: 'CONFIRM', reason }) }),

  disarmKillSwitch: () =>
    request<any>('/api/control/kill/reset', { method: 'POST', body: JSON.stringify({}) }),

  setAutonomy: (enabled: boolean) =>
    request<any>('/api/control/autonomy', { method: 'POST', body: JSON.stringify({ enabled }) }),

  squareOffAll: () =>
    request<any>('/api/control/square-off', { method: 'POST', body: JSON.stringify({ reason: 'Manual square-off from control plane' }) }),

  longOptionPolicy: () =>
    request<{ enabled: boolean; positions: Array<{ tradingSymbol: string; securityId?: string; exchangeSegment?: string; remainingQuantity: number; peakNet: number; floorNet: number; captureRatioSoFar: number | null; partialTaken: boolean }> }>('/api/control/long-option-policy'),

  setLongOptionPolicy: (enabled: boolean) =>
    request<any>('/api/control/long-option-policy', { method: 'POST', body: JSON.stringify({ enabled }) }),

  getRiskLimits: () => request<any>('/api/control/risk-limits'),

  setRiskLimits: (patch: any) =>
    request<any>('/api/control/risk-limits', { method: 'POST', body: JSON.stringify(patch) }),

  // ── agent ─────────────────────────────────────────────────────────
  runAgent: (objective: string) =>
    request<{ runId: string; status: string }>('/api/control/agent/run', { method: 'POST', body: JSON.stringify({ objective }) }),

  agentStatus: () => request<any>('/api/control/agent/status'),

  agentEvents: (limit = 100) => request<any[]>(`/api/control/agent/events?limit=${limit}`),

  agentOllamaKeys: () =>
    request<Array<{ name: string; isCoolingDown: boolean; failureCount: number; lastFailureAt: string | null; activeRequests: number }>>('/api/control/agent/ollama-keys'),

  agentTools: () => request<any[]>('/api/control/agent/tools'),

  alerts: (limit = 100) => request<any[]>(`/api/control/alerts?limit=${limit}`),

  infraStats: () => request<any>('/api/infra/stats'),

  ollamaChat: (messages: Array<{ role: string; content: string }>, model?: string) =>
    request<{ response: string; model: string }>('/api/ollama/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, model }),
    }),

  backtestStrategy: (params: { symbol?: string; type?: string; days?: number; entryType?: string; targetPct?: number; slPct?: number; timeExit?: string; lots?: number; side?: string }) =>
    request<any>('/api/control/strategy/backtest', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  ollamaHealth: () => request<{ status: string }>('/api/ollama/health'),
  ollamaModels: () => request<any>('/api/ollama/models'),

  // ── research ───────────────────────────────────────────────────────
  researchAnalyze: (symbol: string, exchange?: string) =>
    request<any>('/api/research/analyze', { method: 'POST', body: JSON.stringify({ symbol, exchange }) }),
  researchRuns: (limit = 20) => request<{ count: number; runs: any[] }>(`/api/research/runs?limit=${limit}`),
  researchRun: (runId: string) => request<any>(`/api/research/${runId}`),
  researchEvidence: (runId: string) => request<{ runId: string; count: number; evidence: any[] }>(`/api/research/${runId}/evidence`),
  researchSignal: (symbol: string) => request<any>(`/api/research/signal/${symbol}`),
  researchUniverses: (exchange = 'NSE') =>
    request<{ exchange: string; universes: any[] }>(`/api/research/universes?exchange=${exchange}`),
  researchScreen: (universe: string, preset: string, exchange = 'NSE') =>
    request<any>('/api/research/screen', { method: 'POST', body: JSON.stringify({ universe, preset, exchange }) }),
  researchScreenAndAnalyze: (universe: string, preset: string, topN = 3, exchange = 'NSE') =>
    request<any>('/api/research/screen-and-analyze', { method: 'POST', body: JSON.stringify({ universe, preset, topN, exchange }) }),
  researchWatchlist: () => request<{ count: number; watchlist: any[] }>('/api/research/watchlist'),
  researchWatchlistRefresh: (universe?: string, preset?: string, exchange = 'NSE') =>
    request<{ count: number; watchlist: any[] }>('/api/research/watchlist/refresh', { method: 'POST', body: JSON.stringify({ universe, preset, exchange }) }),
  researchSchedulerStatus: () => request<any>('/api/research/scheduler/status'),
  researchSchedulerTrigger: (phase: string) =>
    request<any>('/api/research/scheduler/trigger', { method: 'POST', body: JSON.stringify({ phase }) }),

  // Expert Trades — NSE equity trade-idea engine (deterministic entry/stop/target)
  expertTrades: (state?: string, horizon?: string, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (state) params.set('state', state);
    if (horizon) params.set('horizon', horizon);
    return request<{ count: number; trades: ExpertTrade[] }>(`/api/expert-trades?${params.toString()}`);
  },
  expertTradesPast: (limit = 50) =>
    request<{ count: number; trades: ExpertTrade[] }>(`/api/expert-trades/past?limit=${limit}`),
  expertTradeStats: () => request<ExpertTradeStatsResponse>('/api/expert-trades/stats'),
  expertTradeScannerStatus: () => request<ExpertTradeScanSummary | { scannedAt: null; message: string }>('/api/expert-trades/scanner/status'),
  expertTradeSchedulerStatus: () => request<ExpertTradeSchedulerStatus>('/api/expert-trades/scheduler/status'),
  expertTradeScan: (universe?: string, exchange = 'NSE', maxUniverse?: number, maxPublished?: number) =>
    request<ExpertTradeScanSummary>('/api/expert-trades/scan', { method: 'POST', body: JSON.stringify({ universe, exchange, maxUniverse, maxPublished }) }),
  expertTradesForSymbol: (symbol: string) =>
    request<{ count: number; trades: ExpertTrade[] }>(`/api/expert-trades/symbol/${symbol}`),
  expertTrade: (id: string) => request<ExpertTrade>(`/api/expert-trades/${id}`),
};
