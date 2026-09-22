import { Pool } from 'pg';
import type { InstrumentKey } from './lib/instrumentKey';
import { moduleLogger } from './lib/logger';
import { shouldEmitAlert } from './lib/logPolicy';
import { marketClock } from './services/marketHours';
import { eventBus } from './services/eventBus';
import { journal } from './services/journal';
import { applyFillSlippage, type FillKind } from './services/fillModel';
import { redisPublisher } from './auth';
import { getTradingMode } from './lib/tradingMode';

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
export const mem = {
  wallet: { id: 'default', initial_balance: 100000, available_margin: 100000, used_margin: 0, realized_pnl: 0, total_charges: 0, session_realized_base: 0, session_date: null as string | null, updated_at: new Date() },
  sandboxWallet: { id: 'sandbox', initial_balance: 1000000, available_margin: 1000000, used_margin: 0, realized_pnl: 0, total_charges: 0, session_realized_base: 0, session_date: null as string | null, updated_at: new Date() },
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

export function posKey(modeKey: string, sym: string): string {
  return modeKey === 'sandbox' ? `sandbox:${sym}` : sym;
}

export function getMemWallet(targetMode: string = getTradingMode()): any {
  if (targetMode === 'sandbox') {
    if (!mem.sandboxWallet) {
      mem.sandboxWallet = { id: 'sandbox', initial_balance: 1000000, available_margin: 1000000, used_margin: 0, realized_pnl: 0, total_charges: 0, session_realized_base: 0, session_date: null, updated_at: new Date() };
    }
    return mem.sandboxWallet;
  }
  return mem.wallet;
}

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
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS trading_mode VARCHAR(16) NOT NULL DEFAULT 'paper';
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS stop_loss NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS target NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trailing_stop NUMERIC(12, 2);
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS margin_blocked NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trading_mode VARCHAR(16) NOT NULL DEFAULT 'paper';
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS total_charges NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_strategies ADD COLUMN IF NOT EXISTS margin_hedge_credit NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS session_realized_base NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
  ALTER TABLE paper_wallet ADD COLUMN IF NOT EXISTS session_date VARCHAR(10);
  ALTER TABLE risk_state ADD COLUMN IF NOT EXISTS killed_date VARCHAR(10);
  INSERT INTO paper_wallet (id, initial_balance, available_margin, used_margin, realized_pnl)
  VALUES ('sandbox', 1000000.00, 1000000.00, 0.00, 0.00)
  ON CONFLICT (id) DO NOTHING;
  UPDATE paper_positions SET trading_mode = 'sandbox', id = 'sandbox:' || id
  WHERE trading_mode = 'paper' AND (id LIKE 'NIFTY 22 SEP%' OR id LIKE 'BANKNIFTY 29 SEP%');
  UPDATE paper_orders SET trading_mode = 'sandbox'
  WHERE trading_mode = 'paper' AND (symbol LIKE '%SEP%' OR correlation_id LIKE 'ast_%' OR correlation_id LIKE 'test_%' OR correlation_id LIKE 'gc4-%');
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
    const sbxWalletRes = await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['sandbox']);
    if (sbxWalletRes.rows[0]) mem.sandboxWallet = sbxWalletRes.rows[0];
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
async function ensureWalletSessionRolled(w: any = getMemWallet()): Promise<void> {
  const today = marketClock().istDate;
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
 * multi-leg strategy.
 */
function computeDerivedMargin(targetMode = getTradingMode()): { usedMargin: number; availableMargin: number } {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  let usedMargin = 0;
  for (const pos of mem.positions.values()) {
    if ((pos.trading_mode || 'paper') !== modeKey) continue;
    if (Number(pos.net_qty) !== 0) usedMargin += Number(pos.margin_blocked || 0);
  }
  for (const strat of mem.strategies) {
    if (strat.status !== 'RUNNING' || !Number(strat.margin_hedge_credit || 0)) continue;
    const legs: any[] = strat.legs || [];
    const stillOpen = legs.some((l) => {
      const p = mem.positions.get(posKey(modeKey, String(l.instrument).toUpperCase()));
      return Number(p?.net_qty || 0) !== 0;
    });
    if (stillOpen) usedMargin -= Number(strat.margin_hedge_credit || 0);
  }
  const w = getMemWallet(targetMode);
  const availableMargin = Number(w.initial_balance) + Number(w.realized_pnl) - usedMargin - Number(w.total_charges || 0);
  return { usedMargin: Number(usedMargin.toFixed(2)), availableMargin: Number(availableMargin.toFixed(2)) };
}

// ── wallet ──────────────────────────────────────────────────────────────
// Reads always come from `mem` (see header) — Postgres is written to on every
// fill but never read back on the hot path.
export async function getPaperWallet(targetMode = getTradingMode()) {
  const w = getMemWallet(targetMode);
  if (!w) {
    const init = targetMode === 'sandbox' ? 1000000 : 100000;
    return { availableMargin: init, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0, unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: init, equity: init, spanMargin: 0, exposureMargin: 0 };
  }
  await ensureWalletSessionRolled(w);
  const { usedMargin, availableMargin } = computeDerivedMargin(targetMode);
  const realizedPnl = Number(w.realized_pnl);
  const sessionRealizedPnl = realizedPnl - Number(w.session_realized_base || 0);
  const totalCharges = Number(w.total_charges || 0);
  const initialBalance = Number(w.initial_balance);
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  let unrealizedPnl = 0;
  for (const pos of mem.positions.values()) {
    if ((pos.trading_mode || 'paper') !== modeKey) continue;
    const netQty = Number(pos.net_qty);
    if (netQty === 0) continue;
    unrealizedPnl += computeUnrealized(netQty, Number(pos.buy_avg), Number(pos.sell_avg), Number(pos.ltp));
  }
  return {
    availableMargin, usedMargin, realizedPnl, sessionRealizedPnl, unrealizedPnl, totalCharges,
    netRealizedPnl: Number((realizedPnl - totalCharges).toFixed(2)),
    totalBalance: availableMargin + usedMargin,
    equity: Number((initialBalance + realizedPnl + unrealizedPnl - totalCharges).toFixed(2)),
    spanMargin: Number((usedMargin * 0.7).toFixed(2)),
    exposureMargin: Number((usedMargin * 0.3).toFixed(2)),
  };
}

export async function adjustWalletMargin(delta: number, targetMode = getTradingMode()): Promise<void> {
  if (!delta) return;
  const w = getMemWallet(targetMode);
  const walletId = targetMode === 'sandbox' ? 'sandbox' : 'default';
  w.used_margin = Number(w.used_margin) - delta;
  w.available_margin = Number(w.available_margin) + delta;
  w.updated_at = new Date();
  if (mode === 'postgres') {
    await pool.query(
      `UPDATE paper_wallet SET used_margin = used_margin - $1, available_margin = available_margin + $1, updated_at = NOW() WHERE id = $2`,
      [delta, walletId],
    ).catch(() => {});
  }
}

export async function resetPaperWallet(initialBalance?: number, targetMode: string = getTradingMode()) {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  const walletId = modeKey === 'sandbox' ? 'sandbox' : 'default';
  const balance = initialBalance ?? (modeKey === 'sandbox' ? 1000000 : 100000);
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE paper_wallet SET initial_balance = $1, available_margin = $1, used_margin = 0, realized_pnl = 0, total_charges = 0, session_realized_base = 0, session_date = NULL, updated_at = NOW() WHERE id = $2`,
        [balance, walletId],
      );
      await client.query('DELETE FROM paper_positions WHERE trading_mode = $1', [modeKey]);
      await client.query('DELETE FROM paper_orders WHERE trading_mode = $1', [modeKey]);
      if (modeKey === 'paper') {
        await client.query('DELETE FROM alerts');
        await client.query('DELETE FROM agent_events');
        await client.query(`UPDATE risk_state SET killed = FALSE, killed_reason = NULL, killed_date = NULL, limits = '{}', consecutive_losses = 0, updated_at = NOW() WHERE id = 'default'`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  const w = getMemWallet(modeKey);
  w.initial_balance = balance;
  w.available_margin = balance;
  w.used_margin = 0;
  w.realized_pnl = 0;
  w.total_charges = 0;
  w.session_realized_base = 0;
  w.session_date = null;
  w.updated_at = new Date();
  for (const [k, p] of mem.positions.entries()) {
    if ((p.trading_mode || 'paper') === modeKey) mem.positions.delete(k);
  }
  mem.orders = mem.orders.filter((o) => (o.trading_mode || 'paper') !== modeKey);
  if (modeKey === 'paper') {
    mem.alerts = [];
    mem.agentEvents = [];
    mem.riskState = { killed: false, killedReason: null, limits: {}, consecutiveLosses: 0 };
  }
  return { status: 'ok', initialBalance: balance, tradingMode: modeKey };
}

// ── orders ──────────────────────────────────────────────────────────────
export async function listPaperOrders(limit = 100, targetMode = getTradingMode()) {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_orders WHERE trading_mode = $1 ORDER BY created_at DESC LIMIT $2', [modeKey, limit]).catch(() => ({ rows: [] }))).rows
    : mem.orders.filter((o: any) => (o.trading_mode || 'paper') === modeKey).slice(0, limit);
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

export async function cancelPaperOrder(orderId: string): Promise<boolean> {
  let found = false;
  for (const o of mem.orders) {
    if ((o.id === orderId || o.correlation_id === orderId) && ['PENDING', 'TRANSIT'].includes(o.status)) {
      o.status = 'CANCELLED';
      found = true;
    }
  }
  if (mode === 'postgres') {
    const res = await pool.query(
      "UPDATE paper_orders SET status = 'CANCELLED' WHERE (id = $1 OR correlation_id = $1) AND status IN ('PENDING', 'TRANSIT')",
      [orderId],
    ).catch(() => ({ rowCount: 0 }));
    if ((res.rowCount ?? 0) > 0) found = true;
  }
  return found;
}

export async function getTodayOrderStats(targetMode = getTradingMode()) {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  const today = new Date().toDateString();
  const rows = mem.orders.filter((o: any) => (o.trading_mode || 'paper') === modeKey && new Date(o.created_at).toDateString() === today).slice().reverse();
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
  tradingMode?: string;
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

/** Records one fill in the in-memory order log. */
function pushOrderToMem(orderId: string, sym: string, securityId: string, exchangeSegment: string, input: PaperOrderInput, qty: number, fillPrice: number, latencyMs: number, realizedDelta: number, charges: number, modeKey = 'paper'): void {
  mem.orders.unshift({
    id: orderId, correlation_id: input.correlationId || `corr_${orderId}`, symbol: sym,
    security_id: securityId, exchange_segment: exchangeSegment,
    transaction_type: input.transactionType, order_type: input.orderType || 'MARKET',
    product_type: input.productType || 'INTRADAY', quantity: qty, price: fillPrice,
    status: 'TRADED', filled_qty: qty, avg_price: fillPrice, latency_ms: latencyMs,
    realized_pnl: realizedDelta, charges, trading_mode: modeKey, created_at: new Date(), updated_at: new Date(),
  });
  if (mem.orders.length > 500) mem.orders.pop();
}

/** Applies one fill's computed result to the in-memory cache. */
function applyFillToMem(posKeyId: string, sym: string, u: PositionUpdate, newRealized: number, ltp: number, marginRequired: number, input: PaperOrderInput, charges: number, modeKey = 'paper'): void {
  const curPos = mem.positions.get(posKeyId);
  const marginDelta = marginRequired - Number(curPos?.margin_blocked || 0);
  mem.positions.set(posKeyId, {
    id: posKeyId, symbol: sym,
    security_id: input.securityId || curPos?.security_id || '0',
    exchange_segment: input.exchangeSegment || curPos?.exchange_segment || 'NSE_FNO',
    product_type: input.productType || curPos?.product_type || 'INTRADAY',
    buy_qty: u.buyQty, buy_avg: u.buyAvg, sell_qty: u.sellQty, sell_avg: u.sellAvg, net_qty: u.netQty,
    realized_pnl: newRealized, ltp, margin_blocked: marginRequired,
    unrealized_pnl: curPos?.unrealized_pnl ?? 0,
    stop_loss: input.stopLoss ?? curPos?.stop_loss ?? null,
    target: input.target ?? curPos?.target ?? null,
    trailing_stop: input.trailingStop ?? curPos?.trailing_stop ?? null,
    trading_mode: modeKey,
    updated_at: new Date(),
  });
  const w = getMemWallet(modeKey);
  w.realized_pnl = Number(w.realized_pnl) + u.realized;
  w.available_margin = Number(w.available_margin) + u.realized - marginDelta - charges;
  w.used_margin = Number(w.used_margin) + marginDelta;
  w.total_charges = Number(w.total_charges || 0) + charges;
  w.updated_at = new Date();
}

async function persistPaperFillPostgres(p: {
  orderId: string; sym: string; securityId: string; exchangeSegment: string;
  input: PaperOrderInput; qty: number; fillPrice: number; latencyMs: number;
  realized: number; charges: number; positionId: string; newRealized: number;
  marginRequired: number; marginDelta: number; modeKey: string; walletId: string;
  u: PositionUpdate;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO paper_orders (id, correlation_id, symbol, security_id, exchange_segment, transaction_type, order_type, product_type, quantity, price, status, filled_qty, avg_price, latency_ms, realized_pnl, charges, trading_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'TRADED', $9, $10, $11, $12, $13, $14)`,
      [p.orderId, p.input.correlationId || `corr_${p.orderId}`, p.sym, p.securityId, p.exchangeSegment, p.input.transactionType, p.input.orderType || 'MARKET', p.input.productType || 'INTRADAY', p.qty, p.fillPrice, p.latencyMs, p.realized, p.charges, p.modeKey],
    );
    await client.query(
      `INSERT INTO paper_positions (id, symbol, security_id, exchange_segment, product_type, buy_qty, buy_avg, sell_qty, sell_avg, net_qty, realized_pnl, ltp, margin_blocked, stop_loss, target, trailing_stop, trading_mode, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
       ON CONFLICT (id) DO UPDATE SET buy_qty = $6, buy_avg = $7, sell_qty = $8, sell_avg = $9, net_qty = $10, realized_pnl = $11, ltp = $12, margin_blocked = $13, stop_loss = COALESCE($14, paper_positions.stop_loss), target = COALESCE($15, paper_positions.target), trailing_stop = COALESCE($16, paper_positions.trailing_stop), trading_mode = $17, updated_at = NOW()`,
      [p.positionId, p.sym, p.securityId, p.exchangeSegment, p.input.productType || 'INTRADAY', p.u.buyQty, p.u.buyAvg, p.u.sellQty, p.u.sellAvg, p.u.netQty, p.newRealized, p.fillPrice, p.marginRequired, p.input.stopLoss ?? null, p.input.target ?? null, p.input.trailingStop ?? null, p.modeKey],
    );
    await client.query(
      `UPDATE paper_wallet SET realized_pnl = realized_pnl + $1, available_margin = available_margin + $1 - $2 - $3, used_margin = used_margin + $2, total_charges = total_charges + $3, updated_at = NOW() WHERE id = $4`,
      [p.realized, p.marginDelta, p.charges, p.walletId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function executePaperOrder(input: PaperOrderInput, marginResolver: MarginResolver = defaultMarginResolver, targetMode?: string) {
  const t0 = Date.now();
  const modeKey = (targetMode || input.tradingMode || getTradingMode()) === 'sandbox' ? 'sandbox' : 'paper';
  const walletId = modeKey === 'sandbox' ? 'sandbox' : 'default';
  const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
  const fillPrice = Number(input.price || 0);
  const qty = Number(input.quantity);
  const sym = input.symbol.toUpperCase();
  const positionId = posKey(modeKey, sym);
  const securityId = input.securityId || '0';
  const exchangeSegment = input.exchangeSegment || 'NSE_FNO';

  if (!fillPrice || fillPrice <= 0) throw new Error('Fill price required — paper orders must be priced from live market LTP');
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Invalid quantity ${input.quantity} — must be a positive integer`);

  const latencyMs = Math.max(1, Date.now() - t0 + Math.floor(Math.random() * 20));
  const charges = calculateOrderCharges(input.transactionType, fillPrice, qty);

  const curPos = mem.positions.get(positionId);
  const u = input.transactionType === 'BUY' ? calculateBuyUpdate(curPos, qty, fillPrice) : calculateSellUpdate(curPos, qty, fillPrice);
  const newRealized = Number(curPos?.realized_pnl || 0) + u.realized;
  const marginRequired = await resolveMarginRequired(u, securityId, exchangeSegment, input.productType || 'INTRADAY', marginResolver);
  const marginDelta = marginRequired - Number(curPos?.margin_blocked || 0);

  if (marginDelta > 0) {
    const availableMargin = computeDerivedMargin(modeKey).availableMargin;
    const projectedAvailable = availableMargin + u.realized - marginDelta - charges;
    if (projectedAvailable < 0) {
      throw new Error(`Insufficient margin: need ₹${marginDelta.toFixed(2)} more, ₹${availableMargin.toFixed(2)} available`);
    }
  }

  if (mode === 'postgres') {
    await persistPaperFillPostgres({
      orderId, sym, securityId, exchangeSegment, input, qty, fillPrice, latencyMs,
      realized: u.realized, charges, positionId, newRealized, marginRequired, marginDelta,
      modeKey, walletId, u,
    });
  }

  await ensureWalletSessionRolled(getMemWallet(modeKey));
  pushOrderToMem(orderId, sym, securityId, exchangeSegment, input, qty, fillPrice, latencyMs, u.realized, charges, modeKey);
  applyFillToMem(positionId, sym, u, newRealized, fillPrice, marginRequired, input, charges, modeKey);

  return {
    orderId, symbol: sym, side: input.transactionType, quantity: qty, fillPrice, charges, status: 'TRADED', latencyMs,
    netQty: u.netQty,
    avgPrice: u.netQty > 0 ? u.buyAvg : u.netQty < 0 ? u.sellAvg : 0,
    tradingMode: modeKey,
  };
}

function findPaperPosition(target: InstrumentKey | string, targetMode = getTradingMode()): any | undefined {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  if (typeof target === 'string') {
    const bySym = mem.positions.get(posKey(modeKey, target.toUpperCase()));
    if (bySym) return bySym;
    for (const pos of mem.positions.values()) {
      if ((pos.trading_mode || 'paper') !== modeKey || Number(pos.net_qty) === 0) continue;
      if (String(pos.security_id) === target || String(pos.symbol).toUpperCase() === target.toUpperCase()) {
        return pos;
      }
    }
    return undefined;
  }
  for (const pos of mem.positions.values()) {
    if ((pos.trading_mode || 'paper') !== modeKey || Number(pos.net_qty) === 0) continue;
    if (String(pos.security_id) === String(target.securityId) && String(pos.exchange_segment) === target.exchangeSegment) {
      return pos;
    }
  }
  return undefined;
}

export async function closePaperPosition(target: InstrumentKey | string, currentLtp?: number, marginResolver?: MarginResolver, kind: FillKind = 'EXIT', targetMode?: string) {
  const modeKey = (targetMode || getTradingMode()) === 'sandbox' ? 'sandbox' : 'paper';
  const pos = findPaperPosition(target, modeKey);
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
    tradingMode: modeKey,
  }, marginResolver, modeKey);

  if (result.status === 'TRADED') {
    const fillPayload = {
      correlation_id: result.orderId, is_paper: true, fill_price: result.fillPrice,
      quantity: result.quantity, security_id: pos.security_id, symbol: sym,
      latency_ms: result.latencyMs, charges: result.charges, filled_at: new Date().toISOString(),
      mode: modeKey,
    };
    eventBus.log('TRADE', `${modeKey === 'sandbox' ? 'Sandbox' : 'Paper'} close ${transactionType} ${result.quantity} ${sym} @ ₹${result.fillPrice.toFixed(2)}`, 'paper_engine');
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
  staleCount: number;
}

export async function markPositionsToMarket(ltpResolver: (securityId: string, symbol: string) => number | null, targetMode = getTradingMode()): Promise<MarkToMarketResult> {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  let totalUnrealized = 0;
  let staleCount = 0;
  for (const pos of mem.positions.values()) {
    if ((pos.trading_mode || 'paper') !== modeKey) continue;
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

export async function listPaperPositions(targetMode = getTradingMode()) {
  const modeKey = targetMode === 'sandbox' ? 'sandbox' : 'paper';
  const rows = [...mem.positions.values()].filter((r: any) => (r.trading_mode || 'paper') === modeKey);
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

export async function closeAllPaperPositions(ltpResolver: (securityId: string, symbol: string) => number | null, targetMode = getTradingMode()) {
  const results = [];
  for (const p of await listPaperPositions(targetMode)) {
    if (p.netQty === 0) continue;
    const ltp = ltpResolver(String(p.securityId), p.tradingSymbol) || p.ltp;
    results.push(await closePaperPosition({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment }, ltp, undefined, 'EXIT', targetMode));
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

