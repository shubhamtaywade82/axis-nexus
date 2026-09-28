import type { DhanClient, OrderTracker, PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { redisPublisher } from '../auth';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import type { MarketDataService } from '../services/marketData';
import { toTrailConfig } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import type { PortfolioSource } from '../services/portfolioSource';

/**
 * Live execution engine — places REAL orders through DhanHQ v2.
 *
 * Order settlement uses the SDK's OrderTracker, which is fed by the
 * DhanHQ order-update WebSocket (connected once at boot by
 * MarketDataService). The register-before-place pattern ensures fast
 * fills are captured.
 */
export class LiveExecutionEngine {
  private client: DhanClient;
  private tracker: OrderTracker;
  private monitor: PositionMonitor;
  private market: MarketDataService;
  private risk: RiskEngine;
  private portfolio?: PortfolioSource;

  constructor(client: DhanClient, tracker: OrderTracker, monitor: PositionMonitor, market: MarketDataService, risk: RiskEngine, portfolio?: PortfolioSource) {
    this.client = client;
    this.tracker = tracker;
    this.monitor = monitor;
    this.market = market;
    this.risk = risk;
    this.portfolio = portfolio;
  }

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', exchange_segment = 'NSE_FNO', price = 0 } = params;
    journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'live' });

    // Risk gate — kill switch blocks live orders too.
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Live order BLOCKED for ${correlation_id}: ${gate.reason}`, 'live_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason, mode: 'live' });
      this.portfolio?.recordOrderOutcome({ status: 'REJECTED' });
      return { status: 'REJECTED', reason: gate.reason };
    }

    eventBus.log('TRADE', `Placing LIVE order ${transaction_type} ${quantity} × ${security_id} (${correlation_id})`, 'live_engine');

    // Dhan truncates correlationId to 25 chars; the waiter must use the same
    // key the order-update WS will echo back, or it can never match.
    const brokerCorrelationId = correlation_id ? String(correlation_id).slice(0, 25) : undefined;
    // Register the waiter BEFORE placing — a fast fill can beat the HTTP response.
    const settled = brokerCorrelationId ? this.tracker.waitFor(brokerCorrelationId, { timeoutMs: 30000 }) : Promise.reject(new Error('no correlation id'));
    settled.catch(() => { /* observed below; avoids an unhandled rejection if place() throws */ });

    try {
      await this.client.orders.place({
        correlationId: brokerCorrelationId,
        securityId: String(security_id),
        exchangeSegment: exchange_segment,
        transactionType: transaction_type,
        orderType: order_type,
        quantity,
        price,
        productType: params.product_type || 'INTRADAY',
      });
    } catch (e: any) {
      return this.reject(correlation_id, `Order placement failed: ${e.message}`);
    }

    let fill: any = null;
    try {
      fill = await settled;
    } catch (e: any) {
      // Timeout is not fatal — the order lives at the broker. Report pending.
      eventBus.log('WARN', `Order ${correlation_id} placed but settlement not observed yet (${e.message})`, 'live_engine');
      fill = { status: 'PENDING', filledQuantity: 0, averagePrice: price };
    }
    if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(String(fill.status))) {
      this.portfolio?.invalidate();
      return this.reject(correlation_id, fill.state?.omsErrorDescription || `Order ${String(fill.status).toLowerCase()} by broker`);
    }

    const fillPayload = {
      intent_id,
      correlation_id,
      mode: 'live' as const,
      is_paper: false,
      fill_price: fill.averagePrice || price,
      quantity: fill.filledQuantity || quantity,
      security_id,
      filled_at: new Date().toISOString(),
    };

    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    journal.append('order_result', { status: fill.status || 'TRADED', ...fillPayload });
    this.portfolio?.recordOrderOutcome({ status: 'TRADED' });
    await redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});
    // The broker's own position/wallet state just changed — force the NEXT
    // read to poll rather than serve a snapshot from before this fill.
    // Without this, autonomy's reconcileMonitor can see monitor.track()
    // below (which is synchronous, right below) applied against a position
    // list that doesn't contain this fill yet, judge the freshly-tracked
    // entry an orphan with "no matching open position", untrack it, and on
    // the following cycle reconcileUnmanagedLivePositions flattens it and
    // arms the kill switch as an "unmanaged" position.
    this.portfolio?.invalidate();

    if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target)) {
      const filledQty = fill.filledQuantity || quantity;
      this.monitor.track({
        securityId: String(security_id),
        exchangeSegment: exchange_segment,
        // Signed by transaction_type — PositionMonitor.quantity is positive
        // for a long, negative for a short, and a raw filledQuantity is
        // always positive regardless of side. An unsigned quantity here
        // tracked a short exactly backwards: its stop-loss fired on a price
        // FALL (a profit for a short) and its target on a RISE (the loss).
        quantity: transaction_type === 'SELL' ? -filledQty : filledQty,
        entryPrice: fill.averagePrice || price,
        stopLoss: risk_limits.stop_loss,
        target: risk_limits.target,
        trail: toTrailConfig(risk_limits.trailing_stop),
      });
    }

    this.market.addInstruments([{ securityId: String(security_id), exchangeSegment: exchange_segment }]);
    return fill;
  }

  private reject(correlationId: string, reason: string): { status: 'REJECTED'; reason: string } {
    eventBus.log('ERROR', `Live order REJECTED for ${correlationId}: ${reason}`, 'live_engine');
    eventBus.emit('order', { kind: 'rejection', correlationId, reason });
    journal.append('order_result', { correlation_id: correlationId, status: 'REJECTED', reason, mode: 'live' });
    this.portfolio?.recordOrderOutcome({ status: 'REJECTED' });
    return { status: 'REJECTED', reason };
  }
}
