/**
 * NSE/BSE options fee calculator — exact charges per the current Indian
 * exchange fee structure (verified 2024-25).
 *
 * Every scalp must clear these costs to be profitable. This module is the
 * single source of truth for "what does a round-trip actually cost?" —
 * used by the entry gate (don't enter unless expected move > 2× fees),
 * the exit policy (dynamic TP scales with fees), and the UI (show the
 * breakeven line on the chart).
 *
 * Fee structure (per order, per lot):
 *
 *  ┌──────────────────────────────┬────────────────────────────────────┐
 *  │ Charge                       │ Formula                            │
 *  ├──────────────────────────────┼────────────────────────────────────┤
 *  │ Brokerage                    │ ₹20 per order (flat, discount brok)│
 *  │ STT (sell side only)         │ 0.05% of premium × qty             │
 *  │ Exchange txn (NSE F&O)       │ 0.0495% of premium × qty           │
 *  │ Exchange txn (BSE F&O)       │ 0.0375% of premium × qty           │
 *  │ Stamp duty (buy side only)   │ 0.003% of (premium × qty), ≤₹600   │
 *  │ GST                          │ 18% of (brokerage + exchange + SEBI)│
 *  │ SEBI charges                 │ ₹10 per crore of turnover          │
 *  │ IPFT                         │ ₹5 per crore of turnover           │
 *  └──────────────────────────────┴────────────────────────────────────┘
 *
 *  Round-trip = buy + sell = roughly 2× the above minus STT/stamp
 *  (which are one-sided each).
 */

export type ExchangeSegment = 'NSE_FNO' | 'BSE_FNO';

export interface FeeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTransaction: number;
  stampDuty: number;
  gst: number;
  sebi: number;
  ipft: number;
  total: number;
  /** The turnover this was calculated on (premium × qty). */
  turnover: number;
}

export interface RoundTripFees {
  buy: FeeBreakdown;
  sell: FeeBreakdown;
  total: number;
  /** Per-lot cost — divide by qty to get the price impact. */
  perLot: number;
  /** The minimum price move needed to break even (per unit). */
  breakevenPerUnit: number;
  /** Breakeven as a % of the entry premium. */
  breakevenPct: number;
}

// ── Constants (verified Jan 2025) ────────────────────────────────────────

const BROKERAGE_PER_ORDER = 20; // ₹20 flat per order (discount broker)
const STT_RATE_PCT = 0.05; // 0.05% on premium, sell side only
const NSE_FNO_TXN_RATE_PCT = 0.0495; // NSE F&O transaction charge
const BSE_FNO_TXN_RATE_PCT = 0.0375; // BSE F&O transaction charge
const STAMP_DUTY_RATE_PCT = 0.003; // 0.003% on buy side, capped at ₹600
const STAMP_DUTY_CAP = 600;
const GST_RATE_PCT = 18; // 18% on (brokerage + exchange + SEBI + IPFT)
const SEBI_PER_CRORE = 10; // ₹10 per ₹1 crore turnover
const IPFT_PER_CRORE = 5; // ₹5 per ₹1 crore turnover

/** Calculates fees for a single order (one side). */
export function calculateOrderFees(
  premium: number,
  qty: number,
  side: 'BUY' | 'SELL',
  segment: ExchangeSegment = 'NSE_FNO',
): FeeBreakdown {
  const turnover = premium * qty;
  const brokerage = BROKERAGE_PER_ORDER;
  const stt = side === 'SELL' ? (turnover * STT_RATE_PCT) / 100 : 0;
  const txnRate = segment === 'BSE_FNO' ? BSE_FNO_TXN_RATE_PCT : NSE_FNO_TXN_RATE_PCT;
  const exchangeTransaction = (turnover * txnRate) / 100;
  const stampDuty = side === 'BUY'
    ? Math.min((turnover * STAMP_DUTY_RATE_PCT) / 100, STAMP_DUTY_CAP)
    : 0;
  const sebi = (turnover * SEBI_PER_CRORE) / 1_00_00_000; // ₹10 per crore
  const ipft = (turnover * IPFT_PER_CRORE) / 1_00_00_000; // ₹5 per crore
  const gst = ((brokerage + exchangeTransaction + sebi + ipft) * GST_RATE_PCT) / 100;
  const total = brokerage + stt + exchangeTransaction + stampDuty + gst + sebi + ipft;
  return { brokerage, stt, exchangeTransaction, stampDuty, gst, sebi, ipft, total, turnover };
}

/** Calculates the full round-trip cost (buy + sell) for a scalp. */
export function calculateRoundTripFees(
  entryPremium: number,
  exitPremium: number,
  qty: number,
  segment: ExchangeSegment = 'NSE_FNO',
): RoundTripFees {
  const buy = calculateOrderFees(entryPremium, qty, 'BUY', segment);
  const sell = calculateOrderFees(exitPremium, qty, 'SELL', segment);
  const total = buy.total + sell.total;
  const perLot = total / qty;
  // Breakeven per unit = total fees / qty + the spread we cross
  // (entry at ask, exit at bid — but spread is modeled separately in
  // fillModel.ts; here we only compute exchange fees).
  const breakevenPerUnit = perLot;
  const breakevenPct = entryPremium > 0 ? (breakevenPerUnit / entryPremium) * 100 : 0;
  return { buy, sell, total, perLot, breakevenPerUnit, breakevenPct };
}

/** Quick estimate of round-trip fees at entry time (assumes exit ≈ entry).
 *  Used by the entry gate to decide "is this trade worth taking?" */
export function estimateRoundTripFees(
  premium: number,
  qty: number,
  segment: ExchangeSegment = 'NSE_FNO',
): RoundTripFees {
  return calculateRoundTripFees(premium, premium, qty, segment);
}

/** The minimum profit (in ₹) a scalp must capture to be worthwhile.
 *  = round-trip fees + bid-ask spread estimate + safety margin. */
export function minProfitableCapture(
  premium: number,
  qty: number,
  spreadEstimate: number,
  segment: ExchangeSegment = 'NSE_FNO',
  safetyMarginPct = 0.5,
): number {
  const fees = estimateRoundTripFees(premium, qty, segment);
  // Spread cost: cross the spread twice (entry at ask, exit at bid)
  const spreadCost = spreadEstimate * qty * 2;
  const safety = fees.total * safetyMarginPct;
  return fees.total + spreadCost + safety;
}
