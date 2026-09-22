import { DhanClient, OrderTracker, type PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { createDhanClient, createSandboxDhanClient, redisPublisher, redisAvailable } from './auth';
import { initDatabase, listPaperPositions, findMissingOrders, pushAlert } from './db';
import { MarketDataService, toTrailConfig } from './services/marketData';
import { RiskEngine } from './services/riskEngine';
import { AutonomyEngine } from './services/autonomy';
import { AgentOrchestrator } from './services/agent';
import { AdaptiveSupertrendScanner } from './services/adaptiveSupertrendScanner';
import { SelfHealingService } from './services/selfHealing';
import { startTelegramNotifier } from './services/telegramNotifier';
import { eventBus } from './services/eventBus';
import { PaperExecutionEngine } from './engines/paper';
import { LiveExecutionEngine } from './engines/live';
import { SandboxExecutionEngine } from './engines/sandbox';
import { marketClock } from './services/marketHours';
import { hasHolidayCoverage } from './services/holidays';
import { journal, summarizeDay, type JournalEntry } from './services/journal';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { PaperPortfolioSource, BrokerPortfolioSource, type PortfolioSource } from './services/portfolioSource';
import { getSystemState, setSystemState } from './services/systemState';
import { getTradingMode, isLiveMode, isSandboxMode, describeModeContract } from './lib/tradingMode';
import { ResearchOrchestrator } from './services/research/researchOrchestrator';
import { ResearchScheduler } from './services/research/researchScheduler';
import { initResearchRepository } from './services/research/researchRepository';
import { ScalpPositionManager } from './services/scalpPositionManager';
import { ScalpScanner } from './services/scalpScanner';
import { ExpertTradeEngine } from './services/expertTrades/expertTradeEngine';
import { initExpertTradeRepository } from './services/expertTrades/repository';
import { initCandleCache } from './services/expertTrades/candleCache';
import { ExpertTradeScheduler, defaultScheduledScanOptions } from './services/expertTrades/scheduler';

/**
 * Core bootstrap — the autonomous trading stack, shared by every entry
 * point (HTTP server AND headless sidecar). The stack runs free of any
 * frontend: HTTP/WS is just one window onto it.
 */
export interface Core {
  client: DhanClient;
  sandboxClient?: DhanClient;
  portfolio: PortfolioSource;
  market: MarketDataService;
  risk: RiskEngine;
  autonomy: AutonomyEngine;
  agent: AgentOrchestrator;
  research: ResearchOrchestrator;
  researchScheduler?: ResearchScheduler;
  expertTrades: ExpertTradeEngine;
  expertTradeScheduler?: ExpertTradeScheduler;
  paper: PaperExecutionEngine;
  live: LiveExecutionEngine;
  sandbox?: SandboxExecutionEngine;
  tracker: OrderTracker;
  selfHealing: SelfHealingService;
  scalp: ScalpPositionManager;
  scalpScanner?: ScalpScanner;
}

export type ExecutionEngine = PaperExecutionEngine | LiveExecutionEngine | SandboxExecutionEngine;

/** Maps TRADING_MODE to the active execution engine (paper | sandbox | live). */
export function pickExecutionEngine(
  mode: string | undefined,
  engines: Pick<Core, 'paper' | 'live' | 'sandbox'>,
): ExecutionEngine {
  if (mode === 'live') return engines.live;
  if (mode === 'sandbox') {
    if (!engines.sandbox) {
      throw new Error('TRADING_MODE=sandbox but the sandbox engine was not initialized (missing DHAN_SANDBOX_CLIENT_ID/DHAN_SANDBOX_ACCESS_TOKEN?)');
    }
    return engines.sandbox;
  }
  return engines.paper;
}

export function resolveExecutionEngine(core: Core, mode?: string): ExecutionEngine {
  return pickExecutionEngine(mode ?? process.env.TRADING_MODE, core);
}

import { seedStandardStrategies } from './services/strategyConstructor';

export async function startCore(): Promise<Core> {
  // The gap this guard originally existed for is closed: RiskEngine,
  // AutonomyEngine and LiveExecutionEngine all read/act through
  // PortfolioSource now, BrokerPortfolioSource polls the real DhanHQ
  // account, and reconcileUnmanagedLivePositions (autonomy.ts) flattens and
  // halts on any broker position PositionMonitor isn't tracking. Two
  // silent-no-op bugs on the live kill-switch and capital-check paths
  // (wrong SDK method names swallowed by optional chaining) were also found
  // and fixed in the same pass.
  //
  // The guard stays in place anyway, by deliberate choice, not oversight:
  // none of the above has ever run against a real DhanHQ account (this
  // environment has no live credentials) — the reversing-order square-off
  // path, the broker kill switch call, and the assumption that a flattened
  // position still reports realizedProfit in positions.list() are all
  // verified only against the SDK's type declarations and mocks. Lift this
  // only after a supervised first live session (minimum lot size, one
  // index) confirms the kill switch and reconciler actually fire correctly
  // against the real account — not as a standalone code change.
  if (isLiveMode() && process.env.ALLOW_LIVE_TRADING !== 'true') {
    throw new Error(
      'TRADING_MODE=live is deliberately disabled pending confirmation: set ALLOW_LIVE_TRADING=true ' +
      'in .env to confirm live trading with real capital.'
    );
  }
  if (isSandboxMode() && !createSandboxDhanClient()) {
    throw new Error(
      'TRADING_MODE=sandbox requires DHAN_SANDBOX_CLIENT_ID and DHAN_SANDBOX_ACCESS_TOKEN — set them, or use TRADING_MODE=paper.'
    );
  }

  const mode = getTradingMode();

  setSystemState('BOOTING', 'Initializing database and clients');
  await initDatabase();
  const sandboxClient = createSandboxDhanClient();
  const client = await createDhanClient();
  setSystemState('SYNCING', 'Dhan client connected');

  const market = new MarketDataService(client);
  // The ONE place TRADING_MODE picks which account this whole stack reads/
  // acts on — RiskEngine, AutonomyEngine and LiveExecutionEngine all take
  // the SAME instance so there is exactly one broker poll cache and one
  // idea of "the current positions" shared across them, not one each.
  const portfolio: PortfolioSource = isLiveMode()
    ? new BrokerPortfolioSource(client)
    : isSandboxMode() && sandboxClient
      ? new BrokerPortfolioSource(sandboxClient)
      : new PaperPortfolioSource();
  const risk = new RiskEngine(client, market, portfolio);
  const autonomy = new AutonomyEngine(client, market, risk, portfolio);

  // OrderTracker: resolve live orders to fills from order-update WS
  // events (MarketDataService re-emits them on the bus).
  const tracker = new OrderTracker();
  if (isLiveMode()) {
    eventBus.on('order', (env) => {
      if (env.payload?.kind === 'order_update' && env.payload?.order) {
        try { tracker.onOrderUpdate(env.payload.order); } catch { /* defensive */ }
      }
    });
  }

  const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
  const live = new LiveExecutionEngine(client, tracker, market.monitor, market, risk, portfolio);
  // Sandbox client always uses the Real client for market data/WS (Dhan's
  // sandbox has neither) — only order routing goes to the sandbox account.
  const sandbox = sandboxClient ? new SandboxExecutionEngine(sandboxClient, market, risk, client) : undefined;
  const agent = new AgentOrchestrator(client, market, risk, paper, live, sandbox);
  const ollama = process.env.OLLAMA_ENABLED !== 'false'
    ? new OllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', timeoutMs: 15000, retries: 0 })
    : null;
  const research = new ResearchOrchestrator(client, market, undefined, ollama);
  autonomy.setAgent(agent);
  autonomy.setResearch(research);
  const executionEngine = pickExecutionEngine(mode, { paper, live, sandbox });
  autonomy.setScanner(new AdaptiveSupertrendScanner(client, market, executionEngine, risk, undefined, portfolio));

  await initResearchRepository();
  const researchScheduler = new ResearchScheduler(research);
  await researchScheduler.start();

  // NSE Equity Expert Trade Engine — deterministic setup/entry/stop/target
  // pipeline, separate from (and downstream of) the research subsystem's
  // qualitative bias/conviction signal. engine.start() only re-evaluates
  // already-published ideas against live LTP every 60s; finding NEW ideas
  // is the scheduler's job below (a scan can also always be triggered
  // on-demand via POST /api/expert-trades/scan).
  await initExpertTradeRepository();
  await initCandleCache();
  const expertTrades = new ExpertTradeEngine(client, market);
  expertTrades.start();
  const expertTradeScheduler = process.env.EXPERT_TRADE_SCHEDULER_ENABLED !== 'false'
    ? new ExpertTradeScheduler(expertTrades, defaultScheduledScanOptions())
    : undefined;
  await expertTradeScheduler?.start();

  // Bridge core events into Redis pub/sub (Rails sidecar compat) when up.
  if (await redisAvailable()) {
    eventBus.setRedisSink(async (channel, message) => {
      await redisPublisher.publish(channel, message);
    });
  }

  const selfHealing = new SelfHealingService();
  selfHealing.start();
  startTelegramNotifier();

  // Scalp position manager — fee-aware both-side ratchet exit policy.
  // Disabled by default (SCALP_ENABLED=true to enable at boot). Emits
  // real-time state on the 'scalp' EventBus channel for the frontend.
  const scalp = new ScalpPositionManager(market, portfolio);
  if (process.env.SCALP_ENABLED === 'true') {
    scalp.start();
  }
  // Scalp entry scanner — finds momentum setups that pass fee-aware
  // entry gates and registers them with the scalp manager. Same lifecycle
  // as the scalp manager (requires SCALP_ENABLED=true).
  const scalpScanner = process.env.SCALP_ENABLED === 'true'
    ? new ScalpScanner(client, market, executionEngine, risk, scalp)
    : undefined;
  if (scalpScanner) autonomy.setScalpScanner(scalpScanner);

  // The holiday table is hand-maintained per calendar year (see holidays.ts)
  // — running into an uncovered year would silently treat every day as
  // tradeable again, which is exactly the bug this table exists to close.
  // Loud at boot, not a per-cycle log spam source.
  const todayIst = marketClock().istDate;
  if (!hasHolidayCoverage(todayIst)) {
    eventBus.log('ERROR', `No trading-holiday data for ${todayIst.slice(0, 4)} — market-closed days will NOT be detected. Update src/services/holidays.ts.`, 'core');
  }

  // Durable audit trail — order intents/results, risk/kill decisions, EOD
  // square-offs, control commands (journal.ts). Opened before anything can
  // journal to it; a prior boot's entries from the same trading day (a
  // restart) are read back for a diagnostic count, not replayed into state.
  const priorEntries = journal.open(todayIst);
  eventBus.log('SYSTEM', `Journal opened for ${todayIst} (${priorEntries.length} entr${priorEntries.length === 1 ? 'y' : 'ies'} from earlier this session)`, 'core');

  await market.start();
  // risk/autonomy register their exit-signal and evaluation listeners here —
  // must happen BEFORE re-arming any existing position's stop-loss/target
  // below. Ticks start flowing the instant market.start() returns, and an
  // already-breached position can fire its exit signal within the first
  // tick; seedStandardStrategies does slow network calls, so starting these
  // after it (as before) left a real window where a fired exit signal had
  // no listener yet and was silently lost.
  setSystemState('RECONCILING', 'Reconciling ledger and arming positions');
  await risk.start();
  await crossCheckJournalOnBoot(priorEntries, risk, client, sandboxClient);
  await autonomy.start();
  await seedExistingPositions(market, market.monitor, portfolio);
  await seedStandardStrategies(client, market, paper);

  if (getSystemState() === 'RECONCILING') {
    setSystemState('READY', 'Core initialization complete');
  }

  eventBus.emit('system', { type: 'boot', mode });
  eventBus.log('SYSTEM', `Core stack online (mode=${mode}: ${describeModeContract()}) — backend is autonomous; frontend optional`, 'core');

  return { client, sandboxClient, portfolio, market, risk, autonomy, agent, research, researchScheduler, expertTrades, expertTradeScheduler, paper, live, sandbox, tracker, selfHealing, scalp, scalpScanner };
}

/**
 * Cross-checks today's journal against actual state — a restart-time
 * sanity check, not a reconstruction. Only meaningful when priorEntries is
 * non-empty (a restart later the same trading day); on a fresh day's first
 * boot there's nothing yet to check against. Read-only: a mismatch is
 * logged and alerted, never "corrected" from the journal — the journal
 * only covers today and can't tell a legitimate multi-day carry-over
 * position from actual drift, so it must never be treated as more
 * authoritative than the ledger it's checking.
 */
export async function crossCheckJournalOnBoot(
  priorEntries: JournalEntry[], risk: RiskEngine, client: DhanClient, sandboxClient?: DhanClient,
): Promise<void> {
  if (priorEntries.length === 0) return;
  const mode = getTradingMode();
  const summary = summarizeDay(priorEntries, mode);
  const problems: string[] = [];

  if (mode === 'paper') {
    // paper_orders is paper mode's durable record — a TRADED result should
    // have a row there, and so should any intent whose outcome the journal
    // never recorded (executePaperOrder is in-process and synchronous, so
    // this only catches a crash mid-call, not a network round-trip).
    const toCheck = [...summary.tradedCorrelationIds, ...summary.unresolvedIntents];
    const missing = await findMissingOrders(toCheck);
    problems.push(...missing.map((id) => `no matching paper_orders record for ${id}`));
  } else {
    // Live/sandbox: a journaled TRADED result is itself durable (the
    // journal is an fsync'd file) and isn't re-verified against the broker
    // here — that's full reconciliation, deliberately out of scope for this
    // boot check. What DOES need resolving is an order this process placed
    // but died before learning the outcome of — the broker's own order book
    // is the only durable record for those, via GET /orders/external/{id}.
    const lookupClient = mode === 'sandbox' ? sandboxClient : client;
    for (const id of summary.unresolvedIntents) {
      if (!lookupClient) {
        problems.push(`unresolved order ${id} — no ${mode} client available to reconcile`);
        continue;
      }
      try {
        const order: any = await lookupClient.orders.getByCorrelationId(id);
        if (!order?.orderStatus) {
          // Never reached the broker (crash mid-place) — close the journal
          // loop so the day isn't stuck in DEGRADED blocking all new entries.
          journal.append('order_result', {
            correlation_id: id,
            status: 'REJECTED',
            reason: 'orphan_resolved_on_boot: broker has no record',
            mode,
          });
          eventBus.log('WARN', `Boot reconciliation: orphan intent ${id} closed as REJECTED (broker has no record)`, 'core');
        } else {
          eventBus.log('SYSTEM', `Boot reconciliation: order ${id} resolved from broker as ${order.orderStatus}`, 'core');
        }
      } catch (e: any) {
        if (mode === 'sandbox') {
          journal.append('order_result', {
            correlation_id: id,
            status: 'REJECTED',
            reason: `orphan_resolved_on_boot: broker lookup failed (${e.message})`,
            mode,
          });
          eventBus.log('WARN', `Boot reconciliation: orphan intent ${id} closed as REJECTED (${e.message})`, 'core');
        } else {
          problems.push(`unresolved order ${id} — broker lookup failed (${e.message})`);
        }
      }
    }
  }

  if (problems.length > 0) {
    const msg = `Boot cross-check: ${problems.length} unresolved order(s) today — ${problems.join('; ')}`;
    eventBus.log('ERROR', msg, 'core');
    await pushAlert('ERROR', 'core', msg);
    setSystemState('DEGRADED', `Unresolved orders: ${problems.length}`);
  }

  if (summary.lastKillAction === 'arm' && !risk.isKilled()) {
    const msg = "Boot cross-check: journal's last kill-switch action today was ARM, but the risk engine reports NOT killed";
    eventBus.log('WARN', msg, 'core');
    await pushAlert('WARN', 'core', msg);
  } else if (summary.lastKillAction === 'disarm' && risk.isKilled()) {
    const msg = "Boot cross-check: journal's last kill-switch action today was DISARM, but the risk engine reports KILLED";
    eventBus.log('WARN', msg, 'core');
    await pushAlert('WARN', 'core', msg);
  }

  if (problems.length === 0) {
    if (getSystemState() === 'DEGRADED') {
      setSystemState('READY', 'Boot cross-check passed — no unresolved orders');
    }
    if (summary.lastKillAction === null || summary.lastKillAction === (risk.isKilled() ? 'arm' : 'disarm')) {
      eventBus.log('SYSTEM', `Boot cross-check: today's journal (${priorEntries.length} entries) agrees with current state`, 'core');
    }
  }
}

/** Re-subscribes quotes AND re-arms stop-loss/target for positions that
 * were already open before this boot — PositionMonitor's tracked-positions
 * list lives in process memory, so a restart otherwise silently drops SL/
 * target protection on every surviving position until it's manually reset. */
async function seedExistingPositions(market: MarketDataService, monitor: PositionMonitor, portfolio: PortfolioSource): Promise<void> {
  try {
    const positions = await portfolio.getPositions();
    const open = positions.filter((p) => p.netQty !== 0 && p.securityId && p.securityId !== '0');
    const active = open.map((p) => ({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment || 'NSE_FNO' }));
    if (active.length > 0) market.addInstruments(active);

    for (const p of open) {
      if (!p.stopLoss && !p.target && !p.trailingStop) continue;
      monitor.track({
        securityId: String(p.securityId),
        exchangeSegment: p.exchangeSegment || 'NSE_FNO',
        quantity: p.netQty,
        entryPrice: p.netQty > 0 ? p.buyAvg : p.sellAvg,
        stopLoss: p.stopLoss ?? undefined,
        target: p.target ?? undefined,
        trail: toTrailConfig(p.trailingStop),
      });
    }
  } catch { /* non-fatal */ }
}
