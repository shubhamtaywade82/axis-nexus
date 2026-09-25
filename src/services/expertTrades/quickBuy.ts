import type { RiskEngine } from '../riskEngine';
import type { PortfolioSource } from '../portfolioSource';
import type { PaperExecutionEngine } from '../../engines/paper';
import { updateExpertTrade } from './repository';
import type { ExpertTrade, ExpertTradeState, QuickBuyPreview, QuickBuyResult } from './types';

/**
 * Risk-based position sizing for Quick Buy: quantity = a fixed rupee risk
 * budget per idea, divided by the setup's own risk-per-share (entry minus
 * stop-loss) — a wide-stop setup gets fewer shares, a tight-stop setup
 * gets more, but the rupee loss on a stop-out is the same either way.
 *
 * Deliberately a NEW, separate constant from RiskEngine's
 * `perStrategyLossLimit` (₹20,000 default): that caps one whole options
 * strategy's loss, not a single equity idea's. Nothing here invents a
 * number pretending to be more considered than it is — it is exactly this
 * one fixed rupee figure, overridable via env for a different risk
 * appetite, never derived from account equity or anything else.
 */
export const DEFAULT_RISK_PER_TRADE_INR = Number(process.env.EXPERT_TRADE_RISK_PER_TRADE_INR) || 5000;

/** Quick Buy only makes sense before the setup has already run past its
 * first target — TARGET_1 onward is a materially worse entry than what the
 * setup was scored on. */
const BUYABLE_STATES: ExpertTradeState[] = ['NEW', 'ACTIVE'];

export function computeQuickBuyQuantity(entry: number, stopLoss: number, riskPerTradeInr: number): number {
  const riskPerShare = entry - stopLoss;
  if (!(riskPerShare > 0)) return 0;
  return Math.floor(riskPerTradeInr / riskPerShare);
}

function ineligibleReason(trade: ExpertTrade, quantity: number): string | undefined {
  if (trade.execution) return `Already bought (order ${trade.execution.correlationId})`;
  if (!BUYABLE_STATES.includes(trade.state)) {
    return `Quick Buy is only available for NEW or ACTIVE ideas — this one is ${trade.state}`;
  }
  if (quantity <= 0) return "Risk-per-trade too small for this setup's stop distance — quantity rounds to zero";
  return undefined;
}

export async function buildQuickBuyPreview(
  trade: ExpertTrade,
  risk: RiskEngine,
  portfolio: PortfolioSource,
  riskPerTradeInr: number = DEFAULT_RISK_PER_TRADE_INR,
): Promise<QuickBuyPreview> {
  const quantity = computeQuickBuyQuantity(trade.levels.entry, trade.levels.stopLoss, riskPerTradeInr);
  const capitalRequired = quantity * trade.levels.entry;
  const wallet = await portfolio.getWallet();
  const riskGate = risk.canTrade();
  const reason = ineligibleReason(trade, quantity);

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    eligible: reason == null,
    ineligibleReason: reason,
    quantity,
    riskPerTradeInr,
    entry: trade.levels.entry,
    stopLoss: trade.levels.stopLoss,
    target1: trade.levels.target1,
    target2: trade.levels.target2,
    capitalRequired,
    maxLossInr: quantity * (trade.levels.entry - trade.levels.stopLoss),
    target1ProfitInr: quantity * (trade.levels.target1 - trade.levels.entry),
    target2ProfitInr: quantity * (trade.levels.target2 - trade.levels.entry),
    availableMargin: wallet.availableMargin,
    affordable: wallet.availableMargin >= capitalRequired,
    riskGate,
  };
}

/**
 * Places a real (paper-mode) CNC equity BUY sized by risk, and lets
 * `PaperExecutionEngine` wire the stop-loss/target into the SDK's
 * `PositionMonitor` via `risk_limits` — `AutonomyEngine` (already running,
 * core.ts) closes the position automatically when either level is hit, so
 * this function does not track or poll anything itself after the fill.
 *
 * v1 simplification, documented rather than hidden: `PositionMonitor`
 * supports one exit target, not a two-stage scale-out, so this exits the
 * FULL position at target1 (the target the level engine's own R:R floor
 * was checked against) or at the stop-loss, whichever comes first — target2
 * is not reachable via Quick Buy today. Always routes through the paper
 * engine regardless of the deployment's TRADING_MODE: this is the first
 * order-placing surface in the Expert Trade Engine and stays paper-only
 * until it has been proven out — not a limitation of the underlying
 * execution engines, which already support live/sandbox equally.
 */
export async function executeQuickBuy(
  trade: ExpertTrade,
  paper: PaperExecutionEngine,
  riskPerTradeInr: number = DEFAULT_RISK_PER_TRADE_INR,
): Promise<QuickBuyResult> {
  const quantity = computeQuickBuyQuantity(trade.levels.entry, trade.levels.stopLoss, riskPerTradeInr);
  const reason = ineligibleReason(trade, quantity);
  if (reason) return { status: 'REJECTED', reason };

  const correlationId = `xtqb_${Date.now().toString(36)}_${trade.symbol.toLowerCase()}`.slice(0, 25);
  const result = await paper.placeOrder({
    correlation_id: correlationId,
    intent_id: `expert_trade_quick_buy_${trade.id}`,
    params: {
      security_id: trade.securityId,
      symbol: trade.symbol,
      quantity,
      transaction_type: 'BUY',
      order_type: 'MARKET',
      exchange_segment: trade.exchangeSegment,
      product_type: 'CNC',
      price: 0,
    },
    risk_limits: {
      stop_loss: trade.levels.stopLoss,
      target: trade.levels.target1,
    },
  });

  if (result.status !== 'TRADED') {
    return { status: 'REJECTED', reason: result.reason || 'Order rejected' };
  }

  await updateExpertTrade({
    ...trade,
    execution: {
      status: 'PLACED',
      correlationId,
      quantity,
      fillPrice: result.fill_price,
      placedAt: Date.now(),
      mode: 'paper',
    },
  });

  return { status: 'TRADED', correlationId, quantity, fillPrice: result.fill_price };
}
