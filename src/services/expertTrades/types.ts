/**
 * Domain types for the NSE Equity Expert Trade Engine.
 *
 * Distinct from `services/research/types.ts::ResearchTradeSignal`, which
 * carries bias/conviction/horizon as prose (entry conditions, invalidation
 * triggers and structures are all human-readable strings, never numbers).
 * An ExpertTrade is the numeric, executable counterpart: a concrete entry
 * zone, stop-loss and two targets, deterministically derived from price
 * structure and volatility — never invented, never LLM-generated.
 */

export type ExpertTradeSetupType =
  | 'BREAKOUT'
  | 'BREAKOUT_RETEST'
  | 'TREND_PULLBACK'
  | 'BASE_EXPANSION'
  | 'MOMENTUM_CONTINUATION';

export type ExpertTradeHorizon = 'SHORT_TERM' | 'MID_TERM' | 'LONG_TERM';

/**
 * NEW          — published, entry not yet triggered.
 * ACTIVE       — CMP has crossed the entry trigger.
 * TARGET_1     — first target reached (idea stays open for target 2).
 * TARGET_2     — second target reached (terminal).
 * STOPPED      — stop-loss hit (terminal).
 * EXPIRED      — validity window elapsed without triggering, or the
 *                holding horizon elapsed after triggering without an exit.
 * INVALIDATED  — structure broke down before the entry ever triggered
 *                (terminal, distinct from STOPPED which requires a trigger
 *                first).
 */
export type ExpertTradeState =
  | 'NEW'
  | 'ACTIVE'
  | 'TARGET_1'
  | 'TARGET_2'
  | 'STOPPED'
  | 'EXPIRED'
  | 'INVALIDATED';

export const TERMINAL_STATES: ExpertTradeState[] = ['TARGET_2', 'STOPPED', 'EXPIRED', 'INVALIDATED'];
export const OPEN_STATES: ExpertTradeState[] = ['NEW', 'ACTIVE', 'TARGET_1'];

/** A coarse read on the tape (NIFTY trend), used only to shade the
 * composite score — never to gate setup detection outright. */
export type MarketRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

/** Deterministic feature vector computed once per candidate per scan.
 * Every field traces back to real daily OHLCV — nothing here is fitted or
 * learned. `null` means "not enough history", never "assume neutral". */
export interface ExpertTradeFeatures {
  price: number;
  trend: {
    above20: boolean;
    above50: boolean;
    above200: boolean;
    sma200Rising: boolean | null;
  };
  momentum: {
    rsi14: number | null;
    adx14: number | null;
    roc20Pct: number | null;
  };
  volatility: {
    atr14: number | null;
    atrPct: number | null;
  };
  volume: {
    /** Today's volume vs the trailing 20-day average. */
    relativeVolume: number | null;
  };
  structure: {
    resistance20d: number;
    support20d: number;
    swingHigh60d: number;
    swingLow60d: number;
    distanceToResistancePct: number | null;
  };
  relativeStrength: {
    vs60d: number | null;
    vs250d: number | null;
  };
  supertrendDirection: 1 | -1 | null;
}

export interface ExpertTradeLevels {
  current: number;
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2: number;
  /** Below this, the setup is considered structurally broken even though
   * the entry never triggered — distinct from `stopLoss`, which only
   * applies once ACTIVE. */
  invalidationLevel: number;
}

export interface ExpertTradeMetrics {
  riskPerShare: number;
  downsidePct: number;
  target1Pct: number;
  target2Pct: number;
  rr1: number;
  rr2: number;
  /** (target2 - entry) / entry — the headline number, deliberately NOT
   * (current - entry) / entry, which conflates unrealized P&L with the
   * setup's remaining upside. */
  potentialProfitPct: number;
  expectedHoldingDays: { min: number; max: number };
}

export interface ExpertTradeSetup {
  type: ExpertTradeSetupType;
  score: number;
  conviction: number;
}

export interface ExpertTrade {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  securityId: string;
  exchangeSegment: string;
  exchange: 'NSE' | 'BSE';
  direction: 'LONG';
  horizon: ExpertTradeHorizon;
  setup: ExpertTradeSetup;
  market: { regime: MarketRegime };
  levels: ExpertTradeLevels;
  metrics: ExpertTradeMetrics;
  thesis: string[];
  invalidation: string[];
  state: ExpertTradeState;
  createdAt: number;
  /** NEW ideas past this without triggering are EXPIRED. */
  expiresAt: number;
  triggeredAt?: number;
  closedAt?: number;
  lastEvaluatedAt: number;
  lastEvaluatedPrice?: number;
}

export interface ExpertTradeScanSummary {
  scannedAt: number;
  universe: string;
  exchange: 'NSE' | 'BSE';
  regime: MarketRegime;
  totalResolved: number;
  totalScreened: number;
  candidatesConsidered: number;
  setupsDetected: number;
  published: number;
  skippedExisting: number;
  skippedIlliquid: number;
  skippedFetchFailed: number;
  durationMs: number;
}

export interface ExpertTradeListFilter {
  state?: ExpertTradeState[];
  horizon?: ExpertTradeHorizon;
  limit?: number;
}
