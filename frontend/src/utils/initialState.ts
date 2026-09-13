import type { AppState } from '../store/types';

/**
 * Neutral initial state — NO fabricated data.
 *
 * Every field starts empty/zero and is populated exclusively from the
 * backend: REST snapshot at boot, then live WebSocket telemetry.
 * The backend is the single source of truth; this UI is a control plane.
 */
export const initialAppState: AppState = {
  live: false,
  killed: false,
  uptimeSeconds: 0,
  latency: 0,
  indices: {},
  marketSource: 'none',
  marketWsConnected: false,
  marketTickAgeSec: null,
  llmMode: 'deterministic',
  persistence: 'unknown',
  tradingMode: 'paper',
  strategies: [],
  recentFills: [],
  orders: [],
  positions: [],
  funds: { availableMargin: 0, usedMargin: 0, realizedPnl: 0, totalBalance: 0 },
  circuitBreakers: [],
  alerts: [],
  skWorkers: [],
  skRetries: [],
  mmRows: [],
  agentRunning: false,
  agentStepNum: 0,
  agentStartTime: 0,
  agentTokens: 0,
  agentDhanCalls: 0,
  eventFilter: 'all',
  telemetryEvents: [],
  agentStatus: {
    planner: { status: 'idle', steps: 0 },
    analyst: { status: 'idle', steps: 0 },
    strategy: { status: 'idle', steps: 0 },
    execution: { status: 'idle', steps: 0 },
    risk: { status: 'idle', steps: 0 },
    critic: { status: 'idle', steps: 0 },
  },
  ltmMemories: [],
  logs: [],
  logIdCounter: 0,
  alertIdCounter: 0,
  pnlHistory: [],
  rateLimitHistory: [],
  logFilter: 'important',
};
