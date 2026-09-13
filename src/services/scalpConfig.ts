/**
 * Configuration for the scalp exit policy.
 *
 * Tunable via env vars (SCALP_*) or live-tunable via POST /api/scalp/config.
 * The defaults are calibrated for NIFTY ATM options (₹80-200 premium,
 * 75 qty/lot, ~₹130 round-trip cost). Adjust for BANKNIFTY (₹15k+ premium,
 * 30 qty) or SENSEX (₹20k+ premium, 20 qty).
 */

export interface ScalpRatchetTier {
  /** Peak profit / initial risk — the R-multiple that activates this tier. */
  peakR: number;
  /** Trailing SL distance as % of peak price (e.g. 8 = 8% below peak). */
  slTrailPctOfPeak: number;
  /** Locked profit as R-multiple of initial risk (e.g. 0.5 = 50% of risk). */
  floorR: number;
  /** Max giveback from peak (e.g. 0.5 = give back 50% of peak profit). */
  givebackPct: number;
}

export interface ScalpConfig {
  // ── Fee-aware minimum capture ────────────────────────────────────────
  /** Minimum profit per lot to capture (₹). Round-trip fees + spread + margin. */
  minCapturePerLot: number;
  /** Current bid-ask spread estimate per unit × lotSize. */
  spreadBufferPerLot: number;

  // ── Ratchet schedule ─────────────────────────────────────────────────
  /** Both-side ratchet tiers, ordered by peakR ascending. */
  ratchet: ScalpRatchetTier[];

  // ── Dynamic TP ───────────────────────────────────────────────────────
  /** TP = minCapturePerLot × targetMultiplier(momentum). */
  targetMultiplier: { min: number; max: number };

  // ── Underlying-based trailing ────────────────────────────────────────
  /** Trail on underlying spot (true) vs option price (false). */
  useUnderlyingTrail: boolean;
  /** ATR multiple for initial SL (1.5 × ATR(14, 1m) is the default). */
  atrMultiple: number;

  // ── Fee-aware bailout ────────────────────────────────────────────────
  /** Exit if position held this long without movement (ms). */
  maxFlatHoldMs: number;
  /** Must move > this (₹ per lot) to stay in the trade. */
  minMoveToHold: number;

  // ── Entry gates ──────────────────────────────────────────────────────
  /** Don't enter unless delta is in this range (ATM-ish, liquid). */
  deltaGate: { min: number; max: number };
  /** Don't enter if bid-ask spread > this % of mid. */
  maxSpreadPct: number;
  /** Don't enter if IV rank < this (no edge when IV is crushed). */
  minIvRank: number;
  /** Don't enter if option volume today < this. */
  minVolume: number;
  /** Expected move must exceed this multiple of breakeven. */
  minExpectedMoveMultiple: number;
}

export const DEFAULT_SCALP_CONFIG: ScalpConfig = {
  minCapturePerLot: Number(process.env.SCALP_MIN_CAPTURE) || 130,
  spreadBufferPerLot: Number(process.env.SCALP_SPREAD_BUFFER) || 75,

  ratchet: [
    { peakR: 0,   slTrailPctOfPeak: 8.0, floorR: 0,    givebackPct: 1.0 },
    { peakR: 0.5, slTrailPctOfPeak: 7.0, floorR: 0.25, givebackPct: 0.75 },
    { peakR: 1.0, slTrailPctOfPeak: 5.0, floorR: 0.50, givebackPct: 0.50 },
    { peakR: 1.5, slTrailPctOfPeak: 4.0, floorR: 0.70, givebackPct: 0.30 },
    { peakR: 2.0, slTrailPctOfPeak: 3.0, floorR: 0.85, givebackPct: 0.15 },
  ],

  targetMultiplier: {
    min: Number(process.env.SCALP_TP_MIN) || 1.5,
    max: Number(process.env.SCALP_TP_MAX) || 3.0,
  },

  useUnderlyingTrail: process.env.SCALP_TRAIL_UNDERLYING !== 'false',
  atrMultiple: Number(process.env.SCALP_ATR_MULT) || 1.5,

  maxFlatHoldMs: Number(process.env.SCALP_MAX_FLAT_MS) || 5 * 60 * 1000,
  minMoveToHold: Number(process.env.SCALP_MIN_MOVE) || 130,

  deltaGate: {
    min: Number(process.env.SCALP_DELTA_MIN) || 0.45,
    max: Number(process.env.SCALP_DELTA_MAX) || 0.60,
  },
  maxSpreadPct: Number(process.env.SCALP_MAX_SPREAD_PCT) || 2.0,
  minIvRank: Number(process.env.SCALP_MIN_IV_RANK) || 30,
  minVolume: Number(process.env.SCALP_MIN_VOLUME) || 5000,
  minExpectedMoveMultiple: Number(process.env.SCALP_MIN_EXPECTED_MOVE) || 2.0,
};
