import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import type { MarketDataService } from '../services/marketData';
import { toTrailConfig } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import { buildSandboxPlaceRequest, resolveSandboxOptionLeg, roundToTick } from '../services/sandboxInstruments';
import { executePaperOrder, closePaperPosition } from '../db';
import {
  dhanRateLimitRemainingSec, isDhanRateLimited, isRateLimitError, noteDhanRateLimit,
} from '../lib/dhanRateLimit';

function dhanErrorDetail(e: any): string {
  return [e.errorCode, e.errorType, e.errorMessage].filter(Boolean).join(' | ');
}

function parseCircuitClamp(desc: string | undefined, price: number, tickSize: number): number | null {
  if (!desc) return null;
  const m = desc.match(/Circuit Limits of ([\d.]+) to ([\d.]+)/i);
  if (!m) return null;
  const min = Number(m[1]), max = Number(m[2]);
  if (!(max > 0)) return null;
  const clamped = roundToTick(Math.min(max, Math.max(min, price)), tickSize);
  return clamped !== price ? clamped : null;
}

/**
 * Sandbox execution engine — places orders through DhanHQ's real Sandbox
 * API (paper trading, flat ₹100 fills, no order-update WebSocket).
 *
 * Unlike LiveExecutionEngine, there's no OrderTracker/WS to wait on:
 * sandbox fills are synchronous, so a single getById() right after place()
 * is enough to read back the settled status. Market data/WS stay on the
 * Real client (this.market), shared with Paper/Live — sandbox is order
 * routing only.
 */
export class SandboxExecutionEngine {
  private client: DhanClient;
  private instrumentsClient: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;

  /**
   * @param client - Sandbox-account client (order routing only).
   * @param market - Market data service (production WS/quotes).
   * @param risk - Risk engine.
   * @param instrumentsClient - Production client for scrip lookups. Sandbox's
   *   /v2/instrument endpoint has a limited scrip master and is missing many
   *   live contracts (e.g. SENSEX options) — always use the prod endpoint.
   */
  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine, instrumentsClient?: DhanClient) {
    this.client = client;
    this.instrumentsClient = instrumentsClient ?? client;
    this.market = market;
    this.risk = risk;
  }

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', exchange_segment = 'NSE_FNO', price = 0 } = params;
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Sandbox order REJECTED for ${correlation_id}: ${gate.reason}`, 'sandbox_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason: gate.reason };
    }
    if (isDhanRateLimited()) {
      const reason = `Dhan API rate limit — retry in ${dhanRateLimitRemainingSec()}s`;
      eventBus.log('WARN', `Sandbox order skipped for ${correlation_id}: ${reason}`, 'sandbox_engine');
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox', rate_limited: true });
      return { status: 'REJECTED', reason };
    }

    let secId = String(security_id);
    let qty = quantity;
    let seg = exchange_segment;
    let limitPrice = price;
    let sandboxContract: string | undefined;

    const leg = await resolveSandboxOptionLeg(this.instrumentsClient, {
      securityId: security_id,
      exchangeSegment: exchange_segment,
    });
    if (!leg) {
      if (isDhanRateLimited()) {
        const reason = `Dhan API rate limit — retry in ${dhanRateLimitRemainingSec()}s`;
        journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox', rate_limited: true });
        return { status: 'REJECTED', reason };
      }
      const reason = `sandbox: ${exchange_segment}/${security_id} not found in scrip master`;
      journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'sandbox' });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }

    if (leg.securityId !== secId) {
      eventBus.log('INFO', `Sandbox remap ${secId}→${leg.securityId} (${leg.displayName || params.symbol})`, 'sandbox_engine');
    }
    secId = leg.securityId;
    qty = leg.quantity;
    seg = leg.exchangeSegment;
    limitPrice = roundToTick(price, leg.tickSize);
    sandboxContract = leg.displayName;

    journal.append('order_intent', {
      correlation_id, intent_id,
      params: { ...params, security_id: secId, quantity: qty, exchange_segment: seg, price: limitPrice, sandbox_contract: sandboxContract },
      risk_limits, mode: 'sandbox',
    });

    eventBus.log('TRADE', `Placing SANDBOX order ${transaction_type} ${qty} × ${secId} (${correlation_id})`, 'sandbox_engine');

    let orderId = '';
    let settled: any = null;
    let isMockFallback = false;

    try {
      try {
        const placed = await this.client.orders.place(buildSandboxPlaceRequest({
          correlationId: correlation_id,
          securityId: secId,
          exchangeSegment: seg,
          transactionType: transaction_type,
          orderType: order_type,
          quantity: qty,
          price: limitPrice,
          productType: params.product_type || 'INTRADAY',
        }));

        orderId = String(placed?.data?.orderId || (placed as any)?.orderId || '');
        const settledRaw = await this.client.orders.getById(orderId).catch(() => placed?.data);
        settled = Array.isArray(settledRaw) ? settledRaw[0] : (settledRaw?.data || settledRaw);
      } catch (err: any) {
        const code = err.errorCode || err.details?.errorCode;
        if (code === 'DH-905') {
          eventBus.log('INFO', `Dhan sandbox OMS mock scrip limitation for ${secId} [DH-905] — executing locally in sandbox paper ledger`, 'sandbox_engine');
          isMockFallback = true;
          orderId = `sbx_${Date.now().toString(36)}`;
          settled = { orderStatus: 'TRADED', averageTradedPrice: limitPrice, filledQty: qty };
        } else {
          throw err;
        }
      }
      // Auto-retry once if sandbox contract rejected due to synthetic circuit limits
      const circuitPrice = isMockFallback ? null : parseCircuitClamp(settled?.omsErrorDescription, limitPrice, leg.tickSize);
      if (settled?.orderStatus === 'REJECTED' && circuitPrice != null) {
        eventBus.log('INFO', `Retrying sandbox order ${correlation_id} @ ₹${circuitPrice} inside circuit limits`, 'sandbox_engine');
        const retry = await this.client.orders.place(buildSandboxPlaceRequest({
          correlationId: `${correlation_id.slice(0, 23)}_r`,
          securityId: secId,
          exchangeSegment: seg,
          transactionType: transaction_type,
          orderType: order_type,
          quantity: qty,
          price: circuitPrice,
          productType: params.product_type || 'INTRADAY',
        })).catch(() => null);
        if (retry?.data?.orderId) {
          orderId = retry.data.orderId;
          limitPrice = circuitPrice;
          const retryRaw = await this.client.orders.getById(orderId).catch(() => retry.data);
          settled = Array.isArray(retryRaw) ? retryRaw[0] : (retryRaw?.data || retryRaw);
        }
      }

      const orderStatus = String(settled?.orderStatus || 'TRADED');
      if (orderStatus === 'REJECTED' || orderStatus === 'CANCELLED') {
        const reason = settled?.omsErrorDescription || `Sandbox order ${orderStatus.toLowerCase()}`;
        journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox', order_id: orderId });
        this.risk.getPortfolio().recordOrderOutcome({ status: 'REJECTED' });
        eventBus.log('WARN', `Sandbox order ${orderId} REJECTED: ${reason}`, 'sandbox_engine');
        return { status: 'REJECTED', reason, orderId };
      }

      const avgTraded = Number(settled?.averageTradedPrice ?? settled?.averagePrice ?? 0);
      const fillPrice = avgTraded > 0 ? avgTraded : limitPrice;
      const filledQty = Number(settled?.filledQty ?? qty);

      const fillPayload = {
        intent_id,
        correlation_id,
        mode: 'sandbox' as const,
        is_paper: isMockFallback,
        fill_price: fillPrice,
        quantity: filledQty > 0 ? filledQty : qty,
        security_id: secId,
        order_id: orderId,
        filled_at: new Date().toISOString(),
      };

      eventBus.emit('order', { kind: 'fill', ...fillPayload });
      journal.append('order_result', { status: orderStatus, ...fillPayload });

      this.risk.getPortfolio().recordOrderOutcome({ status: 'TRADED' });
      this.risk.getPortfolio().invalidate();

      await executePaperOrder({
        symbol: sandboxContract || params.symbol || secId,
        securityId: secId,
        exchangeSegment: seg,
        transactionType: transaction_type,
        orderType: order_type,
        productType: params.product_type || 'INTRADAY',
        quantity: filledQty > 0 ? filledQty : qty,
        price: fillPrice,
        correlationId: correlation_id.slice(0, 25),
        stopLoss: risk_limits?.stop_loss,
        target: risk_limits?.target,
        trailingStop: risk_limits?.trailing_stop,
        tradingMode: 'sandbox',
      }, async () => 0, 'sandbox').catch(() => {});

      if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target)) {
        this.market.monitor.track({
          securityId: secId,
          exchangeSegment: seg,
          quantity: transaction_type === 'SELL' ? -filledQty : filledQty,
          entryPrice: fillPrice,
          stopLoss: risk_limits.stop_loss,
          target: risk_limits.target,
          trail: toTrailConfig(risk_limits.trailing_stop),
        });
      }

      this.market.addInstruments([{ securityId: secId, exchangeSegment: seg }]);
      return { status: orderStatus, orderId, ...fillPayload };
    } catch (e: any) {
      const detail = dhanErrorDetail(e);
      const reason = detail ? `${e.message} (${detail})` : e.message;
      if (isRateLimitError(reason)) {
        noteDhanRateLimit({ message: reason, retryAfterMs: e.retryAfterMs }, (msg) => {
          eventBus.log('WARN', msg, 'sandbox_engine');
        });
      } else {
        this.risk.getPortfolio().recordOrderOutcome({ status: 'REJECTED' });
      }
      eventBus.log('ERROR', `Sandbox order FAILED for ${correlation_id}: ${reason}`, 'sandbox_engine');
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }
  }

  /**
   * Reverses a filled leg via a real MARKET order at the Sandbox account —
   * used to unwind a partial multi-leg fill. Deliberately bypasses
   * risk.canTrade(): an exit must keep working while the entry gate blocks
   * new orders (kill switch, system not READY), same as PortfolioSource.
   * closePosition() does for paper/live. Sandbox fills live only at the
   * Dhan Sandbox account — never in PortfolioSource — so unwinding here
   * cannot go through portfolio.closePosition() like the other two modes.
   */
  async closeLeg(leg: { securityId: string; exchangeSegment?: string; qty: number; side: 'BUY' | 'SELL'; instrument?: string }, price: number, correlationId: string = `u_${leg.securityId}_${Date.now().toString(36)}`.slice(0, 25)): Promise<{ status: string; orderId?: string }> {
    const placed = await this.client.orders.place(buildSandboxPlaceRequest({
      correlationId,
      securityId: String(leg.securityId),
      exchangeSegment: leg.exchangeSegment || 'NSE_FNO',
      transactionType: leg.side === 'BUY' ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity: leg.qty,
      price,
      productType: 'INTRADAY',
    })).catch(() => null);
    const orderId = placed?.data?.orderId || `sbx_u_${Date.now().toString(36)}`;
    await closePaperPosition({ securityId: String(leg.securityId), exchangeSegment: leg.exchangeSegment || 'NSE_FNO' }, price, async () => 0, 'EXIT', 'sandbox').catch(() => {});
    this.risk.getPortfolio().invalidate();
    return { status: 'TRADED', orderId };
  }
}
