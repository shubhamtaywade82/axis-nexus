import { pool, dbMode } from '../../db';
import { moduleLogger } from '../../lib/logger';
import { OPEN_STATES, type ExpertTrade, type ExpertTradeListFilter, type ExpertTradeState } from './types';

const log = moduleLogger('expert_trades_repo');

// In-memory fallback for offline/unit-test resilience — mirrors
// researchRepository.ts's memWatchlist pattern.
const memTrades = new Map<string, ExpertTrade>();

export async function initExpertTradeRepository(): Promise<void> {
  if (dbMode() !== 'postgres') return;
  const sql = `
    CREATE TABLE IF NOT EXISTS expert_trades (
      id VARCHAR(64) PRIMARY KEY,
      symbol VARCHAR(32) NOT NULL,
      setup_type VARCHAR(32) NOT NULL,
      horizon VARCHAR(16) NOT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'NEW',
      score NUMERIC(5, 2) NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      triggered_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_expert_trades_state ON expert_trades (state);
    CREATE INDEX IF NOT EXISTS idx_expert_trades_symbol ON expert_trades (symbol);
  `;
  try {
    await pool.query(sql);
    log.info('Expert trade persistence table initialized successfully');
  } catch (e: any) {
    log.warn({ err: e.message }, 'Failed to initialize expert_trades schema in Postgres');
  }
}

function toRow(trade: ExpertTrade) {
  return [
    trade.id, trade.symbol, trade.setup.type, trade.horizon, trade.state, trade.setup.score,
    JSON.stringify(trade), new Date(trade.createdAt), new Date(trade.expiresAt),
    trade.triggeredAt ? new Date(trade.triggeredAt) : null,
    trade.closedAt ? new Date(trade.closedAt) : null,
  ];
}

export async function saveExpertTrade(trade: ExpertTrade): Promise<void> {
  memTrades.set(trade.id, trade);
  if (dbMode() !== 'postgres') return;
  const q = `
    INSERT INTO expert_trades (id, symbol, setup_type, horizon, state, score, data, created_at, expires_at, triggered_at, closed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO NOTHING;
  `;
  try {
    await pool.query(q, toRow(trade));
  } catch (e: any) {
    log.warn({ id: trade.id, err: e.message }, 'Failed to persist expert trade');
  }
}

export async function updateExpertTrade(trade: ExpertTrade): Promise<void> {
  memTrades.set(trade.id, trade);
  if (dbMode() !== 'postgres') return;
  const q = `
    UPDATE expert_trades SET
      state = $2, score = $3, data = $4, triggered_at = $5, closed_at = $6, updated_at = NOW()
    WHERE id = $1;
  `;
  try {
    await pool.query(q, [
      trade.id, trade.state, trade.setup.score, JSON.stringify(trade),
      trade.triggeredAt ? new Date(trade.triggeredAt) : null,
      trade.closedAt ? new Date(trade.closedAt) : null,
    ]);
  } catch (e: any) {
    log.warn({ id: trade.id, err: e.message }, 'Failed to update expert trade');
  }
}

function rowToTrade(row: any): ExpertTrade {
  return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
}

export async function listExpertTrades(filter: ExpertTradeListFilter = {}): Promise<ExpertTrade[]> {
  const states = filter.state ?? OPEN_STATES;
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));

  if (dbMode() === 'postgres') {
    try {
      const conditions = ['state = ANY($1)'];
      const params: any[] = [states];
      if (filter.horizon) {
        conditions.push(`horizon = $${params.length + 1}`);
        params.push(filter.horizon);
      }
      const q = `
        SELECT data FROM expert_trades
        WHERE ${conditions.join(' AND ')}
        ORDER BY score DESC
        LIMIT $${params.length + 1};
      `;
      params.push(limit);
      const res = await pool.query(q, params);
      return res.rows.map(rowToTrade);
    } catch (e: any) {
      log.warn({ err: e.message }, 'Failed to list expert trades from Postgres, falling back to memory');
    }
  }

  return Array.from(memTrades.values())
    .filter((t) => states.includes(t.state) && (!filter.horizon || t.horizon === filter.horizon))
    .sort((a, b) => b.setup.score - a.setup.score)
    .slice(0, limit);
}

export async function getExpertTrade(id: string): Promise<ExpertTrade | null> {
  if (dbMode() === 'postgres') {
    try {
      const res = await pool.query('SELECT data FROM expert_trades WHERE id = $1', [id]);
      if (res.rows.length) return rowToTrade(res.rows[0]);
    } catch { /* fallback to mem */ }
  }
  return memTrades.get(id) ?? null;
}

export async function getExpertTradesBySymbol(symbol: string, limit = 20): Promise<ExpertTrade[]> {
  const upper = symbol.toUpperCase();
  if (dbMode() === 'postgres') {
    try {
      const res = await pool.query(
        'SELECT data FROM expert_trades WHERE symbol = $1 ORDER BY created_at DESC LIMIT $2',
        [upper, limit],
      );
      return res.rows.map(rowToTrade);
    } catch { /* fallback to mem */ }
  }
  return Array.from(memTrades.values())
    .filter((t) => t.symbol === upper)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** True if `symbol` already has an open (non-terminal) idea — the scan
 * loop uses this to avoid republishing the same setup every cycle. */
export async function hasOpenExpertTrade(symbol: string, openStates: ExpertTradeState[] = OPEN_STATES): Promise<boolean> {
  const trades = await getExpertTradesBySymbol(symbol, 5);
  return trades.some((t) => openStates.includes(t.state));
}

export async function clearExpertTradesForTests(): Promise<void> {
  memTrades.clear();
  if (dbMode() === 'postgres') {
    await pool.query('DELETE FROM expert_trades').catch(() => {});
  }
}
