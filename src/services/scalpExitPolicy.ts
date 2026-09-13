/**
 * Both-side trailing exit policy for options scalping.
 *
 * Core idea: as price moves in your favor, the SL ratchets UP (adverse
 * protection) AND the TP floor ratchets UP (favorable floor). The two
 * converge, so you exit either at the trailing SL or the trailing floor
 * — never giving back more than the ratchet allows.
 *
 * ── Ratchet schedule (R-multiples of initial risk) ─────────────────────
 *
 *   Peak R    SL trail %    Floor (locked)    Giveback
 *   ──────    ──────────    ──────────────    ─────────
 *   0.0R      8.0% of peak  0% (entry)        100%
 *   0.5R      7.0% of peak  25% of peak       75%
 *   1.0R      5.0% of peak  50% of peak       50%
 *   1.5R      4.0% of peak  70% of peak       30%
 *   2.0R+     3.0% of peak  85% of peak       15%
 *
 * As profit grows, SL tightens AND floor rises. By 2R, you lock 85% of
 * peak profit and only allow 15% giveback.
 *
 * ── Why trail on the underlying, not the option price ──────────────────
 *
 * Options have gamma — a 1-point underlying move when ITM produces a
 * different premium change than when ATM. Trailing on option price
 * whipsaws. This policy trails on the UNDERLYING spot, translated to
 * option price via delta, for stable behavior across moneyness.
 */

import type { ScalpConfig } from './scalpConfig';

export type ScalpExitAction =
  | 'HOLD'
  | 'EXIT_SL'           // trailing stop-loss hit
  | 'EXIT_FLOOR'        // giveback limit / profit floor hit
  | 'EXIT_TP'           // dynamic take-profit hit
  | 'EXIT_MOMENTUM'     // underlying momentum reversed
  | 'EXIT_FLAT'         // held too long without movement (fee-aware bailout)
  | 'EXIT_TIME';        // approaching expiry / EOD

export interface ScalpState {
  // Position identity
  positionId: string;
  tradingSymbol: string;
  securityId: string;
  underlying: string;
  side: 'LONG' | 'SHORT';

  // Pricing
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;           // highest since entry (for LONG) / lowest (for SHORT)
  lotSize: number;
  quantity: number;

  // Underlying (for momentum-based trailing)
  underlyingSpot: number;
  underlyingPeak: number;      // peak spot since entry
  underlyingAtr: number;       // 1m ATR of the underlying
  delta: number;               // option delta (abs)

  // Risk
  initialRisk: number;         // |entryPrice - initialSL| per unit
  initialSL: number;
  currentSL: number;           // trailing SL (ratchets up)
  currentFloor: number;        // profit floor (ratchets up)
  currentTP: number;           // dynamic TP (scales with momentum)

  // Timing
  entryTime: number;
  holdMs: number;

  // Ratchet state
  rMultiple: number;           // peakProfit / initialRisk
  activeTier: number;          // index into config.ratchet
  givebackUsed: number;        // how much we've given back from peak

  // Fee context
  feesPerLot: number;          // round-trip fees / qty
  breakevenPrice: number;      // entry + feesPerLot (per unit)
  profitSoFar: number;         // (currentPrice - entryPrice) × qty - fees
  peakProfit: number;          // (peakPrice - entryPrice) × qty - fees

  // Momentum
  momentumReversed: boolean;   // 1m Supertrend flipped against position
  momentumStrength: number;    // 0-1, from ATR + Supertrend confidence
}

export interface ScalpDecision {
  action: ScalpExitAction;
  reason: string;
  exitPrice?: number;
  /** Snapshot of the state at decision time — for UI/logging. */
  stateSnapshot: ScalpState;
}

/**
 * Evaluates the scalp exit policy for a single position.
 *
 * Returns a HOLD decision with the updated trailing levels, or an EXIT
 * decision with the reason. The caller (ScalpPositionManager) is
 * responsible for actually closing the position on EXIT.
 */
export function evaluateScalpExit(
  state: ScalpState,
  config: ScalpConfig,
  now: number,
): ScalpDecision {
  const { entryPrice, currentPrice, peakPrice, initialRisk, momentumReversed, side } = state;

  // For SHORT positions, invert the direction logic
  const isLong = side === 'LONG';
  const profit = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const peakProfit = isLong ? peakPrice - entryPrice : entryPrice - peakPrice;
  const rMultiple = initialRisk > 0 ? peakProfit / initialRisk : 0;

  // Find the active ratchet tier (highest peakR <= current rMultiple)
  const tiers = [...config.ratchet].sort((a, b) => b.peakR - a.peakR);
  const tier = tiers.find((t) => rMultiple >= t.peakR) || config.ratchet[0];
  const activeTier = config.ratchet.indexOf(tier);

  // ── Calculate both-side trailing levels ─────────────────────────────
  //
  // SL trails BELOW the peak (for LONG) / ABOVE the peak (for SHORT).
  // Floor trails BELOW the peak but ABOVE entry (locks profit).
  // Giveback limit = peak - (peakProfit × givebackPct).
  // Effective floor = max(profitFloor, givebackLimit).

  const slTrailDistance = peakPrice * (tier.slTrailPctOfPeak / 100);
  const trailingSL = isLong ? peakPrice - slTrailDistance : peakPrice + slTrailDistance;

  const floorProfit = initialRisk * tier.floorR;
  const profitFloor = isLong ? entryPrice + floorProfit : entryPrice - floorProfit;

  const givebackAmount = peakProfit * tier.givebackPct;
  const givebackLimit = isLong ? peakPrice - givebackAmount : peakPrice + givebackAmount;

  const effectiveFloor = isLong
    ? Math.max(profitFloor, givebackLimit)
    : Math.min(profitFloor, givebackLimit);

  // ── Dynamic TP (momentum-scaled) ────────────────────────────────────
  const momentumStrength = Math.min(1, rMultiple / 2);
  const targetMultiplier = config.targetMultiplier.min +
    (config.targetMultiplier.max - config.targetMultiplier.min) * momentumStrength;
  const targetProfit = config.minCapturePerLot * targetMultiplier;
  const targetPrice = isLong
    ? entryPrice + (targetProfit / state.lotSize)
    : entryPrice - (targetProfit / state.lotSize);

  // Update the state snapshot with computed levels
  const updatedState: ScalpState = {
    ...state,
    currentSL: trailingSL,
    currentFloor: effectiveFloor,
    currentTP: targetPrice,
    rMultiple,
    activeTier,
    givebackUsed: givebackAmount,
    momentumStrength,
    holdMs: now - state.entryTime,
    profitSoFar: profit * state.quantity - state.feesPerLot * state.quantity,
    peakProfit: peakProfit * state.quantity - state.feesPerLot * state.quantity,
  };

  // ── Exit checks (priority order) ────────────────────────────────────

  // Convert per-unit profit to total ₹ profit for fee comparisons.
  // config.minCapturePerLot and minMoveToHold are in ₹ (total per lot),
  // not per-unit — so multiply profit by quantity.
  const totalProfit = profit * state.quantity;

  // 1. HARD STOP — trailing SL hit
  if (isLong ? currentPrice <= trailingSL : currentPrice >= trailingSL) {
    return {
      action: 'EXIT_SL',
      reason: `Trailing SL hit at ₹${trailingSL.toFixed(2)} (tier ${activeTier}: ${tier.peakR}R)`,
      exitPrice: currentPrice,
      stateSnapshot: updatedState,
    };
  }

  // 2. FLOOR EXIT — giveback limit / profit floor hit (only if in profit)
  if (profit > 0 && (isLong ? currentPrice <= effectiveFloor : currentPrice >= effectiveFloor)) {
    const lockedR = tier.floorR;
    return {
      action: 'EXIT_FLOOR',
      reason: `Floor exit at ₹${effectiveFloor.toFixed(2)} (locked ${lockedR}R, gave back ${(tier.givebackPct * 100).toFixed(0)}%)`,
      exitPrice: currentPrice,
      stateSnapshot: updatedState,
    };
  }

  // 3. MOMENTUM REVERSAL — 1m Supertrend flipped against position
  if (momentumReversed && totalProfit > config.minCapturePerLot) {
    return {
      action: 'EXIT_MOMENTUM',
      reason: `Underlying momentum reversed (1m Supertrend flip) — exit with profit ₹${totalProfit.toFixed(0)}`,
      exitPrice: currentPrice,
      stateSnapshot: updatedState,
    };
  }

  // 4. FEE-AWARE BAILOUT — held too long without movement
  const holdMs = now - state.entryTime;
  if (holdMs > config.maxFlatHoldMs && totalProfit < config.minMoveToHold) {
    return {
      action: 'EXIT_FLAT',
      reason: `Held ${Math.round(holdMs / 1000)}s without exceeding fees (profit ₹${totalProfit.toFixed(0)} < ₹${config.minMoveToHold}) — bailout`,
      exitPrice: currentPrice,
      stateSnapshot: updatedState,
    };
  }

  // 5. TP — dynamic target hit
  if (isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice) {
    return {
      action: 'EXIT_TP',
      reason: `TP hit at ₹${targetPrice.toFixed(2)} (${targetMultiplier.toFixed(1)}× fees)`,
      exitPrice: currentPrice,
      stateSnapshot: updatedState,
    };
  }

  // 6. TIME EXIT — approaching expiry (handled by caller, not here)
  // (The autonomy engine's EOD square-off at 15:20 IST covers this.)

  return {
    action: 'HOLD',
    reason: `${rMultiple.toFixed(2)}R peak | SL ₹${trailingSL.toFixed(2)} | floor ₹${effectiveFloor.toFixed(2)} | TP ₹${targetPrice.toFixed(2)} | tier ${activeTier}`,
    stateSnapshot: updatedState,
  };
}
