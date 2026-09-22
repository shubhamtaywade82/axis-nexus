import { marketClock, istParts } from '../marketHours';
import { sendTelegramMessage, isTelegramEnabled } from '../telegramNotifier';
import { eventBus } from '../eventBus';
import { moduleLogger } from '../../lib/logger';
import { NSE_ALL_EQUITIES_ID } from '../research/universe';
import { listExpertTrades } from './repository';
import type { ExpertTradeEngine, ExpertTradeScanOptions } from './expertTradeEngine';
import type { ExpertTradeScanSummary } from './types';
import type { MarketPhase } from '../research/types';

const log = moduleLogger('expert_trade_scheduler');

export interface ExpertTradeSchedulerStatus {
  enabled: boolean;
  marketPhase: MarketPhase;
  nextScheduledJob: string;
  nextJobTimeIst: string;
  telegramEnabled: boolean;
  openIdeaCount: number;
  lastRunTimes: { postMarketScan?: number; preMarketBrief?: number };
}

/**
 * Drives the Expert Trade Engine's daily rhythm — separate from
 * `ExpertTradeEngine.start()`, which only re-evaluates already-published
 * ideas against live LTP every 60s. This scheduler is what actually finds
 * NEW ideas, on a fixed IST clock, mirroring research/researchScheduler.ts.
 *
 * Two phases, both read-only (never places an order):
 *  - Post-market scan (15:50-16:30 IST): the day's daily candle is settled
 *    by now, so this is when setup detection against daily OHLCV is most
 *    reliable. Runs the full pipeline and publishes tomorrow's candidates.
 *  - Pre-market brief (08:45-09:10 IST): summarizes NEW ideas awaiting an
 *    entry trigger, so nothing published overnight is silently missed.
 */
export class ExpertTradeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private enabled = true;
  private lastDates = { postMarketScan: '', preMarketBrief: '' };
  private lastRunTimestamps: ExpertTradeSchedulerStatus['lastRunTimes'] = {};

  constructor(
    private readonly engine: ExpertTradeEngine,
    private readonly scanOptions: ExpertTradeScanOptions = {},
  ) {}

  async start(): Promise<void> {
    log.info('ExpertTradeScheduler starting — daily scan/brief lifecycle armed');
    setTimeout(() => void this.evaluateCycle(), 2000);
    this.timer = setInterval(() => void this.evaluateCycle(), 60000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async evaluateCycle(): Promise<void> {
    if (!this.enabled) return;
    const clock = marketClock();
    if (!clock.isTradingDay) return;
    const { dateStr } = istParts();

    try {
      // Pre-Market Brief (08:45-09:10 IST) — same window research uses, so
      // an operator watching Telegram gets both briefings back to back.
      if (clock.minutesOfDay >= 525 && clock.minutesOfDay < 550 && this.lastDates.preMarketBrief !== dateStr) {
        this.lastDates.preMarketBrief = dateStr;
        await this.runPreMarketBrief();
      }

      // Post-Market Scan (15:50-16:30 IST) — after the day's daily candle
      // has settled.
      if (clock.minutesOfDay >= 950 && clock.minutesOfDay < 990 && this.lastDates.postMarketScan !== dateStr) {
        this.lastDates.postMarketScan = dateStr;
        await this.runPostMarketScan();
      }
    } catch (e: any) {
      log.error({ err: e.message }, 'Error in ExpertTradeScheduler cycle');
    }
  }

  async runPostMarketScan(): Promise<ExpertTradeScanSummary> {
    log.info('Running scheduled post-market Expert Trade scan');
    this.lastRunTimestamps.postMarketScan = Date.now();
    const summary = await this.engine.scan(this.scanOptions);

    const msg = `📈 *EXPERT TRADE SCAN COMPLETE*\n`
      + `Universe: ${summary.universe} (${summary.totalScreened} screened, ${summary.candidatesConsidered} liquid candidates)\n`
      + `Market regime: ${summary.regime}\n`
      + `Setups detected: ${summary.setupsDetected} | Published: ${summary.published}\n`
      + `Skipped: ${summary.skippedExisting} existing, ${summary.skippedIlliquid} illiquid, ${summary.skippedFetchFailed} fetch failures`;
    await sendTelegramMessage(msg);
    eventBus.log('SYSTEM', msg, 'expert_trade_scheduler');
    return summary;
  }

  async runPreMarketBrief(): Promise<string> {
    log.info('Generating Expert Trade pre-market brief');
    this.lastRunTimestamps.preMarketBrief = Date.now();
    const open = await listExpertTrades({ state: ['NEW'], limit: 50 });
    if (open.length === 0) {
      const msg = 'No open Expert Trade ideas awaiting an entry trigger this morning.';
      eventBus.log('SYSTEM', msg, 'expert_trade_scheduler');
      return msg;
    }

    const lines = [
      '🌅 *EXPERT TRADE PRE-MARKET BRIEF*',
      `${istParts().dateStr} | ${open.length} idea(s) awaiting entry trigger`,
      '',
    ];
    for (const t of open.slice(0, 8)) {
      lines.push(`• *${t.symbol}* (${t.setup.type}, score ${t.setup.score}) — Entry ₹${t.levels.entry.toFixed(2)} · Stop ₹${t.levels.stopLoss.toFixed(2)} · T1 ₹${t.levels.target1.toFixed(2)}`);
    }
    const msg = lines.join('\n');
    await sendTelegramMessage(msg);
    eventBus.log('SYSTEM', msg, 'expert_trade_scheduler');
    return msg;
  }

  async triggerPhase(phase: 'scan' | 'pre_market_brief'): Promise<{ result: ExpertTradeScanSummary | string }> {
    if (phase === 'scan') return { result: await this.runPostMarketScan() };
    return { result: await this.runPreMarketBrief() };
  }

  getStatus(): ExpertTradeSchedulerStatus {
    const clock = marketClock();
    const phase: MarketPhase = clock.isMarketOpen
      ? 'MARKET_HOURS'
      : clock.isPreOpen || (clock.minutesOfDay >= 510 && clock.minutesOfDay < 555)
      ? 'PRE_MARKET'
      : clock.isPostClose && clock.minutesOfDay < 1020
      ? 'POST_MARKET'
      : 'CLOSED';

    const nextJob = clock.minutesOfDay < 525 ? 'Pre-Market Brief (08:45 IST)'
      : clock.minutesOfDay < 950 ? 'Post-Market Scan (15:50 IST)'
      : 'Pre-Market Brief Tomorrow (08:45 IST)';

    return {
      enabled: this.enabled,
      marketPhase: phase,
      nextScheduledJob: nextJob,
      nextJobTimeIst: `${istParts().hours.toString().padStart(2, '0')}:${istParts().minutes.toString().padStart(2, '0')} IST`,
      telegramEnabled: isTelegramEnabled(),
      openIdeaCount: 0, // populated by the route handler, matching researchRoutes' pattern
      lastRunTimes: this.lastRunTimestamps,
    };
  }
}

/** Default scan target for the unattended scheduled job — deliberately
 * more generous than the interactive "Scan Now" default (150 symbols),
 * since there is no one waiting on the response and the whole point of a
 * nightly job is to afford the full universe. Still capped, and still
 * overridable via env, because an unthrottled full-NSE fetch every night
 * is real load on the DhanHQ historical-data endpoint. */
export function defaultScheduledScanOptions(): ExpertTradeScanOptions {
  return {
    universe: process.env.EXPERT_TRADE_SCAN_UNIVERSE || NSE_ALL_EQUITIES_ID,
    exchange: 'NSE',
    maxUniverse: Number(process.env.EXPERT_TRADE_SCAN_MAX_UNIVERSE) || 300,
    maxPublished: Number(process.env.EXPERT_TRADE_SCAN_MAX_PUBLISHED) || 15,
  };
}
