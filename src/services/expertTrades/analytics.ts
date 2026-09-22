import type { ExpertTrade, ExpertTradeSetupType } from './types';

/**
 * Outcome statistics over CLOSED (terminal-state) trade ideas — the
 * "researching losers, not just winners" layer from the architecture
 * discussion. Every number here is measured off what actually happened
 * (the price that triggered each transition, via `lastEvaluatedPrice`),
 * never off the idealized entry/target/stop levels — a stop can gap past
 * its price, and treating the two as interchangeable would overstate
 * every loss's precision and understate slippage.
 *
 * `null` means "not enough closed samples yet", exactly like
 * PerformanceMetrics elsewhere in this codebase — never silently zero.
 */

export interface OutcomeStats {
  setupType: ExpertTradeSetupType | 'ALL';
  /** Closed trades whose entry actually triggered — the only ones with a
   * real, measurable P&L. */
  sampleSize: number;
  /** Closed without ever triggering (EXPIRED pre-entry, or INVALIDATED) —
   * reported separately since no capital was ever at risk on these. */
  neverTriggered: number;
  winRate: number | null;
  target1HitRate: number | null;
  target2HitRate: number | null;
  stopRate: number | null;
  /** EXPIRED after triggering (ran out the holding horizon with no exit). */
  expiredRate: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  /** Mean realized return across every triggered trade — the number that
   * actually answers "is this setup worth taking". */
  expectancyPct: number | null;
  medianHoldingDays: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** The realized return for one triggered, closed trade — off the actual
 * price observed at close, not the idealized target/stop level. */
function realizedReturnPct(trade: ExpertTrade): number | null {
  if (trade.triggeredAt == null || trade.lastEvaluatedPrice == null) return null;
  return ((trade.lastEvaluatedPrice - trade.levels.entry) / trade.levels.entry) * 100;
}

function statsFor(setupType: ExpertTradeSetupType | 'ALL', trades: ExpertTrade[]): OutcomeStats {
  const neverTriggered = trades.filter((t) => t.triggeredAt == null);
  const triggered = trades.filter((t) => t.triggeredAt != null);

  const returns = triggered.map(realizedReturnPct).filter((r): r is number => r != null);
  const winners = returns.filter((r) => r > 0);
  const losers = returns.filter((r) => r <= 0);

  const holdingDays = triggered
    .filter((t) => t.closedAt != null)
    .map((t) => (t.closedAt! - t.triggeredAt!) / (24 * 60 * 60 * 1000));

  const rate = (count: number) => (triggered.length > 0 ? count / triggered.length : null);

  return {
    setupType,
    sampleSize: triggered.length,
    neverTriggered: neverTriggered.length,
    winRate: rate(winners.length),
    target1HitRate: rate(triggered.filter((t) => t.target1HitAt != null).length),
    target2HitRate: rate(triggered.filter((t) => t.state === 'TARGET_2').length),
    stopRate: rate(triggered.filter((t) => t.state === 'STOPPED').length),
    expiredRate: rate(triggered.filter((t) => t.state === 'EXPIRED').length),
    avgWinnerPct: mean(winners),
    avgLoserPct: mean(losers),
    expectancyPct: mean(returns),
    medianHoldingDays: median(holdingDays),
  };
}

export function computeOutcomeStats(trades: ExpertTrade[]): { overall: OutcomeStats; bySetup: OutcomeStats[] } {
  const setupTypes = [...new Set(trades.map((t) => t.setup.type))];
  return {
    overall: statsFor('ALL', trades),
    bySetup: setupTypes
      .map((type) => statsFor(type, trades.filter((t) => t.setup.type === type)))
      .sort((a, b) => (b.expectancyPct ?? -Infinity) - (a.expectancyPct ?? -Infinity)),
  };
}
