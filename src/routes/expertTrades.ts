import { Router } from 'express';
import type { ExpertTradeEngine } from '../services/expertTrades/expertTradeEngine';
import { getExpertTrade, getExpertTradesBySymbol, listExpertTrades } from '../services/expertTrades/repository';
import type { ExpertTradeHorizon, ExpertTradeState } from '../services/expertTrades/types';

const OPEN_STATES: ExpertTradeState[] = ['NEW', 'ACTIVE', 'TARGET_1'];
const PAST_STATES: ExpertTradeState[] = ['TARGET_2', 'STOPPED', 'EXPIRED', 'INVALIDATED'];
const ALL_STATES: ExpertTradeState[] = [...OPEN_STATES, ...PAST_STATES];
const ALL_HORIZONS: ExpertTradeHorizon[] = ['SHORT_TERM', 'MID_TERM', 'LONG_TERM'];

/**
 * Express REST API router for the NSE Equity Expert Trade Engine.
 * Follows the same shape as researchRoutes.ts: thin handlers, business
 * logic lives entirely in services/expertTrades/*.
 */
export function expertTradesRoutes(engine: ExpertTradeEngine): Router {
  const router = Router();

  // GET /api/expert-trades - open trade ideas (NEW/ACTIVE/TARGET_1 by default)
  router.get('/', async (req, res) => {
    const rawStates = typeof req.query.state === 'string' ? req.query.state.split(',') : undefined;
    const states = rawStates?.filter((s): s is ExpertTradeState => ALL_STATES.includes(s as ExpertTradeState));
    const horizon = ALL_HORIZONS.includes(req.query.horizon as ExpertTradeHorizon) ? (req.query.horizon as ExpertTradeHorizon) : undefined;
    const limit = Number(req.query.limit) || undefined;
    try {
      const trades = await listExpertTrades({ state: states?.length ? states : OPEN_STATES, horizon, limit });
      return res.json({ count: trades.length, trades });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/expert-trades/past - closed trade ideas (target/stop/expired/invalidated)
  router.get('/past', async (req, res) => {
    const limit = Number(req.query.limit) || undefined;
    try {
      const trades = await listExpertTrades({ state: PAST_STATES, limit });
      return res.json({ count: trades.length, trades });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/expert-trades/scanner/status - last scan summary
  router.get('/scanner/status', (_req, res) => {
    return res.json(engine.getStatus() ?? { scannedAt: null, message: 'No scan has run yet' });
  });

  // POST /api/expert-trades/scan - run the pipeline (universe -> setup -> levels -> score -> publish)
  router.post('/scan', async (req, res) => {
    const { universe, exchange, maxUniverse, maxPublished } = req.body || {};
    try {
      const summary = await engine.scan({
        universe,
        exchange: exchange === 'BSE' ? 'BSE' : exchange === 'NSE' ? 'NSE' : undefined,
        maxUniverse: maxUniverse ? Number(maxUniverse) : undefined,
        maxPublished: maxPublished ? Number(maxPublished) : undefined,
      });
      return res.status(200).json(summary);
    } catch (e: any) {
      return res.status(500).json({ error: `Scan failed: ${e.message}` });
    }
  });

  // GET /api/expert-trades/symbol/:symbol - trade idea history for one symbol
  router.get('/symbol/:symbol', async (req, res) => {
    try {
      const trades = await getExpertTradesBySymbol(req.params.symbol.toUpperCase());
      return res.json({ count: trades.length, trades });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/expert-trades/:id - a single trade idea
  router.get('/:id', async (req, res) => {
    try {
      const trade = await getExpertTrade(req.params.id);
      if (!trade) return res.status(404).json({ error: `Expert trade ${req.params.id} not found` });
      return res.json(trade);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}
