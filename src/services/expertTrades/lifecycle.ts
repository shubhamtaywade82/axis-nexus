import type { ExpertTrade } from './types';
import { TERMINAL_STATES } from './types';

/**
 * Pure state-transition function: given a trade and a fresh CMP, returns
 * the trade with `state`/`triggeredAt`/`closedAt`/`lastEvaluated*` updated.
 * No I/O here — the caller (expertTradeEngine.ts) owns persistence and
 * event emission, which keeps this trivially unit-testable.
 *
 * Transition order matters within a single evaluation: a gap-up through
 * both targets in one poll interval resolves straight to TARGET_2 rather
 * than stopping at TARGET_1, and a stop-loss check always precedes a
 * target check once ACTIVE (protecting capital takes priority over
 * recording an upside milestone).
 */
export function evaluateTransition(trade: ExpertTrade, cmp: number, now: number): ExpertTrade {
  const next: ExpertTrade = { ...trade, lastEvaluatedAt: now, lastEvaluatedPrice: cmp };
  if (TERMINAL_STATES.includes(trade.state)) return next;

  const { levels } = trade;

  if (trade.state === 'NEW') {
    if (cmp <= levels.invalidationLevel) {
      return { ...next, state: 'INVALIDATED', closedAt: now };
    }
    if (now > trade.expiresAt) {
      return { ...next, state: 'EXPIRED', closedAt: now };
    }
    if (cmp >= levels.entry) {
      return { ...next, state: 'ACTIVE', triggeredAt: now };
    }
    return next;
  }

  // ACTIVE or TARGET_1 — both are live positions; a stop-loss touch closes
  // either one the same way.
  if (cmp <= levels.stopLoss) {
    return { ...next, state: 'STOPPED', closedAt: now };
  }
  if (cmp >= levels.target2) {
    // target2 > target1 always (levelEngine guarantees it), so a gap
    // straight through both in one poll still counts as a target1 touch —
    // otherwise a gapping winner would silently vanish from the target1
    // hit-rate stat despite having cleared it.
    return { ...next, state: 'TARGET_2', closedAt: now, target1HitAt: trade.target1HitAt ?? now };
  }
  if (trade.state === 'ACTIVE' && cmp >= levels.target1) {
    return { ...next, state: 'TARGET_1', target1HitAt: now };
  }
  // Only an ACTIVE trade that never reached target 1 expires on time; once
  // target 1 is banked the idea has already proven out and is left open
  // for target 2 rather than timed out.
  if (trade.state === 'ACTIVE' && trade.triggeredAt != null) {
    const horizonMaxMs = trade.metrics.expectedHoldingDays.max * 24 * 60 * 60 * 1000;
    if (now - trade.triggeredAt > horizonMaxMs) {
      return { ...next, state: 'EXPIRED', closedAt: now };
    }
  }
  return next;
}
