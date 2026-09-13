import { Pool } from 'pg';
import type { InstrumentKey } from './lib/instrumentKey';
import { moduleLogger } from './lib/logger';
import { shouldEmitAlert } from './lib/logPolicy';
import { marketClock } from './services/marketHours';
import { eventBus } from './services/eventBus';
import { journal } from './services/journal';
import { applyFillSlippage, type FillKind } from './services/fillModel';
import { redisPublisher } from './auth';

const log = moduleLogger('db');

/**
 * Paper-trading persistence layer.
 *
 * Postgres is the durable ledger — every fill is a committed transaction.
 * `mem` is an always-on in-memory mirror of `paper_wallet`/`paper_positions`
 * that every position/wallet READ goes through (`listPaperPositions`,
 * `getPaperWallet`, `markPositionsToMarket`): mark-to-market on every tick
 * must not round-trip the connection pool. `mem` is warmed from Postgres on
 * boot and updated from the same computed result as every Postgres write, so
 * it never drifts. In fully offline mode (Postgres unreachable) `mem` is also
 * the only copy, exposed via `dbMode()` and reported by /api/health.
 *
 * ── File structure (for future gradual split into db/*.ts) ──────────────
 *
 *   Section                  Lines    Exports
 *   ──────────────────────── ──────── ──────────────────────────────────
 *   Schema + init            1–197    pool, dbMode, mem, SCHEMA_SQL,
 *                                     initDatabase, warmMemCache
 *   Alerts                   198–227  pushAlert, listAlerts, mapAlertRow
 *   Self-healing patterns    228–288  recordErrorPattern, listErrorPatterns,
 *                                     ruleExistsForPattern, promoteRule,
 *                                     getActiveRules
 *   Agent events             289–322  pushAgentEvent, listAgentEvents,
 *                                     mapAgentEventRow
 *   Risk state               323–358  getRiskState, saveRiskState
 *   Options analysis cache   359–385  getOptionsAnalysisCache,
 *                                     saveOptionsAnalysisCache
 *   Strategies               386–543  listPaperStrategies,
 *                                     createPaperStrategy,
 *                                     updatePaperStrategyStatus,
 *                                     closeParentStrategyIfFlat,
 *                                     deletePaperStrategy
 *   Wallet                   544–625  getPaperWallet, adjustWalletMargin,
 *                                     resetPaperWallet
 *   Orders + positions       626–1022 listPaperOrders, getTodayOrderStats,
 *                                     calculateOrderCharges,
 *                                     executePaperOrder, closePaperPosition,
 *                                     markPositionsToMarket,
 *                                     listPaperPositions,
 *                                     closeAllPaperPositions
 *   Ledger reconciliation    1023–1181 reconcileLedger,
 *                                     correctLedgerFromPostgres,
 *                                     findMissingOrders
 *   Research                 1182–end saveResearchRun, getResearchRun,
 *                                     listResearchRuns,
 *                                     saveResearchEvidence,
 *                                     getResearchEvidenceByRun
 *
 * All sections share the `mem` cache object and the `mode` variable —
 * splitting into per-domain modules requires moving those into a
 * `db/core.ts` that everything imports. Deferred to a dedicated refactor
 * PR; this TOC makes the structure navigable in the meantime.
 */

const connectionString = process.env.DATABASE_URL || 'postgres://nemesis@localhost:5432/dhanhq_node_development';

export const pool = new Pool({
  connectionString,
  // Tunable: autonomy/risk/ledger reads can saturate a small pool in broker
  // mode under fast markets. Default 10 for paper (matches prior behavior);
  // raise via PG_POOL_MAX for live/broker deployments.
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
});

// Defaults to memory under test, NOT postgres: initDatabase() applies the
// same rule, but a test that writes without calling it first would otherwise
// hit the real dev database. Found live — research_watchlist/screener_runs in
// the dev DB were entirely jest fixtures from researchScheduler.test.ts and
// researchRepository.test.ts, rewritten on every `npx jest` run, because
// neither calls initDatabase().
let mode: 'postgres' | 'memory' =
  process.env.NODE_ENV === 'test' && !process.env.TEST_DATABASE_URL ? 'memory' : 'postgres';
export function dbMode(): 'postgres' | 'memory' {
  return mode;
}

// ── in-memory wallet/position cache (always-on, see header) ───────────────
const mem = {
  wallet: { id: 'default', initial_balance: 100000, available_margin: 100000, used_margin: 0, realized_pnl: 0, total_charges: 0, session_realized_base: 0, session_date: null as string | null, updated_at: new Date() },
  orders: [] as any[],
  positions: new Map<string, any>(),
  strategies: [] as any[],
  optionsCache: new Map<string, any>(),
  alerts: [] as any[],
  agentEvents: [] as any[],
  riskState: null as any,
  errorPatterns: new Map<string, any>(),
  systemRules: [] as any[],
  researchRuns: new Map<string, any>(),
  researchEvidence: new Map<string, any[]>(),
  autoid: 0,
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS paper_wallet (
    id VARCHAR(32) PRIMARY KEY DEFAULT 'default', initial_balance NUMERIC(14, 2) NOT NULL DEFAULT 100000.00,
    available_margin NUMERIC(14, 2) NOT NULL DEFAULT 100000.00, used_margin NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_orders (
    id VARCHAR(64) PRIMARY KEY, correlation_id VARCHAR(64), symbol VARCHAR(64) NOT NULL,
    security_id VARCHAR(32), exchange_segment VARCHAR(32) DEFAULT 'NSE_FNO', transaction_type VARCHAR(16) NOT NULL,
    order_type VARCHAR(16) NOT NULL DEFAULT 'MARKET', product_type VARCHAR(16) NOT NULL DEFAULT 'INTRADAY',
    quantity INTEGER NOT NULL, price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, trigger_price NUMERIC(12, 2) DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', filled_qty INTEGER NOT NULL DEFAULT 0,
    avg_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_positions (
    id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(64) NOT NULL, security_id VARCHAR(32),
    exchange_segment VARCHAR(32) DEFAULT 'NSE_FNO', product_type VARCHAR(16) DEFAULT 'INTRADAY',
    buy_qty INTEGER NOT NULL DEFAULT 0, buy_avg NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    sell_qty INTEGER NOT NULL DEFAULT 0, sell_avg NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_qty INTEGER NOT NULL DEFAULT 0, realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    unrealized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00, ltp NUMERIC(12, 2) NOT NULL DEFAULT 0.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_strategies (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL, symbol VARCHAR(32) NOT NULL,
    strategy_type VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
    lots INTEGER NOT NULL DEFAULT 1, entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    legs JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS options_behavior_analysis (
    id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(32) NOT NULL, date VARCHAR(16) NOT NULL,
    interval VARCHAR(16) NOT NULL DEFAULT '1', data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY, level VARCHAR(16) NOT NULL DEFAULT 'INFO',
    source VARCHAR(64) NOT NULL DEFAULT 'system', message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS agent_events (
    id SERIAL PRIMARY KEY, run_id VARCHAR(64) NOT NULL, agent VARCHAR(32) NOT NULL,
    type VARCHAR(24) NOT NULL, summary TEXT, tool VARCHAR(64), response TEXT,
    duration_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS risk_state (
    id VARCHAR(16) PRIMARY KEY DEFAULT 'default', killed BOOLEAN NOT NULL DEFAULT FALSE,
    killed_reason TEXT, limits JSONB NOT NULL DEFAULT '{}',
    consecutive_losses INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS error_patterns (
    pattern TEXT PRIMARY KEY, level VARCHAR(16) NOT NULL, source VARCHAR(64) NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS system_rules (
    id SERIAL PRIMARY KEY, rule TEXT NOT NULL, pattern TEXT NOT NULL UNIQUE,
    hit_count INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS research_runs (
    id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(32) NOT NULL,
    exchange VARCHAR(16) NOT NULL DEFAULT 'NSE', status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    quality_score NUMERIC(5, 2), valuation_score NUMERIC(5, 2), verdict VARCHAR(16),
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS research_evidence (
    id VARCHAR(64) PRIMARY KEY, run_id VARCHAR(64) NOT NULL,
    category VARCHAR(32) NOT NULL, claim TEXT NOT NULL,
    metric VARCHAR(64), value NUMERIC(16, 4), source VARCHAR(64) NOT NULL,
    confidence NUMERIC(4, 2) NOT NULL DEFAULT 1.0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO paper_wallet (id, initial_balance, available_margin, used_margin, realized_pnl)
  VALUES ('default', 100000.00, 100000.00, 0.00, 0.00)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO risk_state (id, killed, limits) VALUES ('default', FALSE, '{}')
  ON CONFLICT (id) DO NOTHING;
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS charges NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS stop_loss NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS target NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trailing_stop NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS margin_blocked NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS total_charges NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_strategies ADD COLUMN IF NOT EXISTS margin_hedge_credit NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS session_realized_base NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS session_date VARCHAR(10);
  ALTER TABLE risk_state ADD COLUMN IF NOT EXISTS killed_date VARCHAR(10);
`;

export async function initDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_DATABASE_URL) {
    mode = 'memory';
    return;
  }
  const client = await pool.connect().catch(() => null);
  if (!client) {
    mode = 'memory';
    log.warn('PostgreSQL unreachable — running with in-memory paper trading state (not durable)');
    return;
  }
  try {
    await client.query(SCHEMA_SQL);
    mode = 'postgres';
    log.info('PostgreSQL paper trading tables initialized');
  } catch (e: any) {
    mode = 'memory';
    log.warn({ err: { message: e.message } }, 'Schema init failed — falling back to in-memory mode');
  } finally {
    client.release();
  }
  if (mode === 'postgres') await warmMemCache();
}

/** One-time load of the wallet/positions/today's-orders ledger into the
 * in-memory cache on boot — orders are warmed so the risk engine's
 * same-day consecutive-loss counter survives a restart. */
async function warmMemCache(): Promise<void> {
  try {
    const walletRes = await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['default']);
    if (walletRes.rows[0]) mem.wallet = walletRes.rows[0];
    const posRes = await pool.query('SELECT * FROM paper_positions');
    mem.positions.clear();
    for (const row of posRes.rows) mem.positions.set(row.id, row);
    const ordersRes = await pool.query('SELECT * FROM paper_orders WHERE created_at >= CURRENT_DATE ORDER BY created_at DESC LIMIT 500');
    mem.orders = ordersRes.rows;
    log.info({ positions: mem.positions.size, orders: mem.orders.length }, 'Warmed in-memory paper-trading cache from PostgreSQL');
  } catch (e: any) {
    log.warn({ err: { message: e.message } }, 'Failed to warm in-memory paper-trading cache from PostgreSQL');
  }
}

// ── alerts ──────────────────────────────────────────────────────────────
export async function pushAlert(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string) {
  if (!shouldEmitAlert(level, source, message)) return;
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO alerts (level, source, message) VALUES ($1, $2, $3)', [level, source, message]);
    } catch { /* non-fatal */ }
  } else {
    mem.alerts.unshift({ id: ++mem.autoid, level, source, message, created_at: new Date() });
    if (mem.alerts.length > 200) mem.alerts.pop();
  }
}

export async function listAlerts(limit = 100) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows.map(mapAlertRow);
    } catch { return []; }
  }
  return mem.alerts.slice(0, limit).map(mapAlertRow);
}

function mapAlertRow(r: any) {
  return {
    id: Number(r.id), time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false }),
    level: r.level, source: r.source, msg: r.message, read: false, createdAt: r.created_at,
  };
}

// ── self-healing: error patterns + promoted rules ─────────────────────────
export async function recordErrorPattern(level: 'WARN' | 'ERROR', source: string, pattern: string) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO error_patterns (pattern, level, source) VALUES ($1, $2, $3)
         ON CONFLICT (pattern) DO UPDATE SET hit_count = error_patterns.hit_count + 1, last_seen = NOW()`,
        [pattern, level, source],
      );
    } catch { /* non-fatal */ }
  } else {
    const existing = mem.errorPatterns.get(pattern);
    if (existing) { existing.hit_count++; existing.last_seen = new Date(); }
    else mem.errorPatterns.set(pattern, { pattern, level, source, hit_count: 1, first_seen: new Date(), last_seen: new Date() });
  }
}

export async function listErrorPatterns(minHits = 2) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM error_patterns WHERE hit_count >= $1 ORDER BY hit_count DESC', [minHits]);
      return res.rows;
    } catch { return []; }
  }
  return [...mem.errorPatterns.values()].filter((p) => p.hit_count >= minHits);
}

export async function ruleExistsForPattern(pattern: string): Promise<boolean> {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT 1 FROM system_rules WHERE pattern = $1 LIMIT 1', [pattern]);
      return (res.rowCount ?? 0) > 0;
    } catch { return false; }
  }
  return mem.systemRules.some((r) => r.pattern === pattern);
}

export async function promoteRule(rule: string, pattern: string, hitCount: number) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO system_rules (rule, pattern, hit_count) VALUES ($1, $2, $3)
         ON CONFLICT (pattern) DO UPDATE SET rule = $1, hit_count = $3`,
        [rule, pattern, hitCount],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.systemRules.unshift({ id: ++mem.autoid, rule, pattern, hit_count: hitCount, active: true, created_at: new Date() });
  }
}

export async function getActiveRules(limit = 20) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT rule FROM system_rules WHERE active = TRUE ORDER BY hit_count DESC LIMIT $1', [limit]);
      return res.rows.map((r) => r.rule as string);
    } catch { return []; }
  }
  return mem.systemRules.filter((r) => r.active).slice(0, limit).map((r) => r.rule as string);
}

// ── agent events ────────────────────────────────────────────────────────
export async function pushAgentEvent(ev: { run_id: string; agent: string; type: string; summary?: string; tool?: string; response?: string; duration_ms?: number }) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        'INSERT INTO agent_events (run_id, agent, type, summary, tool, response, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ev.run_id, ev.agent, ev.type, ev.summary ?? null, ev.tool ?? null, ev.response ?? null, ev.duration_ms ?? null],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.agentEvents.unshift({ id: ++mem.autoid, ...ev, created_at: new Date() });
    if (mem.agentEvents.length > 400) mem.agentEvents.pop();
  }
}

export async function listAgentEvents(limit = 100) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM agent_events ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows.map(mapAgentEventRow);
    } catch { return []; }
  }
  return mem.agentEvents.slice(0, limit).map(mapAgentEventRow);
}

function mapAgentEventRow(r: any) {
  return {
    id: `aev_${r.id}`, runId: r.run_id, agent: r.agent, type: r.type,
    summary: r.summary, tool: r.tool, response: r.response,
    duration: r.duration_ms ?? undefined,
    time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false }),
  };
}

// ── risk state ──────────────────────────────────────────────────────────
export async function getRiskState() {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM risk_state WHERE id = $1', ['default']);
      if (res.rows.length) return { killed: res.rows[0].killed, killedReason: res.rows[0].killed_reason, killedDate: res.rows[0].killed_date || null, limits: res.rows[0].limits || {}, consecutiveLosses: Number(res.rows[0].consecutive_losses || 0) };
    } catch { /* fall through */ }
  }
  return mem.riskState || { killed: false, killedReason: null, killedDate: null, limits: {}, consecutiveLosses: 0 };
}

export async function saveRiskState(state: { killed: boolean; killedReason?: string | null; killedDate?: string | null; limits?: any; consecutiveLosses?: number }) {
  const current = mem.riskState || { killed: false, killedReason: null, killedDate: null, limits: {}, consecutiveLosses: 0 };
  const merged = {
    killed: state.killed,
    killedReason: state.killedReason ?? null,
    killedDate: state.killedDate ?? (state.killed ? current.killedDate : null) ?? null,
    limits: state.limits ?? current.limits ?? {},
    consecutiveLosses: state.consecutiveLosses ?? current.consecutiveLosses ?? 0,
  };
  // Mirror synchronously FIRST — readers (incl. a RiskEngine booting in the
  // same tick) must never observe stale state while PG persistence runs.
  mem.riskState = merged;
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO risk_state (id, killed, killed_reason, killed_date, limits, consecutive_losses)
         VALUES ('default', $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET killed = $1, killed_reason = $2, killed_date = $3, limits = $4, consecutive_losses = $5, updated_at = NOW()`,
        [merged.killed, merged.killedReason, merged.killedDate, JSON.stringify(merged.limits), merged.consecutiveLosses],
      );
    } catch { /* non-fatal */ }
  }
  return merged;
}

// ── options analysis cache ──────────────────────────────────────────────
export async function getOptionsAnalysisCache(symbol: string, date: string, interval: string) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT data FROM options_behavior_analysis WHERE id = $1', [`${symbol}_${date}_${interval}`]);
      return res.rows.length > 0 ? res.rows[0].data : null;
    } catch { return null; }
  }
  return mem.optionsCache.get(`${symbol}_${date}_${interval}`) || null;
}

export async function saveOptionsAnalysisCache(symbol: string, date: string, interval: string, data: any) {
  const id = `${symbol}_${date}_${interval}`;
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO options_behavior_analysis (id, symbol, date, interval, data, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $5, created_at = NOW()`,
        [id, symbol, date, interval, JSON.stringify(data)],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.optionsCache.set(id, data);
  }
}

// ── strategies ──────────────────────────────────────────────────────────
export async function listPaperStrategies() {
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_strategies ORDER BY updated_at DESC').catch(() => ({ rows: [] }))).rows
    : [...mem.strategies].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return rows.map((r: any) => ({
    id: r.id, name: r.name, symbol: r.symbol, type: r.strategy_type, status: r.status,
    lots: Number(r.lots),
    entryTime: new Date(r.entry_time).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    legs: r.legs || [], pnl: 0,
    marginHedgeCredit: Number(r.margin_hedge_credit || 0),
  }));
}

export async function createPaperStrategy(s: { id?: string; name: string; symbol: string; type: string; lots: number; legs: any[]; status?: string; marginHedgeCredit?: number }) {
  const id = s.id || `strat_${Date.now().toString(36)}`;
  const status = s.status || 'RUNNING';
  const marginHedgeCredit = s.marginHedgeCredit || 0;
  if (mode === 'postgres') {
    await pool.query(
      `INSERT INTO paper_strategies (id, name, symbol, strategy_type, status, lots, legs, margin_hedge_credit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, symbol = $3, strategy_type = $4, status = $5, lots = $6, legs = $7, margin_hedge_credit = $8, updated_at = NOW()`,
      [id, s.name, s.symbol, s.type, status, s.lots, JSON.stringify(s.legs), marginHedgeCredit],
    );
  } else {
    mem.strategies.unshift({ id, name: s.name, symbol: s.symbol, strategy_type: s.type, status, lots: s.lots, legs: s.legs, margin_hedge_credit: marginHedgeCredit, entry_time: new Date(), updated_at: new Date() });
  }
  return { id, status };
}

// Centralized so every close path (manual close route, autonomy's
// loss-limit stop, the kill switch) reverses a strategy's hedge-margin
// credit exactly once — callers never need to remember to do it themselves.
export async function updatePaperStrategyStatus(id: string, status: string) {
  if (status === 'STOPPED') {
    const hedgeCredit = mode === 'postgres'
      ? Number((await pool.query('SELECT margin_hedge_credit FROM paper_strategies WHERE id = $1', [id]).catch(() => ({ rows: [] }))).rows[0]?.margin_hedge_credit || 0)
      : Number(mem.strategies.find((x) => x.id === id)?.margin_hedge_credit || 0);
    if (hedgeCredit > 0) {
      await adjustWalletMargin(-hedgeCredit);
      if (mode === 'postgres') {
        await pool.query('UPDATE paper_strategies SET margin_hedge_credit = 0 WHERE id = $1', [id]).catch(() => {});
      } else {
        const s = mem.strategies.find((x) => x.id === id);
        if (s) s.margin_hedge_credit = 0;
      }
    }
  }
  if (mode === 'postgres') {
    await pool.query('UPDATE paper_strategies SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  } else {
    const s = mem.strategies.find((x) => x.id === id);
    if (s) { s.status = status; s.updated_at = new Date(); }
  }
  return { id, status };
}

/** A leg closing via ANY exit path (SL/target/trailing, the long-option
 * giveback policy, a manual close) never tells the parent strategy on its
 * own — it stays RUNNING forever, with stale PnL, once all its legs are
 * flat. Shared so every exit path reconciles the same way instead of each
 * needing to remember to (found live: LongOptionPositionManager.sell()
 * didn't, leaving a fully-closed single-leg strategy stuck RUNNING).
 * `openPositions` is caller-supplied (paper ledger or the live/broker
 * PortfolioSource — whichever this exit path actually reads) rather than
 * fetched here, so this stays agnostic to which one applies. */
export async function closeParentStrategyIfFlat(tradingSymbol: string, openPositions: Array<{ tradingSymbol: string; netQty: number; securityId?: string }>): Promise<void> {
  const strategies = await listPaperStrategies();
  const secMap = new Map(openPositions.filter((p) => p.securityId).map((p) => [String(p.securityId), p]));
  const posMap = new Map(openPositions.map((p) => [p.tradingSymbol, p]));
  const strat = strategies.find((s: any) =>
    s.status === 'RUNNING' &&
    (s.legs || []).some((l: any) => l.instrument === tradingSymbol || (l.securityId && secMap.get(String(l.securityId))?.tradingSymbol === tradingSymbol)),
  );
  if (!strat) return;
  const stillOpen = (strat.legs || []).some((l: any) => {
    const p = posMap.get(l.instrument) || (l.securityId ? secMap.get(String(l.securityId)) : undefined);
    return Number(p?.netQty || 0) !== 0;
  });
  if (!stillOpen) await updatePaperStrategyStatus(strat.id, 'STOPPED');
}

export async function deletePaperStrategy(id: string) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM paper_strategies WHERE id = $1', [id]);
  } else {
    mem.strategies = mem.strategies.filter((x) => x.id !== id);
  }
  return { id, status: 'deleted' };
}

/** `realized_pnl` on the wallet is a LIFETIME counter (feeds equity, never
 * reset). "Daily loss limit" needs a number scoped to the current IST
 * trading session instead — this snapshots the lifetime total at the start
 * of each new session so callers can subtract it back out. Runs on every
 * getPaperWallet() read (cheap: one string compare) rather than a scheduler,
 * so it self-heals whenever the process happens to be up across the
 * rollover, restart included. */
async function ensureWalletSessionRolled(): Promise<void> {
  const today = marketClock().istDate;
  const w = mem.wallet as any;
  if (w.session_date === today) return;
  w.session_realized_base = Number(w.realized_pnl);
  w.session_date = today;
  if (mode === 'postgres') {
    await pool.query(
      'UPDATE paper_wallet SET session_realized_base = $1, session_date = $2, updated_at = NOW() WHERE id = $3',
      [w.session_realized_base, today, w.id],
    ).catch(() => {});
  }
}

/**
 * True required margin RIGHT NOW, derived from ground truth rather than the
 * incrementally-tracked wallet columns: SUM(margin_blocked) over open
 * positions is provably correct (each position's own row is set directly
 * from a real margin-resolver call on that fill, never touched by anything
 * else) minus any hedge-margin credit still outstanding on a RUNNING
 * multi-leg strategy (the combined SPAN requirement is less than the sum of
 * each leg's standalone margin — see adjustWalletMargin/createPaperStrategy).
 *
 * The wallet's own used_margin/available_margin columns are still written
 * incrementally on every fill (adjustWalletMargin, executePaperOrder's
 * marginDelta) but are no longer READ for anything — found live, quantified
 * via direct DB query: used_margin had drifted ₹134,062 negative vs. this
 * derived value, because the credit given at multi-leg deploy time is only
 * reliably reversed if updatePaperStrategyStatus('STOPPED') fires for that
 * exact strategy — closeParentStrategyIfFlat's leg lookup is a plain string
 * match (autonomy.ts) that can silently miss, permanently leaking the
 * credit into the wallet total when it does. Deriving here instead of
 * fixing every possible way that reversal can be missed makes the SERVED
 * number correct regardless — self-healing, not one more special case.
 *
 * A strategy's `status` column can ALSO be stuck stale at 'RUNNING' (the
 * exact same missed-reversal bug) even after every one of its legs is
 * actually flat — trusting status alone would keep subtracting a credit for
 * a structure that's fully closed. So a credit only counts when the
 * strategy is RUNNING *and* at least one of its own legs still has a real
 * open position — cross-checked against live position state, not the
 * possibly-stale status flag.
 */
function computeDerivedMargin(): { usedMargin: number; availableMargin: number } {
  let usedMargin = 0;
  for (const pos of mem.positions.values()) {
    if (Number(pos.net_qty) !== 0) usedMargin += Number(pos.margin_blocked || 0);
  }
  for (const strat of mem.strategies) {
    if (strat.status !== 'RUNNING' || !Number(strat.margin_hedge_credit || 0)) continue;
    const legs: any[] = strat.legs || [];
    const stillOpen = legs.some((l) => Number(mem.positions.get(String(l.instrument).toUpperCase())?.net_qty || 0) !== 0);
    if (stillOpen) usedMargin -= Number(strat.margin_hedge_credit || 0);
  }
  const w = mem.wallet as any;
  const availableMargin = Number(w.initial_balance) + Number(w.realized_pnl) - usedMargin - Number(w.total_charges || 0);
  return { usedMargin: Number(usedMargin.toFixed(2)), availableMargin: Number(availableMargin.toFixed(2)) };
}

// ── wallet ──────────────────────────────────────────────────────────────
// Reads always come from `mem` (see header) — Postgres is written to on every
// fill but never read back on the hot path.
export async function getPaperWallet() {
  const w = mem.wallet as any;
  if (!w) {
    return { availableMargin: 100000, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0, unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 100000, equity: 100000, spanMargin: 0, exposureMargin: 0 };
  }
  await ensureWalletSessionRolled();
  const { usedMargin, availableMargin } = computeDerivedMargin();
  const realizedPnl = Number(w.realized_pnl);
  const sessionRealizedPnl = realizedPnl - Number(w.session_realized_base || 0);
  const totalCharges = Number(w.total_charges || 0);
  const initialBalance = Number(w.initial_balance);
  let unrealizedPnl = 0;
  for (const pos of mem.positions.values()) {
    const netQty = Number(pos.net_qty);
    if (netQty === 0) continue;
    unrealizedPnl += computeUnrealized(netQty, Number(pos.buy_avg), Number(pos.sell_avg), Number(pos.ltp));
  }
  return {
    availableMargin, usedMargin, realizedPnl, sessionRealizedPnl, unrealizedPnl, totalCharges,
    netRealizedPnl: Number((realizedPnl - totalCharges).toFixed(2)),
    totalBalance: availableMargin + usedMargin,
    // Net worth: capital + booked P&L + open P&L, net of charges — distinct
    // from availableMargin (the trading-gate number margin blocks reduce).
    equity: Number((initialBalance + realizedPnl + unrealizedPnl - totalCharges).toFixed(2)),
    spanMargin: Number((usedMargin * 0.7).toFixed(2)),
    exposureMargin: Number((usedMargin * 0.3).toFixed(2)),
  };
}

/** One-off adjustment to blocked margin outside the per-fill delta flow —
 * used to apply/reverse a multi-leg strategy's hedge-margin benefit (the
 * combined SPAN requirement across legs is usually less than the sum of
 * each leg's standalone margin). Positive `delta` releases margin back to
 * available; negative re-blocks it. */
export async function adjustWalletMargin(delta: number): Promise<void> {
  if (!delta) return;
  mem.wallet.used_margin = Number(mem.wallet.used_margin) - delta;
  mem.wallet.available_margin = Number(mem.wallet.available_margin) + delta;
  mem.wallet.updated_at = new Date();
  if (mode === 'postgres') {
    await pool.query(
      `UPDATE paper_wallet SET used_margin = used_margin - $1, available_margin = available_margin + $1, updated_at = NOW() WHERE id = 'default'`,
      [delta],
    ).catch(() => {});
  }
}

export async function resetPaperWallet(initialBalance = 100000) {
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE paper_wallet SET initial_balance = $1, available_margin = $1, used_margin = 0, realized_pnl = 0, total_charges = 0, session_realized_base = 0, session_date = NULL, updated_at = NOW() WHERE id = 'default'`,
        [initialBalance],
      );
      await client.query('DELETE FROM paper_positions');
      await client.query('DELETE FROM paper_orders');
      await client.query('DELETE FROM alerts');
      await client.query('DELETE FROM agent_events');
      await client.query(`UPDATE risk_state SET killed = FALSE, killed_reason = NULL, killed_date = NULL, limits = '{}', consecutive_losses = 0, updated_at = NOW() WHERE id = 'default'`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  // The in-memory cache is the read path in both modes — always reset it.
  mem.wallet = { id: 'default', initial_balance: initialBalance, available_margin: initialBalance, used_margin: 0, realized_pnl: 0, total_charges: 0, session_realized_base: 0, session_date: null, updated_at: new Date() };
  mem.orders = [];
  mem.positions.clear();
  mem.alerts = [];
  mem.agentEvents = [];
  mem.riskState = { killed: false, killedReason: null, limits: {}, consecutiveLosses: 0 };
  return { status: 'ok', initialBalance };
}

// ── orders ──────────────────────────────────────────────────────────────
// Full order history — not a hot-path read (no per-tick caller), so this
// still queries Postgres for durability beyond `mem`'s same-day window.
export async function listPaperOrders() {
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 100').catch(() => ({ rows: [] }))).rows
    : mem.orders.slice(0, 100);
  return rows.map((r: any) => ({
    id: r.id,
    corr: r.correlation_id,
    time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    instrument: r.symbol,
    type: r.order_type,
    side: r.transaction_type,
    qty: Number(r.quantity),
    price: Number(r.price),
    filled: Number(r.filled_qty),
    avg: Number(r.avg_price),
    charges: Number(r.charges || 0),
    leg: 'ENTRY_LEG',
    status: r.status,
    jid: r.correlation_id || r.id,
    latency: r.latency_ms != null ? `${r.latency_ms}ms` : '—',
    createdAt: r.created_at,
  }));
}

export async function getTodayOrderStats() {
  const today = new Date().toDateString();
  // Oldest-first, matching the original ORDER BY ASC — the loop below reads
  // backwards from the most recent order.
  const rows = mem.orders.filter((o: any) => new Date(o.created_at).toDateString() === today).slice().reverse();
  let consecutiveLosses = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const realized = Number(rows[i].realized_pnl || 0);
    if (realized < 0) consecutiveLosses++;
    else break;
  }
  return {
    total: rows.length,
    filled: rows.filter((r: any) => r.status === 'TRADED').length,
    rejected: rows.filter((r: any) => r.status === 'REJECTED').length,
    consecutiveLosses,
  };
}

export interface PaperOrderInput {
  symbol: string;
  securityId?: string;
  exchangeSegment?: string;
  transactionType: 'BUY' | 'SELL';
  orderType?: 'MARKET' | 'LIMIT';
  productType?: 'INTRADAY' | 'MARGIN' | 'CNC';
  quantity: number;
  price?: number;
  correlationId?: string;
  realizedPnl?: number;
  stopLoss?: number;
  target?: number;
  trailingStop?: number;
}

/** Resolves the margin required to hold a position, given price/quantity. */
export type MarginResolver = (params: { side: 'BUY' | 'SELL'; securityId: string; exchangeSegment: string; productType: string; quantity: number; price: number }) => Promise<number>;

// Last-resort placeholder for when the live DhanHQ margin API is unreachable.
// Real SPAN + exposure margin for a short option is not a fixed multiple of
// premium — this only ever runs if the caller's real-margin-API resolver
// (see PaperExecutionEngine) throws. ponytail: revisit if this path is ever
// observed to actually fire in practice; until then it's a safety net, not a
// pricing model.
const FALLBACK_SHORT_MARGIN_MULTIPLE = 10;

export const defaultMarginResolver: MarginResolver = async ({ side, quantity, price }) => {
  if (side === 'BUY') return quantity * price; // long options: full premium, no leverage
  return quantity * price * FALLBACK_SHORT_MARGIN_MULTIPLE;
};

type PositionUpdate = ReturnType<typeof calculateBuyUpdate>;

/** Margin required to hold the *resulting* position after this fill. Long
 * legs are deterministic (full premium); short legs go through the resolver
 * so short-margin math lives with whoever holds the broker client, not here. */
async function resolveMarginRequired(u: PositionUpdate, securityId: string, exchangeSegment: string, productType: string, resolver: MarginResolver): Promise<number> {
  if (u.netQty === 0) return 0;
  if (u.netQty > 0) return u.netQty * u.buyAvg;
  return resolver({ side: 'SELL', securityId, exchangeSegment, productType, quantity: Math.abs(u.netQty), price: u.sellAvg });
}

/** Per-fill F&O charges (not round-trip): brokerage on every fill, STT only
 * on the sell leg, stamp duty only on the buy leg — Indian options rules. */
export function calculateOrderCharges(side: 'BUY' | 'SELL', price: number, qty: number): number {
  const turnover = price * qty;
  const brokerage = 20;
  const stt = side === 'SELL' ? Number((turnover * 0.0010).toFixed(2)) : 0;
  const stampDuty = side === 'BUY' ? Number((turnover * 0.00003).toFixed(2)) : 0;
  const exchange = Number((turnover * 0.0005).toFixed(2));
  const sebiFee = Number((turnover * 0.0000001).toFixed(2)); // ~₹10/crore
  const gst = Number(((brokerage + exchange) * 0.18).toFixed(2));
  return Number((brokerage + stt + stampDuty + exchange + sebiFee + gst).toFixed(2));
}

function calculateBuyUpdate(pos: any, qty: number, price: number) {
  const curNet = Number(pos?.net_qty || 0);
  const curBuyQty = Number(pos?.buy_qty || 0);
  const curBuyAvg = Number(pos?.buy_avg || 0);
  const curSellAvg = Number(pos?.sell_avg || 0);

  if (curNet >= 0) {
    const newQty = curBuyQty + qty;
    const newAvg = (curBuyAvg * curBuyQty + price * qty) / newQty;
    return { buyQty: newQty, buyAvg: newAvg, sellQty: Number(pos?.sell_qty || 0), sellAvg: curSellAvg, netQty: curNet + qty, realized: 0 };
  }
  const closeQty = Math.min(Math.abs(curNet), qty);
  const realized = (curSellAvg - price) * closeQty;
  const remQty = qty - closeQty;
  const newBuyQty = curBuyQty + remQty;
  const newBuyAvg = remQty > 0 ? price : curBuyAvg;
  return { buyQty: newBuyQty, buyAvg: newBuyAvg, sellQty: Number(pos?.sell_qty || 0), sellAvg: curSellAvg, netQty: curNet + qty, realized };
}

function calculateSellUpdate(pos: any, qty: number, price: number) {
  const curNet = Number(pos?.net_qty || 0);
  const curSellQty = Number(pos?.sell_qty || 0);
  const curBuyAvg = Number(pos?.buy_avg || 0);
  const curSellAvg = Number(pos?.sell_avg || 0);

  if (curNet <= 0) {
    const newQty = curSellQty + qty;
    const newAvg = (curSellAvg * curSellQty + price * qty) / newQty;
    return { buyQty: Number(pos?.buy_qty || 0), buyAvg: curBuyAvg, sellQty: newQty, sellAvg: newAvg, netQty: curNet - qty, realized: 0 };
  }
  const closeQty = Math.min(curNet, qty);
  const realized = (price - curBuyAvg) * closeQty;
  const remQty = qty - closeQty;
  const newSellQty = curSellQty + remQty;
  const newSellAvg = remQty > 0 ? price : curSellAvg;
  return { buyQty: Number(pos?.buy_qty || 0), buyAvg: curBuyAvg, sellQty: newSellQty, sellAvg: newSellAvg, netQty: curNet - qty, realized };
}

/** Records one fill in the in-memory order log — the read path for
 * `listPaperOrders`/`getTodayOrderStats` regardless of mode (see header). */
function pushOrderToMem(orderId: string, sym: string, securityId: string, exchangeSegment: string, input: PaperOrderInput, qty: number, fillPrice: number, latencyMs: number, realizedDelta: number, charges: number): void {
  mem.orders.unshift({
    id: orderId, correlation_id: input.correlationId || `corr_${orderId}`, symbol: sym,
    security_id: securityId, exchange_segment: exchangeSegment,
    transaction_type: input.transactionType, order_type: input.orderType || 'MARKET',
    product_type: input.productType || 'INTRADAY', quantity: qty, price: fillPrice,
    status: 'TRADED', filled_qty: qty, avg_price: fillPrice, latency_ms: latencyMs,
    realized_pnl: realizedDelta, charges, created_at: new Date(), updated_at: new Date(),
  });
  if (mem.orders.length > 500) mem.orders.pop();
}

/** Applies one fill's computed result to the in-memory cache — the single
 * write path for both Postgres mode (mirror after commit) and memory mode
 * (the only write). Never recomputed independently from the Postgres write. */
function applyFillToMem(sym: string, u: PositionUpdate, newRealized: number, ltp: number, marginRequired: number, input: PaperOrderInput, charges: number): void {
  const curPos = mem.positions.get(sym);
  const marginDelta = marginRequired - Number(curPos?.margin_blocked || 0);
  mem.positions.set(sym, {
    id: sym, symbol: sym,
    security_id: input.securityId || curPos?.security_id || '0',
    exchange_segment: input.exchangeSegment || curPos?.exchange_segment || 'NSE_FNO',
    product_type: input.productType || curPos?.product_type || 'INTRADAY',
    buy_qty: u.buyQty, buy_avg: u.buyAvg, sell_qty: u.sellQty, sell_avg: u.sellAvg, net_qty: u.netQty,
    realized_pnl: newRealized, ltp, margin_blocked: marginRequired,
    unrealized_pnl: curPos?.unrealized_pnl ?? 0,
    stop_loss: input.stopLoss ?? curPos?.stop_loss ?? null,
    target: input.target ?? curPos?.target ?? null,
    trailing_stop: input.trailingStop ?? curPos?.trailing_stop ?? null,
    updated_at: new Date(),
  });
  mem.wallet.realized_pnl = Number(mem.wallet.realized_pnl) + u.realized;
  mem.wallet.available_margin = Number(mem.wallet.available_margin) + u.realized - marginDelta - charges;
  mem.wallet.used_margin = Number(mem.wallet.used_margin) + marginDelta;
  mem.wallet.total_charges = Number(mem.wallet.total_charges || 0) + charges;
  mem.wallet.updated_at = new Date();
}

export async function executePaperOrder(input: PaperOrderInput, marginResolver: MarginResolver = defaultMarginResolver) {
  const t0 = Date.now();
  const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
  const fillPrice = Number(input.price || 0);
  const qty = Number(input.quantity);
  const sym = input.symbol.toUpperCase();
  const securityId = input.securityId || '0';
  const exchangeSegment = input.exchangeSegment || 'NSE_FNO';

  if (!fillPrice || fillPrice <= 0) {
    throw new Error('Fill price required — paper orders must be priced from live market LTP (pass explicit price for LIMIT orders)');
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Invalid quantity ${input.quantity} — must be a positive integer`);
  }

  const latencyMs = Math.max(1, Date.now() - t0 + Math.floor(Math.random() * 20));
  const charges = calculateOrderCharges(input.transactionType, fillPrice, qty);

  // Single computation from the always-in-sync in-memory snapshot (see
  // header) — Postgres below persists this exact result, never a second one.
  const curPos = mem.positions.get(sym);
  const u = input.transactionType === 'BUY' ? calculateBuyUpdate(curPos, qty, fillPrice) : calculateSellUpdate(curPos, qty, fillPrice);
  const newRealized = Number(curPos?.realized_pnl || 0) + u.realized;
  const marginRequired = await resolveMarginRequired(u, securityId, exchangeSegment, input.productType || 'INTRADAY', marginResolver);
  const marginDelta = marginRequired - Number(curPos?.margin_blocked || 0);

  // Affordability gate — a real broker rejects an order it can't margin.
  // Only trades that INCREASE required margin are gated; closing or
  // reducing a position always goes through (even if the account is
  // already over-margined) so a position is never un-closeable.
  if (marginDelta > 0) {
    const availableMargin = computeDerivedMargin().availableMargin;
    const projectedAvailable = availableMargin + u.realized - marginDelta - charges;
    if (projectedAvailable < 0) {
      throw new Error(`Insufficient margin: need ₹${marginDelta.toFixed(2)} more, ₹${availableMargin.toFixed(2)} available`);
    }
  }

  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO paper_orders (id, correlation_id, symbol, security_id, exchange_segment, transaction_type, order_type, product_type, quantity, price, status, filled_qty, avg_price, latency_ms, realized_pnl, charges)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'TRADED', $9, $10, $11, $12, $13)`,
        [orderId, input.correlationId || `corr_${orderId}`, sym, securityId, exchangeSegment, input.transactionType, input.orderType || 'MARKET', input.productType || 'INTRADAY', qty, fillPrice, latencyMs, u.realized, charges],
      );

      await client.query(
        `INSERT INTO paper_positions (id, symbol, security_id, exchange_segment, product_type, buy_qty, buy_avg, sell_qty, sell_avg, net_qty, realized_pnl, ltp, margin_blocked, stop_loss, target, trailing_stop, updated_at)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         ON CONFLICT (id) DO UPDATE SET buy_qty = $5, buy_avg = $6, sell_qty = $7, sell_avg = $8, net_qty = $9, realized_pnl = $10, ltp = $11, margin_blocked = $12, stop_loss = COALESCE($13, paper_positions.stop_loss), target = COALESCE($14, paper_positions.target), trailing_stop = COALESCE($15, paper_positions.trailing_stop), updated_at = NOW()`,
        [sym, securityId, exchangeSegment, input.productType || 'INTRADAY', u.buyQty, u.buyAvg, u.sellQty, u.sellAvg, u.netQty, newRealized, fillPrice, marginRequired, input.stopLoss ?? null, input.target ?? null, input.trailingStop ?? null],
      );

      await client.query(
        `UPDATE paper_wallet SET realized_pnl = realized_pnl + $1, available_margin = available_margin + $1 - $2 - $3, used_margin = used_margin + $2, total_charges = total_charges + $3, updated_at = NOW() WHERE id = 'default'`,
        [u.realized, marginDelta, charges],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Snapshot the session base BEFORE folding this fill's realized PnL in —
  // otherwise a fill landing before this process's first getPaperWallet()
  // read of the day would get silently absorbed into the rollover baseline
  // instead of counted as today's P&L.
  await ensureWalletSessionRolled();
  pushOrderToMem(orderId, sym, securityId, exchangeSegment, input, qty, fillPrice, latencyMs, u.realized, charges);
  applyFillToMem(sym, u, newRealized, fillPrice, marginRequired, input, charges);

  return {
    orderId, symbol: sym, side: input.transactionType, quantity: qty, fillPrice, charges, status: 'TRADED', latencyMs,
    // The resulting NET position after this fill — distinct from `quantity`
    // (this order's qty) and `fillPrice` (this order's price), which are
    // only equal to the position's own state for a fill into a flat position.
    // A caller re-arming stop/target monitoring needs these, not the order's.
    netQty: u.netQty,
    avgPrice: u.netQty > 0 ? u.buyAvg : u.netQty < 0 ? u.sellAvg : 0,
  };
}

/**
 * Closes an open paper position at a slipped fill price and emits the same
 * 'order' fill telemetry as PaperExecutionEngine.placeOrder.
 *
 * Every exit path in the system — autonomy's auto-exit on a PositionMonitor
 * signal, strategy loss-limit stops, EOD square-off, the kill switch, and
 * the manual/strategy close routes — calls this function directly rather
 * than going through PaperExecutionEngine. It used to fill at the exact
 * reference price with zero slippage and emit nothing onto the event bus,
 * so every exit was invisible to the risk engine's on-fill re-evaluation,
 * the frontend's live Orders/Positions feed, and the Redis fill bridge —
 * only entries participated in any of that. `kind` lets a caller that knows
 * this is a triggered stop (vs. a target/manual close) price the extra
 * adverse-crossing cost a real stop pays; callers that don't care default
 * to the plain exit cost.
 */
function findPaperPosition(target: InstrumentKey | string): any | undefined {
  if (typeof target === 'string') return mem.positions.get(target.toUpperCase());
  for (const pos of mem.positions.values()) {
    if (Number(pos.net_qty) === 0) continue;
    if (String(pos.security_id) === String(target.securityId) && String(pos.exchange_segment) === target.exchangeSegment) {
      return pos;
    }
  }
  return undefined;
}

export async function closePaperPosition(target: InstrumentKey | string, currentLtp?: number, marginResolver?: MarginResolver, kind: FillKind = 'EXIT') {
  const pos = findPaperPosition(target);
  if (!pos || Number(pos.net_qty) === 0) return { status: 'noop', message: 'No open position found' };
  const sym = String(pos.symbol).toUpperCase();
  const netQty = Number(pos.net_qty);
  const transactionType: 'BUY' | 'SELL' = netQty > 0 ? 'SELL' : 'BUY';
  const referencePrice = currentLtp || Number(pos.ltp || (netQty > 0 ? pos.buy_avg : pos.sell_avg));
  const fillPrice = applyFillSlippage(referencePrice, transactionType, kind);

  const result: any = await executePaperOrder({
    symbol: sym,
    securityId: pos.security_id,
    exchangeSegment: pos.exchange_segment,
    transactionType,
    orderType: 'MARKET',
    productType: pos.product_type,
    quantity: Math.abs(netQty),
    price: fillPrice,
    correlationId: `close_${sym}_${Date.now()}`,
  }, marginResolver);

  if (result.status === 'TRADED') {
    const fillPayload = {
      correlation_id: result.orderId, is_paper: true, fill_price: result.fillPrice,
      quantity: result.quantity, security_id: pos.security_id, symbol: sym,
      latency_ms: result.latencyMs, charges: result.charges, filled_at: new Date().toISOString(),
    };
    eventBus.log('TRADE', `Paper close ${transactionType} ${result.quantity} ${sym} @ ₹${result.fillPrice.toFixed(2)}`, 'paper_engine');
    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    journal.append('order_result', { status: 'TRADED', exitKind: kind, ...fillPayload });
    redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});
  }
  return result;
}

/** Mark open positions to market — pure in-memory, called every autonomy
 * cycle. No Postgres access: `mem` is the live read path (see header). */
/** Shared unrealized-PnL formula — long gains as LTP rises, short gains as it falls. */
function computeUnrealized(netQty: number, buyAvg: number, sellAvg: number, ltp: number): number {
  if (netQty === 0) return 0;
  return netQty > 0 ? (ltp - buyAvg) * netQty : (sellAvg - ltp) * Math.abs(netQty);
}

export interface MarkToMarketResult {
  totalUnrealized: number;
  /** Positions where the resolver returned null this cycle — marked from a
   * stale/last-known price, not a fresh quote. Distinct from "confidently
   * priced" so a feed dropout during market hours is visible instead of
   * silently smoothed over by reusing an old LTP forever. */
  staleCount: number;
}

export async function markPositionsToMarket(ltpResolver: (securityId: string, symbol: string) => number | null): Promise<MarkToMarketResult> {
  let totalUnrealized = 0;
  let staleCount = 0;
  for (const pos of mem.positions.values()) {
    const netQty = Number(pos.net_qty);
    if (netQty === 0) continue;
    const buyAvg = Number(pos.buy_avg), sellAvg = Number(pos.sell_avg);
    const ltp = ltpResolver(pos.security_id, pos.symbol);
    if (ltp == null) staleCount++;
    const effectiveLtp = ltp ?? Number(pos.ltp || (netQty > 0 ? buyAvg : sellAvg));
    const unrealized = computeUnrealized(netQty, buyAvg, sellAvg, effectiveLtp);
    totalUnrealized += unrealized;
    if (ltp != null) pos.ltp = ltp;
    pos.unrealized_pnl = unrealized;
    pos.updated_at = new Date();
  }
  return { totalUnrealized, staleCount };
}

export async function listPaperPositions() {
  const rows = [...mem.positions.values()];
  return rows.map((r: any) => {
    const netQty = Number(r.net_qty), buyAvg = Number(r.buy_avg), sellAvg = Number(r.sell_avg);
    const cost = netQty >= 0 ? buyAvg : sellAvg, ltp = Number(r.ltp || cost);
    const unrealized = computeUnrealized(netQty, buyAvg, sellAvg, ltp);
    const realized = Number(r.realized_pnl);
    return {
      id: r.id, tradingSymbol: r.symbol, securityId: r.security_id, exchangeSegment: r.exchange_segment,
      productType: r.product_type, buyQty: Number(r.buy_qty), buyAvg, sellQty: Number(r.sell_qty), sellAvg,
      netQty, realizedProfit: realized, unrealizedProfit: unrealized, rnl: realized, unrealizedPnl: unrealized,
      pnl: realized + unrealized, costPrice: cost, ltp, positionType: r.product_type, crossCurrency: false,
      marginBlocked: Number(r.margin_blocked || 0),
      stopLoss: r.stop_loss ? Number(r.stop_loss) : null,
      target: r.target ? Number(r.target) : null,
      trailingStop: r.trailing_stop ? Number(r.trailing_stop) : null,
    };
  });
}

export async function closeAllPaperPositions(ltpResolver: (securityId: string, symbol: string) => number | null) {
  const results = [];
  for (const p of await listPaperPositions()) {
    if (p.netQty === 0) continue;
    const ltp = ltpResolver(String(p.securityId), p.tradingSymbol) || p.ltp;
    results.push(await closePaperPosition({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment }, ltp));
  }
  return results;
}

// ── ledger reconciliation: mem cache vs durable Postgres ───────────────────
export interface LedgerMismatch { subject: string; field: string; mem: number | string; postgres: number | string }
export interface LedgerDriftReport {
  ok: boolean;
  checkedPositions: number;
  mismatches: LedgerMismatch[];
  missingInPostgres: string[]; // open in mem, no row in postgres
  missingInMem: string[];      // open in postgres, not open in mem
}

// Wallet fields a FILL writes to both stores — excludes nothing computed
// (mem.wallet has no derived fields; getPaperWallet() computes those from
// these raw columns on read).
const WALLET_FIELDS = ['initial_balance', 'available_margin', 'used_margin', 'realized_pnl', 'total_charges', 'session_realized_base'] as const;

// Position fields a FILL writes to both stores. Deliberately excludes
// `ltp` and `unrealized_pnl`: markPositionsToMarket() updates those in mem
// on every tick and NEVER writes them to Postgres (mark-to-market is a
// pure in-memory hot path, by design) — comparing them would report
// permanent "drift" that isn't drift at all, just two different concerns
// living in the same row.
const POSITION_FIELDS = ['buy_qty', 'buy_avg', 'sell_qty', 'sell_avg', 'net_qty', 'realized_pnl', 'margin_blocked', 'stop_loss', 'target', 'trailing_stop'] as const;

const NUMERIC_TOLERANCE = 0.01; // one paisa — floating-point noise, not drift

function numsDiffer(a: any, b: any): boolean {
  const na = Number(a ?? 0), nb = Number(b ?? 0);
  if (Number.isNaN(na) || Number.isNaN(nb)) return na !== nb;
  return Math.abs(na - nb) > NUMERIC_TOLERANCE;
}

/**
 * Compares the in-memory cache — the read path every position/wallet query
 * in this system goes through — against what's actually durable in
 * Postgres. They're expected to always agree (mem is updated from the same
 * computed result as every Postgres write inside one transaction), so any
 * mismatch means a write silently diverged: a Postgres commit that
 * appeared to fail but partially applied, a direct SQL change outside
 * this process, or a bug in a future code path that updates one store and
 * not the other.
 *
 * Read-only and cheap enough to run periodically (a handful of indexed
 * queries) — no-ops in memory mode, where there is nothing to compare
 * against.
 */
export async function reconcileLedger(): Promise<LedgerDriftReport> {
  const report: LedgerDriftReport = { ok: true, checkedPositions: 0, mismatches: [], missingInPostgres: [], missingInMem: [] };
  if (mode !== 'postgres') return report;

  try {
    const walletRes = await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['default']);
    const pgWallet = walletRes.rows[0];
    if (pgWallet) {
      for (const field of WALLET_FIELDS) {
        const memVal = (mem.wallet as any)[field];
        const pgVal = pgWallet[field];
        if (numsDiffer(memVal, pgVal)) {
          report.mismatches.push({ subject: 'wallet', field, mem: Number(memVal ?? 0), postgres: Number(pgVal ?? 0) });
        }
      }
    }

    const posRes = await pool.query('SELECT * FROM paper_positions WHERE net_qty <> 0');
    const pgOpen = new Map<string, any>(posRes.rows.map((r: any) => [r.id, r]));
    const memOpen = new Map<string, any>([...mem.positions.entries()].filter(([, p]) => Number(p.net_qty) !== 0));
    report.checkedPositions = Math.max(pgOpen.size, memOpen.size);

    for (const [symbol, memPos] of memOpen) {
      const pgPos = pgOpen.get(symbol);
      if (!pgPos) { report.missingInPostgres.push(symbol); continue; }
      for (const field of POSITION_FIELDS) {
        if (numsDiffer(memPos[field], pgPos[field])) {
          report.mismatches.push({ subject: symbol, field, mem: Number(memPos[field] ?? 0), postgres: Number(pgPos[field] ?? 0) });
        }
      }
    }
    for (const symbol of pgOpen.keys()) {
      if (!memOpen.has(symbol)) report.missingInMem.push(symbol);
    }
  } catch (e: any) {
    log.warn({ err: { message: e.message } }, 'Ledger reconciliation query failed — treating as non-fatal, will retry next cycle');
    return report; // a failed CHECK is not itself drift — don't report false corrections
  }

  report.ok = report.mismatches.length === 0 && report.missingInPostgres.length === 0 && report.missingInMem.length === 0;
  return report;
}

/**
 * Applies the correction implied by a drift report: Postgres is the
 * durable source of truth, so every mismatch is resolved by overwriting
 * the mem side with the Postgres row. A position missing from mem is
 * pulled in from Postgres; a position mem has that Postgres doesn't is
 * dropped from mem (Postgres's absence IS the truth — mem must not keep
 * trading a position the durable ledger has no record of).
 */
export async function correctLedgerFromPostgres(report: LedgerDriftReport): Promise<void> {
  if (mode !== 'postgres' || report.ok) return;

  if (report.mismatches.some((m) => m.subject === 'wallet') || report.missingInPostgres.length + report.missingInMem.length > 0) {
    const walletRes = await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['default']);
    if (walletRes.rows[0]) mem.wallet = walletRes.rows[0];
  }

  const affected = new Set<string>([
    ...report.mismatches.filter((m) => m.subject !== 'wallet').map((m) => m.subject),
    ...report.missingInMem,
  ]);
  for (const symbol of affected) {
    const res = await pool.query('SELECT * FROM paper_positions WHERE id = $1', [symbol]);
    if (res.rows[0] && Number(res.rows[0].net_qty) !== 0) {
      mem.positions.set(symbol, res.rows[0]);
    } else {
      mem.positions.delete(symbol);
    }
  }

  for (const symbol of report.missingInPostgres) {
    // Postgres has no record of this position at all — mem must not keep
    // trading something the durable ledger never saw.
    mem.positions.delete(symbol);
  }
}

/**
 * Returns the subset of the given IDs that have NO matching durable order
 * record — used by core.ts's boot-time journal cross-check (journal.ts's
 * summarizeDay) to verify every trade the journal recorded as TRADED
 * actually has a row in the durable order history. Checked against BOTH
 * `id` and `correlation_id`: an ENTRY's journaled id is the caller's own
 * correlation id (the `correlation_id` column), while an EXIT's
 * (closePaperPosition) is the generated order id (the `id` column) —
 * closePaperPosition reuses the `correlation_id` field name in its fill
 * payload for that value, so the caller doesn't need to know which is
 * which; this checks both.
 */
export async function findMissingOrders(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const remaining = new Set(ids);
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT id, correlation_id FROM paper_orders WHERE id = ANY($1) OR correlation_id = ANY($1)', [ids]);
      for (const row of res.rows) {
        remaining.delete(row.id);
        if (row.correlation_id) remaining.delete(row.correlation_id);
      }
    } catch (e: any) {
      log.warn({ err: { message: e.message } }, 'findMissingOrders query failed — skipping this boot cross-check');
      return []; // a failed CHECK is not itself a finding
    }
  } else {
    for (const o of mem.orders) {
      remaining.delete(o.id);
      if (o.correlation_id) remaining.delete(o.correlation_id);
    }
  }
  return [...remaining];
}

export async function saveResearchRun(run: {
  id: string; symbol: string; exchange?: string; status?: string;
  quality_score?: number; valuation_score?: number; verdict?: string; data: any;
}): Promise<void> {
  const row = {
    id: run.id, symbol: run.symbol, exchange: run.exchange || 'NSE', status: run.status || 'COMPLETED',
    quality_score: run.quality_score ?? null, valuation_score: run.valuation_score ?? null,
    verdict: run.verdict ?? null, data: run.data, created_at: new Date(), updated_at: new Date(),
  };
  mem.researchRuns.set(run.id, row);
  if (mode === 'postgres') {
    const q = `
      INSERT INTO research_runs (id, symbol, exchange, status, quality_score, valuation_score, verdict, data, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, quality_score = EXCLUDED.quality_score,
        valuation_score = EXCLUDED.valuation_score, verdict = EXCLUDED.verdict,
        data = EXCLUDED.data, updated_at = NOW();
    `;
    await pool.query(q, [row.id, row.symbol, row.exchange, row.status, row.quality_score, row.valuation_score, row.verdict, JSON.stringify(row.data)]).catch((e: any) => {
      log.warn({ err: { message: e.message } }, 'saveResearchRun failed');
    });
  }
}

export async function getResearchRun(id: string): Promise<any | null> {
  if (mem.researchRuns.has(id)) return mem.researchRuns.get(id);
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM research_runs WHERE id = $1', [id]);
      if (res.rows[0]) {
        mem.researchRuns.set(id, res.rows[0]);
        return res.rows[0];
      }
    } catch { /* return null */ }
  }
  return null;
}

export async function listResearchRuns(limit = 20): Promise<any[]> {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT id, symbol, exchange, status, quality_score, valuation_score, verdict, created_at FROM research_runs ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows;
    } catch { /* fallback to mem */ }
  }
  return Array.from(mem.researchRuns.values()).slice(-limit).reverse();
}

export async function saveResearchEvidence(items: any[]): Promise<void> {
  if (items.length === 0) return;
  const runId = items[0].runId;
  const existing = mem.researchEvidence.get(runId) || [];
  mem.researchEvidence.set(runId, [...existing, ...items]);

  if (mode === 'postgres') {
    for (const item of items) {
      const q = `
        INSERT INTO research_evidence (id, run_id, category, claim, metric, value, source, confidence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING;
      `;
      await pool.query(q, [item.id, item.runId, item.category, item.claim, item.metric || null, item.value ?? null, item.source, item.confidence]).catch(() => {});
    }
  }
}

export async function getResearchEvidenceByRun(runId: string): Promise<any[]> {
  if (mem.researchEvidence.has(runId)) return mem.researchEvidence.get(runId)!;
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM research_evidence WHERE run_id = $1 ORDER BY id ASC', [runId]);
      mem.researchEvidence.set(runId, res.rows);
      return res.rows;
    } catch { /* fallback */ }
  }
  return [];
}

