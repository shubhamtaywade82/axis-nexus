import { z } from 'zod';

/**
 * Zod schemas for control-plane write routes.
 *
 * These exist because every POST in /api/portfolio/* and /api/control/*
 * previously trusted `req.body` to be the right shape and validated fields
 * ad-hoc with `if (!symbol || !quantity)`-style guards. A malformed payload
 * (missing `securityId`, negative `quantity`, a string where a number was
 * expected) would propagate into the execution engine before being caught
 * — and worse, a `quantity: 0` or `quantity: -5` could slip past a
 * truthiness check.
 *
 * Each schema is deliberately permissive about OPTIONAL fields (an omitted
 * `orderType` defaults to MARKET downstream) and strict about REQUIRED ones.
 * Numbers are coerced where the frontend historically sends strings, but
 * bounded to sane ranges — `quantity` must be a positive integer, `price`
 * must be non-negative, etc.
 *
 * Usage:
 *   const parsed = PaperOrderSchema.safeParse(req.body);
 *   if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
 *   const { symbol, quantity, ... } = parsed.data;
 */

// ── /api/control/* ──────────────────────────────────────────────────────

export const KillSwitchSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
  confirm: z.literal('CONFIRM'),
}).strict();

export const AutonomyToggleSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const ScannerToggleSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const LongOptionPolicySchema = z.object({
  enabled: z.boolean(),
}).strict();

export const SquareOffSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
}).strict().optional();

export const RiskLimitsPatchSchema = z.object({
  dailyLossLimit: z.number().positive().min(1000).optional(),
  maxMarginUtilPct: z.number().min(10).max(100).optional(),
  perStrategyLossLimit: z.number().positive().min(500).optional(),
  maxConsecutiveLosses: z.number().int().positive().min(1).optional(),
  maxRejectionRatePct: z.number().positive().min(1).optional(),
  staleTickSec: z.number().int().min(5).max(120).optional(),
  maxConcurrentStrategies: z.number().int().positive().min(1).optional(),
  maxPortfolioDeltaPct: z.number().positive().optional(),
}).strict().optional();

export const AgentRunSchema = z.object({
  objective: z.string().trim().min(4).max(2000),
}).strict();

export const AlertTestSchema = z.object({
  level: z.enum(['INFO', 'WARN', 'ERROR']).optional().default('INFO'),
  message: z.string().min(1).max(1000).optional().default('Manual test alert'),
}).strict().optional();

// ── /api/portfolio/* ────────────────────────────────────────────────────

export const PaperOrderSchema = z.object({
  symbol: z.string().min(1).max(64),
  quantity: z.number().int().positive(),
  transactionType: z.enum(['BUY', 'SELL']),
  price: z.number().nonnegative().optional().default(0),
  orderType: z.enum(['MARKET', 'LIMIT']).optional().default('MARKET'),
  productType: z.enum(['INTRADAY', 'MARGIN', 'CNC', 'CO']).optional().default('INTRADAY'),
  securityId: z.string().min(1).max(32).optional().default('0'),
  exchangeSegment: z.string().min(1).max(32).optional().default('NSE_FNO'),
}).strict();

export const InstrumentKeySchema = z.object({
  securityId: z.string().min(1).max(32),
  exchangeSegment: z.string().min(1).max(32),
}).strict();

export const ClosePositionSchema = InstrumentKeySchema.extend({
  ltp: z.number().positive().optional(),
  tradingSymbol: z.string().min(1).max(64).optional(),
}).strict();

export const WalletResetSchema = z.object({
  // No default here: resetPaperWallet() applies its own mode-aware default
  // (₹10,00,000 for sandbox, ₹1,00,000 for paper) when this is omitted.
  initialBalance: z.number().positive().min(1000).optional(),
}).strict().optional();

export const StrategyDeploySchema = z.object({
  name: z.string().min(1).max(128),
  symbol: z.string().min(1).max(32),
  type: z.string().min(1).max(64),
  lots: z.number().int().positive().min(1).optional().default(1),
  legs: z.array(z.object({
    instrument: z.string().min(1).max(64),
    securityId: z.string().min(1).max(32).optional(),
    side: z.enum(['BUY', 'SELL']),
    qty: z.number().int().positive(),
    strike: z.number(),
    optionType: z.enum(['CE', 'PE']),
    price: z.number().nonnegative(),
    exchangeSegment: z.string().min(1).max(32).optional().default('NSE_FNO'),
    stopLoss: z.number().positive().optional(),
    target: z.number().positive().optional(),
    trailingStop: z.union([z.number().positive(), z.object({ distance: z.number().positive() }).strict()]).optional(),
  }).passthrough()).min(1).max(20),
}).strict().passthrough();

export const StrategyStatusSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.string().min(1).max(32),
}).strict();

export const StrategyCloseSchema = z.object({
  id: z.string().min(1).max(64),
}).strict();

/** Helper: format the first zod issue as a single user-facing string. */
export function zodError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return 'Invalid request body';
  const path = first.path.length > 0 ? first.path.join('.') : 'body';
  return `${path}: ${first.message}`;
}

// ── WebSocket client→server messages ────────────────────────────────────
//
// The /ws protocol accepts three message types from the client. Previously
// these were parsed with `JSON.parse` + ad-hoc `Array.isArray(msg.channels)`
// checks — a malformed `channels` (e.g. a string instead of an array, or
// unknown channel names) would either crash the handler or silently set the
// subscription set to empty with no feedback to the client. Schemas make
// the protocol explicit and reject unknown shapes with a typed error.

const WS_CHANNELS = ['tick', 'log', 'alert', 'telemetry', 'risk', 'portfolio', 'order', 'system', 'scalp', 'expert_trade'] as const;

export const WsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  // Was max(8) with 9 channels already defined above it (tick..scalp), which
  // would have rejected the frontend's own "subscribe to everything"
  // default; bumped to match the full channel count now that expert_trade
  // is the 10th.
  channels: z.array(z.enum(WS_CHANNELS)).min(1).max(10).optional(),
}).strict();

export const WsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
}).strict();

export const WsPingSchema = z.object({
  type: z.literal('ping'),
}).strict();

/** Discriminated union — parse any inbound WS message in one call. */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  WsSubscribeSchema,
  WsUnsubscribeSchema,
  WsPingSchema,
]);

// ── /api/market/* query params ──────────────────────────────────────────
//
// These are GET query-string params, so the schema parses req.query (an
// object of string|string[] values from Express's qs parser) rather than
// req.body. Coercion handles the string→number conversion that was
// previously done ad-hoc with Number(req.query.days) || 5.

export const OptionsAnalysisQuerySchema = z.object({
  symbol: z.string().min(1).max(32).optional().default('NIFTY'),
  days: z.coerce.number().int().min(1).max(10).optional().default(5),
  interval: z.enum(['1', '5', '15', '30', '60']).optional().default('1'),
  expiryFlag: z.enum(['WEEK', 'MONTH', 'NEXT_WEEK']).optional().default('WEEK'),
  expiryCode: z.coerce.number().int().min(1).max(4).optional().default(1),
}).strict();

export const GreeksQuerySchema = z.object({
  symbol: z.string().min(1).max(32).optional().default('NIFTY'),
  expiry: z.string().min(1).max(32).optional(),
  spot: z.coerce.number().positive().optional(),
}).strict();

export const QuoteQuerySchema = z.object({
  exchange: z.string().min(1).max(32).optional().default('NSE_FNO'),
}).strict();

export const OptionChainQuerySchema = z.object({
  expiry: z.string().min(1).max(32).optional(),
}).strict();


