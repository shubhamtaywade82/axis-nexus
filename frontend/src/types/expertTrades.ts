/** Mirrors src/services/expertTrades/types.ts on the backend — the numeric,
 * executable trade-idea contract (entry/stop/target/R:R), distinct from the
 * prose-only ResearchTradeSignal used elsewhere in the research console. */

export type ExpertTradeSetupType =
  | 'BREAKOUT'
  | 'BREAKOUT_RETEST'
  | 'TREND_PULLBACK'
  | 'BASE_EXPANSION'
  | 'MOMENTUM_CONTINUATION';

export type ExpertTradeHorizon = 'SHORT_TERM' | 'MID_TERM' | 'LONG_TERM';

export type ExpertTradeState =
  | 'NEW'
  | 'ACTIVE'
  | 'TARGET_1'
  | 'TARGET_2'
  | 'STOPPED'
  | 'EXPIRED'
  | 'INVALIDATED';

export type MarketRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export interface ExpertTradeLevels {
  current: number;
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2: number;
  invalidationLevel: number;
}

export interface ExpertTradeMetrics {
  riskPerShare: number;
  downsidePct: number;
  target1Pct: number;
  target2Pct: number;
  rr1: number;
  rr2: number;
  potentialProfitPct: number;
  expectedHoldingDays: { min: number; max: number };
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
  setup: { type: ExpertTradeSetupType; score: number; conviction: number };
  market: { regime: MarketRegime };
  levels: ExpertTradeLevels;
  metrics: ExpertTradeMetrics;
  thesis: string[];
  invalidation: string[];
  state: ExpertTradeState;
  createdAt: number;
  expiresAt: number;
  triggeredAt?: number;
  closedAt?: number;
  lastEvaluatedAt: number;
  lastEvaluatedPrice?: number;
}

export interface OutcomeStats {
  setupType: ExpertTradeSetupType | 'ALL';
  sampleSize: number;
  neverTriggered: number;
  winRate: number | null;
  target1HitRate: number | null;
  target2HitRate: number | null;
  stopRate: number | null;
  expiredRate: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  expectancyPct: number | null;
  medianHoldingDays: number | null;
}

export interface ExpertTradeStatsResponse {
  computedAt: number;
  overall: OutcomeStats;
  bySetup: OutcomeStats[];
}

export interface ExpertTradeSchedulerStatus {
  enabled: boolean;
  marketPhase: 'PRE_MARKET' | 'MARKET_HOURS' | 'POST_MARKET' | 'CLOSED';
  nextScheduledJob: string;
  nextJobTimeIst: string;
  telegramEnabled: boolean;
  openIdeaCount: number;
  lastRunTimes: { postMarketScan?: number; preMarketBrief?: number };
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
