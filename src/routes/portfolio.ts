import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  listPaperPositions, listPaperOrders, getPaperWallet, resetPaperWallet,
  closePaperPosition, listPaperStrategies, createPaperStrategy, updatePaperStrategyStatus,
  defaultMarginResolver, adjustWalletMargin, cancelPaperOrder,
} from '../db';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import { eventBus } from '../services/eventBus';
import { moduleLogger } from '../lib/logger';
import { aggregatePortfolioGreeks } from '../services/optionsAnalytics';

import type { PaperExecutionEngine } from '../engines/paper';
import type { AgentOrchestrator } from '../services/agent';
import { isValidSecurityId, keysMatch, toInstrumentKey, type InstrumentKey } from '../lib/instrumentKey';
import type { PortfolioSource } from '../services/portfolioSource';
import { buildMarginReconcileReport, buildPaperMarginReconcileReport } from '../services/portfolioSource';
import { brokerJournalMode, executionBrokerClient, isPaperMode, isSandboxMode } from '../lib/tradingMode';
import { marketClock } from '../services/marketHours';
import { journal, type JournalEntry } from '../services/journal';
import {
  ClosePositionSchema, PaperOrderSchema, StrategyCloseSchema, StrategyDeploySchema,
  StrategyStatusSchema, WalletResetSchema, zodError,
} from '../lib/routeSchemas';

const log = moduleLogger('portfolio');

async function findPositionByKey(key: InstrumentKey, portfolio?: PortfolioSource, tradingSymbol?: string) {
  const positions = portfolio ? await portfolio.getPositions() : await listPaperPositions();
  const byKey = positions.find((p) => Number(p.netQty ?? 0) !== 0 && keysMatch(toInstrumentKey(p), key));
  if (byKey) return byKey;
  if (!tradingSymbol) return undefined;
  const sym = String(tradingSymbol).toUpperCase();
  return positions.find((p) => Number(p.netQty ?? 0) !== 0 && String(p.tradingSymbol ?? '').toUpperCase() === sym);
}

type OrderRow = ReturnType<typeof normalizeBrokerOrder>;

export function formatDhanError(e: any): string {
  const code = e.errorCode || e.details?.errorCode;
  const msg = e.errorMessage || e.details?.errorMessage;
  const detail = [code, msg].filter(Boolean).join(': ');
  if (detail) return `${detail} (${e.message || 'Dhan API error'})`;
  return e.message || 'Dhan API request failed';
}

export async function cancelBrokerOrder(client: DhanClient, orderId: string, isSandbox = false) {
  try {
    return await client.orders.cancel(orderId);
  } catch (err: any) {
    const resolved = await client.orders.getByCorrelationId(orderId).catch(() => null);
    if (resolved?.orderId && String(resolved.orderId) !== orderId) {
      try {
        return await client.orders.cancel(String(resolved.orderId));
      } catch (innerErr: any) {
        err = innerErr;
      }
    }
    // Dhan sandbox OMS leaves orders in TRANSIT permanently and rejects cancel with DH-906.
    const isTransitError = err.errorCode === 'DH-906'
      || err.details?.errorCode === 'DH-906'
      || String(err.errorMessage || err.details?.errorMessage || '').toLowerCase().includes('transit');

    if (isSandbox && isTransitError) {
      log.warn({ orderId }, 'Sandbox order stuck in TRANSIT on DhanHQ OMS — cleared locally');
      return { orderId, orderStatus: 'CANCELLED', clearedTransit: true };
    }

    throw err;
  }
}

function mapBrokerStatus(status: string): string {
  if (status === 'TRANSIT') return 'PENDING';
  return status;
}

/** Maps DhanHQ OrderResponse → the same row shape listPaperOrders()
 * returns, so the frontend order book works in sandbox/live mode. */
export function normalizeBrokerOrder(r: any) {
  const timeRaw = r.createTime || r.updateTime;
  let time = '—';
  if (timeRaw) {
    try {
      const d = new Date(String(timeRaw).replace(' ', 'T') + '+05:30');
      time = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' });
    } catch {
      time = String(timeRaw);
    }
  }
  const qty = Number(r.quantity ?? 0);
  const filled = Number(r.filledQty ?? 0);
  const avg = Number(r.averageTradedPrice ?? 0);
  return {
    id: String(r.orderId ?? ''),
    corr: String(r.correlationId ?? ''),
    time,
    instrument: String(r.tradingSymbol ?? ''),
    type: String(r.orderType ?? 'MARKET'),
    side: String(r.transactionType ?? ''),
    qty,
    price: Number(r.price ?? 0),
    filled,
    avg: avg > 0 ? avg : undefined,
    charges: 0,
    leg: String(r.legName || '—'),
    status: mapBrokerStatus(String(r.orderStatus ?? 'UNKNOWN')),
    jid: String(r.correlationId || r.orderId || ''),
    latency: '—',
    createdAt: timeRaw,
    exchangeSegment: r.exchangeSegment,
    reason: String(r.omsErrorDescription || ''),
    source: 'broker',
  };
}

function journalOrderRows(mode: 'sandbox' | 'live'): OrderRow[] {
  const byCorr = new Map<string, { intent?: JournalEntry; result?: JournalEntry }>();
  for (const e of journal.readTodayEntries()) {
    const p = e.payload || {};
    if (p.mode !== mode) continue;
    const corr = String(p.correlation_id || '');
    if (!corr) continue;
    if (e.kind === 'order_intent') {
      const row = byCorr.get(corr) || {};
      row.intent = e;
      byCorr.set(corr, row);
    }
    if (e.kind === 'order_result') {
      const row = byCorr.get(corr) || {};
      row.result = e;
      byCorr.set(corr, row);
    }
  }

  const rows: OrderRow[] = [];
  for (const [corr, pair] of byCorr) {
    const intent = pair.intent?.payload || {};
    const result = pair.result?.payload || {};
    const params = intent.params || {};
    const ts = pair.result?.ts ?? pair.intent?.ts ?? Date.now();
    rows.push({
      id: String(result.order_id || pair.intent?.seq || corr),
      corr,
      time: new Date(ts).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
      instrument: String(result.symbol || params.symbol || params.security_id || '—'),
      type: String(params.order_type || 'MARKET'),
      side: String(params.transaction_type || result.transaction_type || ''),
      qty: Number(params.quantity ?? result.quantity ?? 0),
      price: Number(params.price ?? result.fill_price ?? 0),
      filled: Number(result.quantity ?? 0),
      avg: result.fill_price ? Number(result.fill_price) : undefined,
      charges: 0,
      leg: String(intent.intent_id || '—'),
      status: mapBrokerStatus(String(result.status || 'PENDING')),
      jid: corr,
      latency: '—',
      createdAt: new Date(ts).toISOString(),
      exchangeSegment: params.exchange_segment,
      reason: String(result.reason || ''),
      source: 'journal',
    });
  }
  return rows;
}

async function listBrokerOrders(client: DhanClient, mode: 'sandbox' | 'live' = 'live'): Promise<OrderRow[]> {
  const raw = await client.orders.list().catch(() => []);
  const today = marketClock().istDate;
  const broker = (Array.isArray(raw) ? raw : [])
    .filter((r) => !r.createTime || String(r.createTime).startsWith(today))
    .map(normalizeBrokerOrder);

  const cancelledKeys = new Set<string>();
  for (const e of journal.readTodayEntries()) {
    if (e.kind === 'order_result' && e.payload?.status === 'CANCELLED') {
      if (e.payload.order_id) cancelledKeys.add(String(e.payload.order_id));
      if (e.payload.correlation_id) cancelledKeys.add(String(e.payload.correlation_id));
    }
  }

  const merged = new Map<string, OrderRow>();
  for (const row of broker) {
    if (cancelledKeys.has(row.id) || (row.corr && cancelledKeys.has(row.corr))) {
      row.status = 'CANCELLED';
      row.reason = 'Cancelled by operator';
    }
    merged.set(row.corr || row.id, row);
  }
  for (const row of journalOrderRows(mode)) {
    if (!merged.has(row.corr) && !merged.has(row.id)) merged.set(row.corr || row.id, row);
  }

  return [...merged.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function portfolioRoutes(
  client: DhanClient,
  market: MarketDataService,
  risk?: RiskEngine,
  paper?: PaperExecutionEngine,
  agent?: AgentOrchestrator,
  portfolio?: PortfolioSource,
  sandboxClient?: DhanClient,
): Router {
  const router = Router();
  const isLocalPaper = () => !portfolio || portfolio.kind === 'paper';
  const brokerApiClient = () => executionBrokerClient(client, sandboxClient);

  router.get('/summary', async (req, res) => {
    try {
      const [positions, wallet, strategies, orders] = isLocalPaper()
        ? await Promise.all([listPaperPositions(), getPaperWallet(), listPaperStrategies(), listPaperOrders()])
        : await Promise.all([
          portfolio!.getPositions(),
          portfolio!.getWallet(),
          listPaperStrategies(),
          listBrokerOrders(brokerApiClient(), brokerJournalMode()),
        ]);
      const indices = market.getIndices();
      const spotMap: Record<string, number> = {};
      for (const [sym, data] of Object.entries(indices)) {
        if (data?.ltp) spotMap[sym] = data.ltp;
      }
      const greeks = aggregatePortfolioGreeks(positions, spotMap, new Date().toISOString().slice(0, 10));
      res.json({
        wallet,
        positions,
        strategies,
        ordersCount: orders.length,
        openPositionsCount: positions.filter((p: any) => p.netQty !== 0).length,
        greeks,
        risk: risk?.snapshot() || null,
      });
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message } }, 'Portfolio summary fetch failed');
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/positions', async (req, res) => {
    try {
      if (isLocalPaper() || req.query.mode === 'paper') {
        return res.json(await listPaperPositions());
      }
      res.json(await portfolio!.getPositions());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'positions' }, 'Positions fetch failed');
      res.json([]);
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      if (isLocalPaper() || req.query.mode === 'paper') {
        return res.json(await listPaperOrders());
      }
      const mode = brokerJournalMode();
      res.json(await listBrokerOrders(brokerApiClient(), mode));
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'orders' }, 'Orders fetch failed');
      res.json([]);
    }
  });

  router.post('/orders/cancel-all', async (req, res) => {
    try {
      if (isLocalPaper() || req.query.mode === 'paper') {
        const pending = (await listPaperOrders()).filter((o) => ['PENDING', 'TRANSIT', 'OPEN'].includes(o.status));
        for (const o of pending) await cancelPaperOrder(o.id);
        return res.json({ cancelledCount: pending.length });
      }
      const raw = await brokerApiClient().orders.list().catch(() => []);
      const pending = (Array.isArray(raw) ? raw : [])
        .filter((r) => ['PENDING', 'TRANSIT', 'OPEN'].includes(String(r.orderStatus ?? '')));
      let count = 0;
      for (const ord of pending) {
        const id = String(ord.orderId ?? '');
        if (!id) continue;
        try {
          await cancelBrokerOrder(brokerApiClient(), id, isSandboxMode());
          journal.append('order_result', {
            order_id: id,
            correlation_id: ord.correlationId ? String(ord.correlationId) : undefined,
            status: 'CANCELLED',
            reason: 'Cancel all via control plane',
            mode: brokerJournalMode(),
          });
          count++;
        } catch { /* proceed with remaining orders */ }
      }
      res.json({ cancelledCount: count });
    } catch (e: any) {
      const formatted = formatDhanError(e);
      log.warn({ requestId: req.id, err: { message: formatted } }, 'Cancel all orders failed');
      res.status(500).json({ error: formatted });
    }
  });

  router.post('/orders/:id/cancel', async (req, res) => {
    try {
      const orderId = String(req.params.id);
      const corr = req.body?.correlationId ? String(req.body.correlationId) : undefined;
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }
      if (isLocalPaper() || req.query.mode === 'paper') {
        const cancelled = await cancelPaperOrder(orderId);
        if (!cancelled) {
          return res.status(404).json({ error: `Paper order ${orderId} not found or not in PENDING state` });
        }
        return res.json({ orderId, orderStatus: 'CANCELLED' });
      }
      const result = await cancelBrokerOrder(brokerApiClient(), orderId, isSandboxMode());
      journal.append('order_result', {
        order_id: orderId,
        correlation_id: corr,
        status: 'CANCELLED',
        reason: 'Cancelled via control plane',
        mode: brokerJournalMode(),
      });
      eventBus.emit('order', { kind: 'cancel', orderId, correlationId: corr });
      res.json(result);
    } catch (e: any) {
      const formatted = formatDhanError(e);
      log.warn({ requestId: req.id, orderId: req.params.id, err: { message: formatted } }, 'Order cancel failed');
      res.status(422).json({ error: formatted });
    }
  });

  router.get('/funds', async (req, res) => {
    try {
      if (isLocalPaper() || req.query.mode === 'paper') {
        return res.json(await getPaperWallet());
      }
      res.json(await portfolio!.getWallet());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'funds' }, 'Funds fetch failed');
      res.json({});
    }
  });

  router.get('/trades', async (req, res) => {
    try {
      if (isLocalPaper() || req.query.mode === 'paper') {
        const orders = await listPaperOrders();
        return res.json(orders.filter((o) => o.status === 'TRADED'));
      }
      const trades = await brokerApiClient().orders.listTrades().catch(() => []);
      res.json((Array.isArray(trades) ? trades : []).map(normalizeBrokerOrder));
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'trades' }, 'Trades fetch failed');
      res.json([]);
    }
  });

  router.get('/greeks', async (_req, res) => {
    try {
      const positions = isLocalPaper() ? await listPaperPositions() : await portfolio!.getPositions();
      const indices = market.getIndices();
      const spotMap: Record<string, number> = {};
      for (const [sym, data] of Object.entries(indices)) {
        if (data?.ltp) spotMap[sym] = data.ltp;
      }
      const expiry = new Date().toISOString().slice(0, 10);
      const agg = aggregatePortfolioGreeks(positions, spotMap, expiry);
      res.json(agg);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/order', async (req, res) => {
    try {
      if (!isPaperMode()) {
        return res.status(400).json({ error: 'Manual paper orders are only available when TRADING_MODE=paper' });
      }
      const parsed = PaperOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { symbol, quantity, transactionType, price, orderType, productType, securityId, exchangeSegment } = parsed.data;
      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }

      // Route through PaperExecutionEngine so manual orders get the same
      // risk gate, LTP/LIMIT marketability check, slippage, latency, and
      // margin/fee handling as every other paper fill — no second path.
      const result = await paper.placeOrder({
        correlation_id: `manual_${Date.now().toString(36)}`,
        intent_id: 'manual_order',
        params: {
          security_id: securityId,
          symbol,
          quantity,
          transaction_type: transactionType,
          order_type: orderType,
          exchange_segment: exchangeSegment,
          product_type: productType,
          price,
        },
      });
      if (result.status === 'REJECTED') {
        return res.status(422).json({ error: result.reason });
      }
      eventBus.emit('order', { kind: 'fill', is_paper: true, symbol: String(symbol).toUpperCase(), fillPrice: result.fill_price, quantity, correlationId: result.correlation_id, source: 'manual' });
      res.json(result);
    } catch (e: any) {
      res.status(422).json({ error: e.message });
    }
  });

  router.post('/positions/close', async (req, res) => {
    try {
      if (isLocalPaper()) {
        return res.status(400).json({ error: 'Broker close is not available in paper mode — use /paper/positions/close' });
      }
      const parsed = ClosePositionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const key = toInstrumentKey(parsed.data);
      const { ltp, tradingSymbol } = parsed.data;
      const pos = await findPositionByKey(key, portfolio, tradingSymbol);
      const effectiveKey = pos ? toInstrumentKey(pos) : key;
      const liveLtp = pos ? market.getLtp(String(pos.securityId)) : null;
      const result = await portfolio!.closePosition(effectiveKey, liveLtp || (ltp ? Number(ltp) : undefined), undefined, undefined, pos?.tradingSymbol);
      if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      if (result.status === 'REJECTED') return res.status(422).json({ error: result.reason || 'Close rejected' });
      if (result.status === 'noop') return res.status(404).json({ error: result.reason || 'No open position found' });
      res.json(result);
    } catch (e: any) {
      res.status(e.message?.includes('required') ? 400 : 500).json({ error: e.message });
    }
  });

  router.post('/positions/close-all', async (req, res) => {
    try {
      if (isLocalPaper()) {
        return res.status(400).json({ error: 'Broker close-all is not available in paper mode' });
      }
      const results = await portfolio!.closeAll((secId) => market.getLtp(secId));
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/positions/close', async (req, res) => {
    try {
      const parsed = ClosePositionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const key = toInstrumentKey(parsed.data);
      const { ltp, tradingSymbol } = parsed.data;
      const pos = await findPositionByKey(key, !isLocalPaper() && portfolio ? portfolio : undefined, tradingSymbol);
      const effectiveKey = pos ? toInstrumentKey(pos) : key;
      if (!isLocalPaper() && portfolio) {
        const liveLtp = pos ? market.getLtp(String(pos.securityId)) : null;
        const result = await portfolio.closePosition(effectiveKey, liveLtp || (ltp ? Number(ltp) : undefined), undefined, undefined, pos?.tradingSymbol);
        if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        if (result.status === 'REJECTED') return res.status(422).json({ error: result.reason || 'Close rejected' });
        if (result.status === 'noop') return res.status(404).json({ error: result.reason || 'No open position found' });
        return res.json(result);
      }
      const liveLtp = pos ? market.getLtp(String(pos.securityId)) : null;
      const closeTarget = pos && !isValidSecurityId(effectiveKey.securityId) ? pos.tradingSymbol : effectiveKey;
      const result = await closePaperPosition(closeTarget, liveLtp || (ltp ? Number(ltp) : undefined));
      if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      if (result.status === 'noop') return res.status(404).json({ error: result.message || 'No open position found' });
      res.json(result);
    } catch (e: any) {
      res.status(e.message?.includes('required') ? 400 : 500).json({ error: e.message });
    }
  });

  router.post('/paper/wallet/reset', async (req, res) => {
    try {
      const parsed = WalletResetSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data) {
        return res.status(400).json({ error: parsed.success ? 'empty body' : zodError(parsed.error) });
      }
      const { initialBalance } = parsed.data;
      const result = await resetPaperWallet(initialBalance);
      eventBus.log('WARN', `Paper wallet reset to ₹${initialBalance.toLocaleString('en-IN')} (positions cleared)`, 'wallet_admin');
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/strategies', async (_req, res) => {
    try {
      const strategies = await listPaperStrategies();
      const positions = isLocalPaper()
        ? await listPaperPositions()
        : (portfolio ? await portfolio.getPositions() : []);
      const posBySymbol = new Map(positions.map((p) => [p.tradingSymbol, p]));
      const posBySecId = new Map(positions.filter((p) => p.securityId).map((p) => [String(p.securityId), p]));

      const enriched = strategies.map((s) => {
        let totalPnl = 0;
        const legs = (s.legs || []).map((l: any) => {
          const p = posBySymbol.get(l.instrument) || (l.securityId ? posBySecId.get(String(l.securityId)) : undefined);
          const liveLtp = l.securityId ? market.getLtp(String(l.securityId)) : 0;
          const ltp = p?.ltp || liveLtp || l.ltp || l.price || 0;
          const pnl = p?.pnl ?? 0;
          totalPnl += pnl;
          return { ...l, ltp, pnl };
        });
        return { ...s, pnl: totalPnl, legs };
      });
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/deploy', async (req, res) => {
    try {
      if (!isPaperMode()) {
        return res.status(400).json({ error: 'Paper strategy deploy is only available when TRADING_MODE=paper' });
      }
      const parsed = StrategyDeploySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { name, symbol, type, lots, legs } = parsed.data;
      // Strategy deployment is blocked by the kill switch / EOD window too.
      const gate = risk?.canTrade();
      if (gate && !gate.allowed) {
        return res.status(423).json({ error: `Deployment blocked by risk engine: ${gate.reason}` });
      }
      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }
      const strategyId = `s_${Date.now().toString(36)}`;

      // Price every leg up front so a multi-leg strategy's combined margin
      // (with hedge benefit) can be resolved before any leg fills.
      const pricedLegs = (legs || []).map((leg: any) => {
        const liveLtp = market.getLtp(leg.securityId || '0');
        const legPrice = liveLtp || Number(leg.bAvg || leg.sAvg || leg.price || 0);
        return { leg, legPrice };
      }).filter((p: any) => {
        if (!p.legPrice) eventBus.log('WARN', `Strategy ${name}: leg ${p.leg.instrument} has no live price — leg skipped`, 'portfolio');
        return p.legPrice > 0;
      });
      if (pricedLegs.length === 0) {
        return res.status(422).json({ error: 'No leg could be priced from the live market feed — strategy not deployed' });
      }

      let combinedMargin: number | null = null;
      if (pricedLegs.length > 1) {
        try {
          const resp: any = await (client as any).marginCalculator.calculateMulti(
            pricedLegs.map(({ leg, legPrice }: any) => ({
              exchangeSegment: leg.exchangeSegment || 'NSE_FNO',
              productType: 'INTRADAY',
              transactionType: leg.side,
              securityId: leg.securityId,
              quantity: leg.qty,
              price: legPrice,
            })),
          );
          const total = Number(resp?.totalMargin ?? resp?.data?.totalMargin);
          if (total > 0) combinedMargin = total;
        } catch { /* hedge-netted margin unavailable — each leg blocks its own standalone margin */ }
      }

      const usedMarginBefore = (await getPaperWallet()).usedMargin;
      let filled = 0;
      const legsWithPx = [];
      for (const { leg, legPrice } of pricedLegs) {
        // Route through PaperExecutionEngine — same risk/margin/fee/slippage
        // handling as every other paper fill, no second path.
        const result = await paper.placeOrder({
          correlation_id: `${strategyId}_${leg.instrument}`,
          intent_id: strategyId,
          params: {
            security_id: leg.securityId || '0',
            symbol: leg.instrument,
            quantity: leg.qty,
            transaction_type: leg.side,
            order_type: 'MARKET',
            exchange_segment: leg.exchangeSegment || 'NSE_FNO',
            product_type: 'INTRADAY',
            price: legPrice,
          },
        });
        if (result.status !== 'TRADED') {
          // Stop rather than skip to the next leg — firing more legs into a
          // structure that's already broken only adds more exposure to unwind.
          eventBus.log('WARN', `Strategy ${name}: leg ${leg.instrument} rejected — ${result.reason}`, 'portfolio');
          break;
        }
        filled++;
        legsWithPx.push({ ...leg, ltp: result.fill_price });
        // Keep tracking this instrument for mark-to-market.
        if (leg.securityId) {
          market.addInstruments([{ securityId: String(leg.securityId), exchangeSegment: leg.exchangeSegment || 'NSE_FNO' }]);
        }
      }
      if (filled === 0) {
        return res.status(422).json({ error: 'No leg could be priced from the live market feed — strategy not deployed' });
      }
      if (filled < pricedLegs.length) {
        // Partial fill on a multi-leg structure is worse than no fill — e.g.
        // a short leg filling without its hedge is naked, undefined risk.
        // Unwind whatever filled rather than leaving it to stand.
        //
        // Goes through closePaperPosition(), NOT paper.placeOrder() — that
        // re-checks risk.canTrade(), the SAME gate whose failure typically
        // caused THIS partial fill (a breaker tripping between legs, or the
        // kill switch arming). A risk-REDUCING close must never be blocked
        // by the entry gate; closePaperPosition() doesn't check it.
        for (const filledLeg of legsWithPx) {
          const unwindPrice = market.getFillablePrice(String(filledLeg.securityId || '0'), { allowClosed: true }) ?? filledLeg.ltp;
          const legKey = { securityId: String(filledLeg.securityId), exchangeSegment: filledLeg.exchangeSegment || 'NSE_FNO' };
          const result: any = isLocalPaper()
            ? await closePaperPosition(legKey, unwindPrice).catch((e: any) => ({ status: 'REJECTED', message: e.message }))
            : await portfolio!.closePosition(legKey, unwindPrice).catch((e: any) => ({ status: 'REJECTED', message: e.message }));
          if (result.status === 'TRADED' && filledLeg.securityId) {
            market.monitor.untrack(filledLeg.exchangeSegment || 'NSE_FNO', String(filledLeg.securityId));
          } else if (result.status !== 'TRADED') {
            // Untracking here would strip stop-loss/target from a leg that
            // is STILL open.
            eventBus.log('ERROR', `Unwind FAILED for leg ${filledLeg.instrument}: ${result.status}${result.message ? ` (${result.message})` : ''} — still open, protection left tracked`, 'portfolio');
          }
        }
        eventBus.log('ERROR', `Strategy ${name}: partial fill (${filled}/${pricedLegs.length} legs) — unwound`, 'portfolio');
        return res.status(422).json({ error: `Partial fill (${filled}/${pricedLegs.length} legs) — unwound, strategy not deployed` });
      }

      // Release the hedge benefit: legs above each blocked their own
      // standalone margin, but a hedged combo needs less than the sum.
      let marginHedgeCredit = 0;
      if (combinedMargin != null) {
        const usedMarginAfter = (await getPaperWallet()).usedMargin;
        const standaloneAdded = usedMarginAfter - usedMarginBefore;
        marginHedgeCredit = Math.max(0, Number((standaloneAdded - combinedMargin).toFixed(2)));
        if (marginHedgeCredit > 0) await adjustWalletMargin(marginHedgeCredit);
      }

      await createPaperStrategy({ id: strategyId, name, symbol, type, lots, legs: legsWithPx, marginHedgeCredit });
      eventBus.log('TRADE', `Strategy "${name}" deployed (${filled} leg(s) filled at live prices${marginHedgeCredit > 0 ? `, ₹${marginHedgeCredit.toFixed(2)} hedge margin released` : ''})`, 'portfolio');
      res.json({ status: 'ok', strategyId, legsFilled: filled, marginHedgeCredit });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/status', async (req, res) => {
    try {
      const parsed = StrategyStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { id, status } = parsed.data;
      await updatePaperStrategyStatus(id, status);
      res.json({ status: 'ok', id, newStatus: status });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/execute', async (req, res) => {
    try {
      const parsed = StrategyCloseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { id } = parsed.data;
      const strategies = await listPaperStrategies();
      const strat = strategies.find((s) => s.id === id);
      if (!strat) return res.status(404).json({ error: 'Strategy not found' });

      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }
      const gate = risk?.canTrade();
      if (gate && !gate.allowed) {
        return res.status(423).json({ error: `Execution blocked by risk engine: ${gate.reason}` });
      }

      let filled = 0;
      for (const leg of strat.legs || []) {
        const liveLtp = market.getLtp(leg.securityId || '0') ?? market.getLtp(String(leg.instrument));
        const legPrice = liveLtp || Number(leg.bAvg || leg.sAvg || leg.price || 0);
        if (!legPrice) continue;

        await paper.placeOrder({
          correlation_id: `${strat.id}_${leg.optionType || 'OPT'}_${leg.strike || '0'}`,
          intent_id: `trigger_${strat.id}`,
          params: {
            security_id: leg.securityId,
            symbol: leg.instrument,
            quantity: leg.qty,
            transaction_type: leg.side,
            order_type: 'MARKET',
            exchange_segment: leg.exchangeSegment || 'NSE_FNO',
            product_type: 'INTRADAY',
            price: legPrice,
          },
          risk_limits: {
            stop_loss: leg.stopLoss,
            target: leg.target,
            trailing_stop: leg.trailingStop,
          },
        });
        filled++;
      }

      await updatePaperStrategyStatus(id, 'RUNNING');
      eventBus.log('TRADE', `Strategy "${strat.name}" executed & RUNNING (${filled} leg(s) filled with SL/TP)`, 'portfolio');
      res.json({ status: 'ok', strategyId: id, legsFilled: filled });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/close', async (req, res) => {
    try {
      const parsed = StrategyCloseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { id } = parsed.data;
      const strategies = await listPaperStrategies();
      const strat = strategies.find((s) => s.id === id);
      if (strat) {
        // updatePaperStrategyStatus('STOPPED') below reverses any
        // hedge-margin credit exactly once — don't duplicate it here.
        const positions = isLocalPaper()
          ? await listPaperPositions()
          : (portfolio ? await portfolio.getPositions() : []);
        for (const leg of strat.legs) {
          const pos = positions.find((p) => p.tradingSymbol === leg.instrument || (leg.securityId && String(p.securityId) === String(leg.securityId)));
          const ltp = pos ? market.getLtp(String(pos.securityId)) || pos.ltp : undefined;
          const legKey = { securityId: String(leg.securityId || pos?.securityId), exchangeSegment: leg.exchangeSegment || pos?.exchangeSegment || 'NSE_FNO' };
          if (isLocalPaper()) {
            await closePaperPosition(legKey, ltp);
          } else if (portfolio) {
            await portfolio.closePosition(legKey, ltp);
          }
          if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        }
        await updatePaperStrategyStatus(id, 'STOPPED');
      }
      res.json({ status: 'ok', id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/margin/calculate', async (req, res) => {
    try {
      const items = req.body.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        return res.json({ totalMargin: 0, spanMargin: 0, exposureMargin: 0 });
      }
      try {
        const resp = await (client as any).marginCalculator.calculateMulti(items);
        return res.json(resp.data || resp);
      } catch (e: any) {
        // DhanHQ margin calculator unavailable — report the estimate AND
        // the reason, instead of silently pretending it was real. Uses the
        // same conservative fallback as paper order execution (db.ts):
        // BUY = full premium (correct, no leverage on long options), SELL =
        // a conservative multiple, since SPAN+exposure isn't a fixed
        // fraction of premium and this only runs if the real API fails.
        let total = 0;
        for (const it of items) {
          const px = Number(it.price || 0);
          const qty = Number(it.quantity || 0);
          if (px > 0 && qty > 0) {
            total += await defaultMarginResolver({ side: it.transactionType, securityId: String(it.securityId || '0'), exchangeSegment: it.exchangeSegment || 'NSE_FNO', productType: it.productType || 'INTRADAY', quantity: qty, price: px });
          }
        }
        return res.json({
          totalMargin: Number(total.toFixed(2)),
          spanMargin: Number((total * 0.7).toFixed(2)),
          exposureMargin: Number((total * 0.3).toFixed(2)),
          estimated: true,
          estimateReason: `DhanHQ margin API unavailable (${e.message}) — approximate premium-based estimate`,
        });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/holdings', async (req, res) => {
    try {
      const holdings = await brokerApiClient().positions.listHoldings();
      res.json(holdings);
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'holdings' }, 'Holdings fetch failed');
      res.json([]);
    }
  });

  router.get('/profile', async (req, res) => {
    try {
      const profile = await brokerApiClient().profile.get();
      res.json(profile);
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'profile' }, 'Profile fetch failed');
      // Honest error — no fake trader identity.
      res.status(502).json({ error: `DhanHQ profile unavailable: ${e.message}`, authenticated: false });
    }
  });

  router.get('/margin/reconcile', async (req, res) => {
    try {
      if (isLocalPaper()) {
        return res.json(await buildPaperMarginReconcileReport());
      }
      if (!portfolio) return res.status(503).json({ error: 'Portfolio source unavailable' });
      res.json(await buildMarginReconcileReport(brokerApiClient(), portfolio));
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'margin_reconcile' }, 'Margin reconcile failed');
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
