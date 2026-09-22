import { RiskEngine, DEFAULT_RISK_LIMITS } from '../services/riskEngine';
import { getSystemState, setSystemState } from '../services/systemState';
import { MarketDataService } from '../services/marketData';
import { AgentOrchestrator, readOllamaCloudKeys } from '../services/agent';
import { PaperExecutionEngine } from '../engines/paper';
import { LiveExecutionEngine } from '../engines/live';
import { eventBus } from '../services/eventBus';
import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { EventEmitter } from 'events';
import * as marketHours from '../services/marketHours';
import {
  initDatabase, dbMode, executePaperOrder, getPaperWallet,
  listPaperPositions, closeAllPaperPositions, markPositionsToMarket,
  resetPaperWallet, pool, saveRiskState, reconcileLedger, findMissingOrders,
  closePaperPosition, createPaperStrategy, adjustWalletMargin,
} from '../db';

/**
 * Service-level tests. They run in-memory (no PostgreSQL in CI) and use a
 * stub DhanClient — they verify the SYSTEM's behavior (pricing rules,
 * risk gates, kill switch, mark-to-market), not the broker.
 */

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function stubMarket(ltp: number | null = 100): MarketDataService {
  const svc = new MarketDataService(stubClient());
  (svc as any).lastTickAt = Date.now();
  // Inject a live-ish quote without hitting the network.
  (svc as any).quotes.set('44000', {
    securityId: '44000', symbol: undefined, ltp: ltp ?? 100,
    change: 0, pctChange: 0, high: 101, low: 99, open: 100, prevClose: 100,
    volume: 0, oi: 0, updatedAt: Date.now(),
  });
  return svc;
}

async function stubEngines(ltp: number | null = 100) {
  const client = stubClient();
  const market = stubMarket(ltp);
  const risk = new RiskEngine(client, market);
  await risk.start();
  // Hermetic mock: decouple pricing and execution tests from the host's wall-clock EOD window
  jest.spyOn(risk, 'canTrade').mockImplementation(() =>
    risk.isKilled() ? { allowed: false, reason: 'Kill switch engaged' } : { allowed: true }
  );
  const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
  const live = new LiveExecutionEngine(client, (client as any).tracker ?? ({} as any), market.monitor, market, risk);
  const agent = new AgentOrchestrator(client, market, risk, paper, live);
  return { client, market, risk, paper, live, agent };
}

describe('Paper execution engine — real-LTP pricing policy', () => {
  beforeAll(async () => { await initDatabase(); });

  it('REJECTS a market order when no live LTP exists (never fills at a made-up price)', async () => {
    const { paper } = await stubEngines(null); // no quote for this instrument
    const result = await paper.placeOrder({
      correlation_id: 'test_no_ltp',
      intent_id: 'i1',
      params: { security_id: '99999', quantity: 50, transaction_type: 'BUY', order_type: 'MARKET' },
    });
    expect(result.status).toBe('REJECTED');
    expect(String(result.reason)).toMatch(/no live LTP/i);
  });

  it('fills at the live LTP with adverse slippage, not at params.price', async () => {
    // getFillablePrice refuses to consider ANY quote fillable outside market
    // hours (DATA-01 fix) — pin the clock to a known IST market-open moment
    // so this test verifies pricing behavior, not whatever time it happens
    // to run at.
    // Fake Date only — placeOrder/risk.start() rely on real setTimeout/setInterval
    // internally, and jest's default fake-timer mode freezes those too, hanging
    // the test until it times out.
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { paper } = await stubEngines(100);
      const result: any = await paper.placeOrder({
        correlation_id: 'test_ltp_fill',
        intent_id: 'i2',
        params: { security_id: '44000', quantity: 50, transaction_type: 'BUY', order_type: 'MARKET', price: 555 },
      });
      expect(result.status).toBe('TRADED');
      // BUY slippage = premium-scaled half-spread over the live LTP of 100
      // (100 falls in the <300 bracket: half-spread 0.50), NOT price 555.
      expect(result.fill_price).toBeCloseTo(100.5, 2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a non-positive or non-integer quantity', async () => {
    const { paper } = await stubEngines(100);
    for (const quantity of [-50, 0, 1.5]) {
      const result: any = await paper.placeOrder({
        correlation_id: `test_bad_qty_${quantity}`,
        intent_id: 'i_bad_qty',
        params: { security_id: '44000', quantity, transaction_type: 'BUY', order_type: 'MARKET' },
      });
      expect(result.status).toBe('REJECTED');
    }
  });

  it('re-arms PositionMonitor against the NET position, not the latest order (add-to fill)', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { paper, market } = await stubEngines(100);
      // Distinct symbol so this test's position isn't polluted by another
      // test in this file that also fills security '44000' under the
      // default SEC_44000 symbol — netQty is keyed by symbol, not securityId.
      await paper.placeOrder({
        correlation_id: 'test_addto_1', intent_id: 'i3',
        params: { security_id: '44000', symbol: 'ADDTOTEST', quantity: 50, transaction_type: 'BUY', order_type: 'MARKET' },
        risk_limits: { stop_loss: 90 },
      });
      await paper.placeOrder({
        correlation_id: 'test_addto_2', intent_id: 'i3',
        params: { security_id: '44000', symbol: 'ADDTOTEST', quantity: 30, transaction_type: 'BUY', order_type: 'MARKET' },
        risk_limits: { stop_loss: 90 },
      });
      const tracked = market.monitor.tracked().find((p: any) => p.securityId === '44000');
      expect(tracked?.quantity).toBe(80); // net of both fills, not just the second order's 30
    } finally {
      jest.useRealTimers();
    }
  });

  it('REJECTS orders while the kill switch is engaged', async () => {
    const { paper, risk } = await stubEngines(100);
    await risk.armKillSwitch('test kill');
    const result = await paper.placeOrder({
      correlation_id: 'test_killed',
      intent_id: 'i3',
      params: { security_id: '44000', quantity: 50, transaction_type: 'BUY' },
    });
    expect(result.status).toBe('REJECTED');
    expect(String(result.reason)).toMatch(/kill switch/i);
    await risk.disarmKillSwitch();
  });
});

describe('Money-path math — fees, margin, sign flips', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(100000); });
  afterAll(async () => { await resetPaperWallet(100000); });

  it('charges brokerage+stampDuty+exchange+GST on a BUY, brokerage+STT+exchange+GST on a SELL', async () => {
    const buy = await executePaperOrder({ symbol: 'FEETEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    // turnover 5000: brokerage 20 + stampDuty 0.15 + exchange 2.5 + sebiFee ~0 + GST 18% of (20+2.5) = 4.05
    expect((buy as any).charges).toBeCloseTo(26.70, 2);

    const sell = await executePaperOrder({ symbol: 'FEETEST2', securityId: '44001', quantity: 50, transactionType: 'SELL', price: 100 });
    // turnover 5000: brokerage 20 + STT 5.00 + exchange 2.5 + sebiFee ~0 + GST 4.05, no stamp duty
    expect((sell as any).charges).toBeCloseTo(31.55, 2);
  });

  it('blocks full premium on a long open, the resolver-provided multiple on a short open', async () => {
    await executePaperOrder({ symbol: 'MARGINLONG', securityId: '44000', quantity: 10, transactionType: 'BUY', price: 100 });
    const wLong = await getPaperWallet();
    expect(wLong.usedMargin).toBeCloseTo(1000, 2); // full premium, no leverage

    await resetPaperWallet(100000);
    await executePaperOrder({ symbol: 'MARGINSHORT', securityId: '44001', quantity: 10, transactionType: 'SELL', price: 100 });
    const wShort = await getPaperWallet();
    expect(wShort.usedMargin).toBeCloseTo(10000, 2); // defaultMarginResolver's 10x fallback multiple
  });

  it('usedMargin self-heals from position margin_blocked even when a hedge-credit reversal is missed — the exact ₹134K live drift', async () => {
    // Regression, found live via a direct DB query: paper_wallet.used_margin
    // had drifted ₹134,062 negative vs. SUM(margin_blocked) on real open
    // positions. Root cause traced: a multi-leg deploy applies a hedge-
    // margin credit via adjustWalletMargin() (combined SPAN needs less than
    // the sum of each leg's standalone margin), which is supposed to be
    // reversed exactly once when the strategy's LAST leg closes
    // (updatePaperStrategyStatus('STOPPED') in db.ts) — but the trigger for
    // that (autonomy.ts's closeParentStrategyIfFlat) is a plain string match
    // on tradingSymbol that can silently miss. This test reproduces the
    // missed-reversal case directly (deploy two legs, apply a credit,
    // close both legs, never call updatePaperStrategyStatus) and asserts
    // getPaperWallet() is still correct anyway — because it's now derived
    // from position rows, not the incrementally-tracked wallet column.
    await executePaperOrder({ symbol: 'HEDGELEG1', securityId: '44000', quantity: 10, transactionType: 'SELL', price: 100 });
    await executePaperOrder({ symbol: 'HEDGELEG2', securityId: '44001', quantity: 10, transactionType: 'SELL', price: 100 });
    const usedBeforeCredit = (await getPaperWallet()).usedMargin;
    expect(usedBeforeCredit).toBeCloseTo(20000, 2); // 2 × 10x fallback margin, standalone

    // Combined margin is less than the standalone sum — release the credit
    // and register the strategy as RUNNING with it, same as a real multi-leg
    // deploy does (routes/portfolio.ts: adjustWalletMargin then
    // createPaperStrategy with marginHedgeCredit).
    const hedgeCredit = 8000;
    await adjustWalletMargin(hedgeCredit);
    await createPaperStrategy({
      id: 'hedge_test_strat', name: 'Hedge Test', symbol: 'HEDGE', type: 'STRANGLE', lots: 1,
      legs: [{ instrument: 'HEDGELEG1' }, { instrument: 'HEDGELEG2' }], marginHedgeCredit: hedgeCredit,
    });
    expect((await getPaperWallet()).usedMargin).toBeCloseTo(12000, 2); // 20000 standalone - 8000 credit, while RUNNING

    // Close BOTH legs — deliberately WITHOUT calling
    // updatePaperStrategyStatus('STOPPED') to reverse the credit, simulating
    // the missed-reversal bug exactly.
    await closePaperPosition('HEDGELEG1', 100);
    await closePaperPosition('HEDGELEG2', 100);

    // Old behavior: usedMargin would read -8000 (permanently drifted) here.
    const wallet = await getPaperWallet();
    expect(wallet.usedMargin).toBe(0); // both positions flat — derived from margin_blocked, immune to the missed reversal
    expect(wallet.availableMargin).toBeCloseTo(100000 + wallet.realizedPnl - wallet.totalCharges, 2);
  });

  it('handles a same-fill sign flip (long to short) with correct realized PnL and resulting side', async () => {
    await executePaperOrder({ symbol: 'FLIPTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'FLIPTEST', securityId: '44000', quantity: 80, transactionType: 'SELL', price: 110 });
    const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'FLIPTEST');
    expect(pos?.netQty).toBe(-30); // 50 long closed, 30 short opened in the same fill
    expect(pos?.sellAvg).toBeCloseTo(110, 2);
    const w = await getPaperWallet();
    expect(w.realizedPnl).toBeCloseTo(500, 2); // (110-100)*50 on the closed portion only
  });

  it('rejects a non-marketable LIMIT order instead of filling at an arbitrary price', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { paper } = await stubEngines(100); // live LTP = 100
      const notMarketable = await paper.placeOrder({
        correlation_id: 'test_limit_bad', intent_id: 'i_limit',
        params: { security_id: '44000', quantity: 50, transaction_type: 'BUY', order_type: 'LIMIT', price: 90 }, // BUY limit below LTP
      });
      expect(notMarketable.status).toBe('REJECTED');

      const marketable = await paper.placeOrder({
        correlation_id: 'test_limit_ok', intent_id: 'i_limit',
        params: { security_id: '44000', quantity: 50, transaction_type: 'BUY', order_type: 'LIMIT', price: 105 }, // BUY limit above LTP — marketable
      });
      expect(marketable.status).toBe('TRADED');
      expect((marketable as any).fill_price).toBeLessThanOrEqual(100.5); // filled at the better of {LTP, limit} + slippage, not at 105
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RiskEngine — real-state circuit breakers', () => {
  beforeAll(async () => { await initDatabase(); });

  it('computes breakers from the real wallet and positions', async () => {
    const { risk } = await stubEngines(100);
    const rows = await risk.evaluate();
    const rules = rows.map((r) => r.rule);
    expect(rules).toContain('Daily Loss Limit');
    expect(rules).toContain('Margin Utilization');
    expect(rules).toContain('Stale Market Tick');
    // A fresh wallet is far from the daily loss limit.
    const daily = rows.find((r) => r.rule === 'Daily Loss Limit')!;
    expect(daily.state).toBe('OK');
  });

  it('canTrade() refuses new entries while the system is not READY, independent of the kill switch/EOD checks', async () => {
    // A fresh, un-mocked RiskEngine — stubEngines() mocks canTrade() for
    // every OTHER test in this file to decouple them from wall-clock
    // EOD/kill-switch state, which would also hide this gate.
    const risk = new RiskEngine(stubClient(), stubMarket(100));
    const priorState = getSystemState();
    try {
      setSystemState('DEGRADED', 'test');
      const gate = risk.canTrade();
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/not ready/i);
    } finally {
      setSystemState(priorState);
    }
  });

  it('arms the kill switch when the daily loss limit is breached', async () => {
    const { risk } = await stubEngines(100);
    await risk.setLimits({ dailyLossLimit: 1 }); // trivially breachable
    // Create a realized loss directly through the paper DB layer.
    await executePaperOrder({ symbol: 'RISKTEST', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'RISKTEST', quantity: 50, transactionType: 'SELL', price: 90 }); // -500 realized
    await risk.evaluate();
    expect(risk.isKilled()).toBe(true);
    const snap = risk.snapshot();
    expect(snap.killed).toBe(true);
    expect(String(snap.killedReason)).toMatch(/daily loss limit/i);
    await risk.disarmKillSwitch();
    risk.stop();
  });

  it('persists limits so a restart keeps configuration', async () => {
    const { risk } = await stubEngines(100);
    await risk.setLimits({ maxMarginUtilPct: 42 });
    const risk2 = new RiskEngine(stubClient(), stubMarket(100));
    await risk2.start();
    expect(risk2.getLimits().maxMarginUtilPct).toBe(42);
    risk.stop();
    risk2.stop();
  });

  it('defaults are sane', () => {
    expect(DEFAULT_RISK_LIMITS.dailyLossLimit).toBeGreaterThan(0);
    expect(DEFAULT_RISK_LIMITS.maxConsecutiveLosses).toBeGreaterThan(0);
  });

  it('Portfolio Net Delta: does not block a single reasonable options position, but still catches real concentration', async () => {
    // Regression test: the breaker measures option delta-NOTIONAL (the
    // underlying's equivalent exposure) as a % of equity — inherently a
    // triple/quadruple-digit number for any real options position, since
    // that's what leverage means. The old default (150%) made a single
    // NIFTY ATM lot (65 qty × ~0.5Δ × ~24000 spot ≈ 780% of the ₹100,000
    // default paper wallet) read ERROR — and canTrade() blocks on ERROR —
    // so the very first fill locked out every subsequent order.
    const client = stubClient();
    const market = stubMarket(100);
    (market as any).lastTickAt = Date.now();
    (market as any).quotes.set('13', { // NIFTY index securityId
      securityId: '13', symbol: 'NIFTY', ltp: 24000, change: 0, pctChange: 0,
      high: 24100, low: 23900, open: 24000, prevClose: 24000, volume: 0, oi: 0, updatedAt: Date.now(),
    });
    const risk = new RiskEngine(client, market);
    await risk.start();
    await resetPaperWallet(100000);

    await executePaperOrder({ symbol: 'NIFTY24000CE', securityId: '55501', quantity: 65, transactionType: 'BUY', price: 100 });
    const rowsOneLot = await risk.evaluate();
    const oneLot = rowsOneLot.find((r) => r.rule === 'Portfolio Net Delta')!;
    expect(oneLot.state).not.toBe('ERROR');
    expect(risk.canTrade().allowed).toBe(true);

    // A clearly excessive same-direction pile-up must still trip it.
    await executePaperOrder({ symbol: 'NIFTY24000CE', securityId: '55501', quantity: 65 * 5, transactionType: 'BUY', price: 100 });
    const rowsPiled = await risk.evaluate();
    const piled = rowsPiled.find((r) => r.rule === 'Portfolio Net Delta')!;
    expect(piled.state).toBe('ERROR');

    await closePaperPosition('NIFTY24000CE');
    risk.stop();
  });

  it('Margin Utilization & Affordability: blocks orders exceeding available balance and trips at 70% threshold', async () => {
    await saveRiskState({ killed: false, killedReason: null, killedDate: null, limits: { ...DEFAULT_RISK_LIMITS } });
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    await resetPaperWallet(100000);

    // 1. Attempting to place an order needing more margin than available throws Insufficient margin
    await expect(
      executePaperOrder({ symbol: 'OVERMARGIN', quantity: 2000, transactionType: 'BUY', price: 100 })
    ).rejects.toThrow(/Insufficient margin/i);

    // 2. Used margin exceeding 70% limit trips breaker to ERROR and blocks canTrade()
    await executePaperOrder({ symbol: 'MARGIN75', quantity: 750, transactionType: 'BUY', price: 100 });
    const rows = await risk.evaluate();
    const marginRow = rows.find((r) => r.rule === 'Margin Utilization')!;
    expect(marginRow.state).toBe('ERROR');
    expect(risk.canTrade().allowed).toBe(false);
    expect(risk.canTrade().reason).toMatch(/Margin Utilization breached/i);

    // 3. Asymmetric close rule: position closure is allowed even during 70%+ utilization
    await expect(closePaperPosition('MARGIN75', 100)).resolves.toBeDefined();

    risk.stop();
  });

  it('Stale Market Tick: uses tiered WARN vs ERROR and does not block canTrade on WARN', async () => {
    // The rule only fires while the market is open, so without a pinned clock
    // this passes during trading hours and fails every evening.
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    await saveRiskState({ killed: false, killedReason: null, killedDate: null, limits: { staleTickSec: 30 } });
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    try {
      await risk.start();
      await resetPaperWallet(100000);

      // 1. Fresh tick (0s) -> OK
      (market as any).lastTickAt = Date.now();
      let rows = await risk.evaluate();
      let staleRow = rows.find((r) => r.rule === 'Stale Market Tick')!;
      expect(staleRow.state).toBe('OK');
      expect(risk.canTrade().allowed).toBe(true);

      // 2. 20s tick age (> 15s warn, <= 30s error) -> WARN, canTrade remains allowed!
      (market as any).lastTickAt = Date.now() - 20_000;
      rows = await risk.evaluate();
      staleRow = rows.find((r) => r.rule === 'Stale Market Tick')!;
      expect(staleRow.state).toBe('WARN');
      expect(risk.canTrade().allowed).toBe(true);

      // 3. 35s tick age (> 30s error) -> ERROR, canTrade blocks!
      (market as any).lastTickAt = Date.now() - 35_000;
      rows = await risk.evaluate();
      staleRow = rows.find((r) => r.rule === 'Stale Market Tick')!;
      expect(staleRow.state).toBe('ERROR');
      expect(risk.canTrade().allowed).toBe(false);
      expect(risk.canTrade().reason).toContain('Stale Market Tick breached');
    } finally {
      risk.stop();
      jest.useRealTimers();
    }
  });
});

describe('MarketDataService — WebSocket failover', () => {
  it('allows one handshake and falls back to REST during a 429 cooldown', async () => {
    const market = Object.assign(new EventEmitter(), {
      isConnected: false,
      subscribe: jest.fn(),
      connect: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(),
    });
    const quote = jest.fn().mockResolvedValue({ data: { IDX_I: {} } });
    const client = { ws: { market }, marketFeed: { quote } } as any;
    const service = new MarketDataService(client);
    const origPin = process.env.DHAN_PIN;
    const origTotp = process.env.DHAN_TOTP_SECRET;
    const origClientId = process.env.DHAN_CLIENT_ID;
    process.env.DHAN_PIN = '1234';
    process.env.DHAN_TOTP_SECRET = 'testsecret';
    process.env.DHAN_CLIENT_ID = 'test-client';

    try {
      (service as any).tryStartWs(true);
      (service as any).tryStartWs(true);
      expect(market.connect).toHaveBeenCalledTimes(1);

      market.emit('error', new Error('Unexpected server response: 429'));
      await new Promise((resolve) => setImmediate(resolve));
      (service as any).tryStartWs(true);

      expect(market.disconnect).toHaveBeenCalledTimes(1);
      expect(market.connect).toHaveBeenCalledTimes(1);
      expect(quote).toHaveBeenCalledTimes(1);
    } finally {
      service.stop();
      if (origPin === undefined) delete process.env.DHAN_PIN;
      else process.env.DHAN_PIN = origPin;
      if (origTotp === undefined) delete process.env.DHAN_TOTP_SECRET;
      else process.env.DHAN_TOTP_SECRET = origTotp;
      if (origClientId === undefined) delete process.env.DHAN_CLIENT_ID;
      else process.env.DHAN_CLIENT_ID = origClientId;
    }
  });

  it('retries a connect() attempt that never settles instead of getting stuck forever', async () => {
    // Regression test: wsConnecting was only ever cleared by the open/
    // error/close handlers. A connect() that never fires any of them — a
    // raw socket stuck at the TCP level with no timeout enforced by the WS
    // library — left wsConnecting true permanently: every later retry hit
    // the early guard and returned without scheduling another one, so the
    // reconnect loop died forever.
    const pending = new Promise<void>(() => {}); // never resolves or rejects
    const market = Object.assign(new EventEmitter(), {
      isConnected: false,
      subscribe: jest.fn(),
      connect: jest.fn(() => pending),
      disconnect: jest.fn(),
    });
    const client = { ws: { market }, marketFeed: { quote: jest.fn() } } as any;
    const service = new MarketDataService(client);
    const origPin = process.env.DHAN_PIN;
    const origTotp = process.env.DHAN_TOTP_SECRET;
    const origClientId = process.env.DHAN_CLIENT_ID;
    process.env.DHAN_PIN = '1234';
    process.env.DHAN_TOTP_SECRET = 'testsecret';
    process.env.DHAN_CLIENT_ID = 'test-client';

    try {
      (service as any).tryStartWs(true);
      expect(market.connect).toHaveBeenCalledTimes(1);

      // A retry landing while the attempt is still "fresh" must not
      // double-connect.
      (service as any).tryStartWs(true);
      expect(market.connect).toHaveBeenCalledTimes(1);

      // Once the stuck attempt is stale, the next retry must try again
      // rather than staying stuck behind the early guard forever.
      (service as any).wsConnectingAt = Date.now() - 31_000;
      (service as any).tryStartWs(true);
      expect(market.connect).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      if (origPin === undefined) delete process.env.DHAN_PIN;
      else process.env.DHAN_PIN = origPin;
      if (origTotp === undefined) delete process.env.DHAN_TOTP_SECRET;
      else process.env.DHAN_TOTP_SECRET = origTotp;
      if (origClientId === undefined) delete process.env.DHAN_CLIENT_ID;
      else process.env.DHAN_CLIENT_ID = origClientId;
    }
  });

  it('schedules a retry instead of dying silently when isConnected reads stale-true after a forced disconnect', async () => {
    // Regression test: the SDK only flips isConnected to false inside the
    // underlying transport's own ASYNC 'close' event — not synchronously
    // inside disconnect() (confirmed against the SDK's BaseWS source). A
    // retry landing before that event fires sees isConnected still true,
    // skips connect() entirely, and — since nothing else in tryStartWs()
    // scheduled a retry for that branch — the reconnect loop died
    // permanently: wsStarted stayed false, isConnected stayed stale-true,
    // and connect() was never called again.
    const market = Object.assign(new EventEmitter(), {
      isConnected: false,
      subscribe: jest.fn(),
      connect: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(), // deliberately does NOT flip isConnected — the close event hasn't "fired" yet
    });
    const client = { ws: { market }, marketFeed: { quote: jest.fn() } } as any;
    const service = new MarketDataService(client);
    const origPin = process.env.DHAN_PIN;
    const origTotp = process.env.DHAN_TOTP_SECRET;
    const origClientId = process.env.DHAN_CLIENT_ID;
    process.env.DHAN_PIN = '1234';
    process.env.DHAN_TOTP_SECRET = 'testsecret';
    process.env.DHAN_CLIENT_ID = 'test-client';

    try {
      (service as any).tryStartWs(true);
      market.isConnected = true;
      market.emit('open');
      expect((service as any).wsStarted).toBe(true);

      // Simulate a forced disconnect (armSilenceWatch/the 429 handler):
      // wsStarted flips false, but isConnected stays stale-true.
      (service as any).wsStarted = false;
      market.disconnect();
      expect(market.isConnected).toBe(true);

      expect((service as any).wsRetryTimer).toBeNull();
      (service as any).tryStartWs(true);
      expect((service as any).wsRetryTimer).not.toBeNull();
    } finally {
      service.stop();
      if (origPin === undefined) delete process.env.DHAN_PIN;
      else process.env.DHAN_PIN = origPin;
      if (origTotp === undefined) delete process.env.DHAN_TOTP_SECRET;
      else process.env.DHAN_TOTP_SECRET = origTotp;
      if (origClientId === undefined) delete process.env.DHAN_CLIENT_ID;
      else process.env.DHAN_CLIENT_ID = origClientId;
    }
  });

  it('suppresses WebSocket connect attempts when market is closed (off-hours)', () => {
    const market = Object.assign(new EventEmitter(), {
      isConnected: false,
      subscribe: jest.fn(),
      connect: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(),
    });
    const client = { ws: { market }, marketFeed: { quote: jest.fn() } } as any;
    const service = new MarketDataService(client);
    const origPin = process.env.DHAN_PIN;
    const origTotp = process.env.DHAN_TOTP_SECRET;
    const origClientId = process.env.DHAN_CLIENT_ID;
    process.env.DHAN_PIN = '1234';
    process.env.DHAN_TOTP_SECRET = 'testsecret';
    process.env.DHAN_CLIENT_ID = 'test-client';

    const spy = jest.spyOn(marketHours, 'isWsMarketWindowOpen').mockReturnValue(false);
    try {
      (service as any).tryStartWs(false);
      // When outside market hours, connect() must NOT be called
      expect(market.connect).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      service.stop();
      if (origPin === undefined) delete process.env.DHAN_PIN;
      else process.env.DHAN_PIN = origPin;
      if (origTotp === undefined) delete process.env.DHAN_TOTP_SECRET;
      else process.env.DHAN_TOTP_SECRET = origTotp;
      if (origClientId === undefined) delete process.env.DHAN_CLIENT_ID;
      else process.env.DHAN_CLIENT_ID = origClientId;
    }
  });
});

describe('getFillablePrice — off-hours freshness bound (allowClosed)', () => {
  // Regression coverage: schedulePolling() backs the REST poll interval off
  // to 30s off-hours (vs 3s during market hours), but getFillablePrice's
  // default maxAgeMs was a flat 15s regardless of allowClosed — rejecting
  // the SAME still-freshest-available off-hours quote for roughly half of
  // every 30s poll cycle, purely by timing luck. Affected real callers:
  // seedStandardStrategies' spot lookups, EOD square-off, and the kill
  // switch's close-all price all call with allowClosed:true and no
  // explicit maxAgeMs.
  function ageQuote(market: MarketDataService, securityId: string, ltp: number, ageMs: number) {
    (market as any).quotes.set(securityId, {
      securityId, ltp, change: 0, pctChange: 0, high: ltp, low: ltp, open: ltp, prevClose: ltp,
      volume: 0, oi: 0, updatedAt: Date.now() - ageMs,
    });
  }

  it('accepts an allowClosed quote up to the 30s off-hours poll interval', () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T15:00:00.000Z')); // 20:30 IST Tuesday — well off-hours
    try {
      const market = stubMarket(null);
      ageQuote(market, '44000', 100, 25_000); // 25s old — would have failed the old 15s default
      expect(market.getFillablePrice('44000', { allowClosed: true })).toBe(100);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still rejects an allowClosed quote clearly older than any normal poll cycle', () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T15:00:00.000Z'));
    try {
      const market = stubMarket(null);
      ageQuote(market, '44000', 100, 90_000); // 90s old — a genuine feed dropout, not poll timing
      expect(market.getFillablePrice('44000', { allowClosed: true })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the tight 15s bound for market-hours (non-allowClosed) calls, unaffected by this fix', () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST Tuesday — market open
    try {
      const market = stubMarket(null);
      ageQuote(market, '44000', 100, 20_000); // 20s old — over the market-hours bound
      expect(market.getFillablePrice('44000')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RiskEngine — IST session rollover (RISK-01)', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(100000); });
  afterAll(async () => { await resetPaperWallet(100000); });

  it('scopes sessionRealizedPnl to today, not the lifetime wallet total', async () => {
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'SELL', price: 110 }); // +500 realized

    const w1 = await getPaperWallet();
    // First read of a fresh session snapshots the base at the current lifetime
    // total, so a session that already has realized PnL when the process
    // boots doesn't retroactively count as "today's" loss/gain.
    expect(w1.sessionRealizedPnl).toBe(w1.realizedPnl);

    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'SELL', price: 106 }); // +300 more

    const w2 = await getPaperWallet();
    expect(w2.sessionRealizedPnl).toBeCloseTo(w1.sessionRealizedPnl + 300, 2);
    expect(w2.realizedPnl).toBeCloseTo(w1.realizedPnl + 300, 2);
  });

  it('auto-clears a kill switch armed on a prior trading day', async () => {
    await saveRiskState({ killed: true, killedReason: 'stale test kill', killedDate: '2000-01-01', limits: {} });
    const risk = new RiskEngine(stubClient(), stubMarket(100));
    await risk.start();
    expect(risk.isKilled()).toBe(false);
    risk.stop();
  });

  it('keeps a kill switch armed today across a restart', async () => {
    const today = new Date().toISOString().slice(0, 10); // close enough for a same-instant restart in CI's UTC/IST window
    await saveRiskState({ killed: true, killedReason: 'live test kill', killedDate: today, limits: {} });
    const risk = new RiskEngine(stubClient(), stubMarket(100));
    await risk.start();
    // Only assert same-day persistence when the host clock and IST agree on
    // the date (avoids UTC-evening flakiness where `today` != IST's today).
    const { marketClock } = await import('../services/marketHours.js');
    if (marketClock().istDate === today) expect(risk.isKilled()).toBe(true);
    risk.stop();
    await saveRiskState({ killed: false, killedReason: null, killedDate: null, limits: {} });
  });
});

describe('Kill switch — real position square-off', () => {
  beforeAll(async () => { await initDatabase(); });

  it('closes open positions at live LTP when armed', async () => {
    const market = stubMarket(120);
    const risk = new RiskEngine(stubClient(), market);
    await risk.start();
    await risk.disarmKillSwitch();

    // Open a position at 100, market now 120 → closing realizes +20/qty.
    await executePaperOrder({ symbol: 'KILLTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    const before = await getPaperWallet();
    const result = await risk.armKillSwitch('kill switch test');
    const after = await getPaperWallet();

    expect(result.status).toBe('killed');
    expect(result.details.positionsClosed).toBeGreaterThanOrEqual(1);
    expect(after.realizedPnl).toBeGreaterThan(before.realizedPnl);

    const positions = await listPaperPositions();
    const stillOpen = positions.filter((p: any) => p.netQty !== 0 && p.tradingSymbol === 'KILLTEST');
    expect(stillOpen.length).toBe(0);
    await risk.disarmKillSwitch();
  });
});

describe('Mark-to-market — autonomy loop feed', () => {
  beforeAll(async () => { await initDatabase(); });

  it('marks open positions from live ticks', async () => {
    await executePaperOrder({ symbol: 'MARKTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    const market = stubMarket(150);
    const { totalUnrealized, staleCount } = await markPositionsToMarket((secId) => market.getLtp(secId));
    expect(totalUnrealized).toBeGreaterThan(0); // (150-100)*50 across open positions
    expect(staleCount).toBe(0);
    const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'MARKTEST');
    expect(pos?.ltp).toBe(150);
    expect(pos?.unrealizedPnl).toBeGreaterThan(0);
  });
});

describe('AgentOrchestrator — honest LLM fallback', () => {
  beforeAll(async () => { await initDatabase(); });

  // auth.ts calls dotenv.config() at module-load time (transitively imported
  // via PaperExecutionEngine/LiveExecutionEngine above), which fills in
  // whatever real OLLAMA_API_KEY_N values are in .env — so every test in
  // this block that constructs an AgentOrchestrator would otherwise
  // silently enter real Ollama Cloud mode and fire an unawaited, unstubbed
  // network call. Clear the whole numbered range to a blank slate for
  // every test; a test that wants cloud-mode behavior sets its own fake
  // key(s) explicitly, on top of this clean baseline.
  let ollamaKeyEnvSnapshot: Record<string, string | undefined> = {};
  beforeEach(async () => {
    await resetPaperWallet(100000);
    ollamaKeyEnvSnapshot = {};
    for (const key of Object.keys(process.env)) {
      if (/^OLLAMA_API_KEY_\d+$/.test(key)) {
        ollamaKeyEnvSnapshot[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (/^OLLAMA_API_KEY_\d+$/.test(key) && !(key in ollamaKeyEnvSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(ollamaKeyEnvSnapshot)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('reports deterministic mode when Ollama is unreachable', async () => {
    const { agent } = await stubEngines(100);
    const status = agent.status();
    expect(['ollama', 'deterministic']).toContain(status.llm);
    expect(status.personas.planner).toEqual({ status: 'idle', steps: 0 });
  });

  it('uses OLLAMA_CLOUD_MODEL when a cloud API key is configured, and the local OLLAMA_MODEL otherwise', () => {
    const priorKey = process.env.OLLAMA_API_KEY_1;
    const priorCloudModel = process.env.OLLAMA_CLOUD_MODEL;
    try {
      delete process.env.OLLAMA_API_KEY_1;
      const localAgent = new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any);
      expect((localAgent as any).llmModel).toBe(process.env.OLLAMA_MODEL || 'qwen2.5:0.5b');

      process.env.OLLAMA_API_KEY_1 = 'test-cloud-key';
      process.env.OLLAMA_CLOUD_MODEL = 'gemma4:31b';
      const cloudAgent = new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any);
      expect((cloudAgent as any).llmModel).toBe('gemma4:31b');
    } finally {
      if (priorKey === undefined) delete process.env.OLLAMA_API_KEY_1; else process.env.OLLAMA_API_KEY_1 = priorKey;
      if (priorCloudModel === undefined) delete process.env.OLLAMA_CLOUD_MODEL; else process.env.OLLAMA_CLOUD_MODEL = priorCloudModel;
    }
  });

  it('readOllamaCloudKeys reads any number of OLLAMA_API_KEY_N, not just 3, stopping at the first gap', () => {
    const keys = ['OLLAMA_API_KEY_1', 'OLLAMA_API_KEY_2', 'OLLAMA_API_KEY_3', 'OLLAMA_API_KEY_4', 'OLLAMA_API_KEY_5'];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      expect(readOllamaCloudKeys()).toEqual([]);

      process.env.OLLAMA_API_KEY_1 = 'k1';
      process.env.OLLAMA_API_KEY_2 = 'k2';
      process.env.OLLAMA_API_KEY_3 = 'k3';
      process.env.OLLAMA_API_KEY_4 = 'k4';
      process.env.OLLAMA_API_KEY_5 = 'k5';
      expect(readOllamaCloudKeys()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']); // a 4th/5th key needs no code change

      delete process.env.OLLAMA_API_KEY_3; // gap at 3 — stops before picking up 4/5
      expect(readOllamaCloudKeys()).toEqual(['k1', 'k2']);
    } finally {
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k];
      }
    }
  });

  it('ollamaKeyStatus reports one row per configured cloud credential, none exposing the raw key', () => {
    const priorKeys = [process.env.OLLAMA_API_KEY_1, process.env.OLLAMA_API_KEY_2];
    // The constructor fires an unawaited probeLlm() -> ollama.version() real
    // network call. Stub fetch so that fails instantly instead of dialing
    // ollama.com for real in a unit test (slow, flaky offline, and a
    // dangling promise that can bleed into whichever test runs next).
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('test: no network'));
    try {
      process.env.OLLAMA_API_KEY_1 = 'super-secret-key-1';
      process.env.OLLAMA_API_KEY_2 = 'super-secret-key-2';
      const agent = new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any);

      const rows = agent.ollamaKeyStatus();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['credential:cloud-1', 'credential:cloud-2']);
      expect(rows.every((r) => r.isCoolingDown === false && r.failureCount === 0)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('super-secret-key');
    } finally {
      fetchSpy.mockRestore();
      if (priorKeys[0] === undefined) delete process.env.OLLAMA_API_KEY_1; else process.env.OLLAMA_API_KEY_1 = priorKeys[0];
      if (priorKeys[1] === undefined) delete process.env.OLLAMA_API_KEY_2; else process.env.OLLAMA_API_KEY_2 = priorKeys[1];
    }
  });

  it('ollamaKeyStatus returns empty when no cloud keys are configured (local mode still has one endpoint, but nothing to report per-key)', () => {
    const priorKey = process.env.OLLAMA_API_KEY_1;
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('test: no network'));
    try {
      delete process.env.OLLAMA_API_KEY_1;
      const agent = new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any);
      const rows = agent.ollamaKeyStatus();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'default', isCoolingDown: false, failureCount: 0, lastFailureAt: null });
    } finally {
      fetchSpy.mockRestore();
      if (priorKey === undefined) delete process.env.OLLAMA_API_KEY_1; else process.env.OLLAMA_API_KEY_1 = priorKey;
    }
  });

  it('exposes the real SDK tool catalog (44 policy-gated tools)', () => {
    const { agent } = { agent: new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any) };
    const catalog = agent.toolCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(40);
    const names = catalog.map((t) => t.name);
    expect(names).toContain('dhan_ltp');
    expect(names).toContain('dhan_option_chain');
    expect(names).toContain('dhan_place_order');
  });

  it('refuses concurrent runs and blocked runs honestly', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    await risk.armKillSwitch('agent test block');
    await expect(agent.run('test objective')).rejects.toThrow(/kill switch/i);
    await risk.disarmKillSwitch();
    risk.stop();
  });

  it('resolves informational queries directly without running the trading pipeline or option chain pulls', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    const emittedEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => emittedEvents.push(ev));

    try {
      const res = await agent.run('What is the lot size of options for SENSEX currently');
      expect(res.status).toBe('started');

      // Wait a short tick for asynchronous executeRun to resolve query
      await new Promise((r) => setTimeout(r, 100));
      const answerStep = emittedEvents.map((e) => e.payload || e).find((e) => e.summary?.includes('Answer:'));
      expect(answerStep).toBeDefined();
      expect(answerStep.summary).toContain('20 units per lot');
      expect(answerStep.summary).toContain('SENSEX');

      // Assert that option chain and backtest were never triggered
      const toolSteps = emittedEvents.map((e) => e.payload || e).filter((e) => e.tool);
      expect(toolSteps.some((e) => e.tool === 'dhan_option_chain')).toBe(false);
      expect(toolSteps.some((e) => e.tool === 'strategy.backtest')).toBe(false);
    } finally {
      unsubscribe();
      risk.stop();
    }
  });

  it('accurately resolves BANKNIFTY lot size without colliding with NIFTY', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    const emittedEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => emittedEvents.push(ev));

    try {
      const res = await agent.run('What is the lot size of options for BANKNIFTY currently');
      expect(res.status).toBe('started');

      await new Promise((r) => setTimeout(r, 100));
      const answerStep = emittedEvents.map((e) => e.payload || e).find((e) => e.summary?.includes('Answer:'));
      expect(answerStep).toBeDefined();
      expect(answerStep.summary).toContain('30 units per lot');
      expect(answerStep.summary).toContain('BANKNIFTY');
      expect(answerStep.summary).not.toContain('65 units per lot');
    } finally {
      unsubscribe();
      risk.stop();
    }
  });

  it('dynamically executes DhanHQ SDK tools during queries when requested', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    const emittedEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => emittedEvents.push(ev));

    // Hermetic spy on AgentToolRegistry so test executes in <10ms
    jest.spyOn((agent as any).tools, 'execute').mockResolvedValueOnce([
      { securityId: '2885', symbolName: 'RELIANCE', exchangeSegment: 'NSE_EQ' }
    ]);

    try {
      const res = await agent.run('Search instrument RELIANCE');
      expect(res.status).toBe('started');

      await new Promise((r) => setTimeout(r, 100));
      const actStep = emittedEvents.map((e) => e.payload || e).find((e) => e.type === 'ACT' && e.tool === 'dhan_search_instruments');
      expect(actStep).toBeDefined();
      expect(actStep.response).toContain('2885');

      const answerStep = emittedEvents.map((e) => e.payload || e).find((e) => e.summary?.includes('Answer:'));
      expect(answerStep).toBeDefined();
      expect(answerStep.summary).toContain('RELIANCE');
    } finally {
      unsubscribe();
      risk.stop();
    }
  });

  it('allows informational queries to run concurrently even when a trade run is in progress (lockless queries)', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    // Simulate a background autonomous trade run in progress
    (agent as any).running = true;
    (agent as any).currentRunTriggeredBy = 'autonomous_scanner';

    // Trade run should be rejected or wait
    await expect(agent.run('Buy 1 lot NIFTY call', 'autonomous_scanner')).rejects.toThrow(/in progress/i);

    // But an informational query must succeed locklessly!
    const queryRes = await agent.run('What is the lot size of options for SENSEX currently', 'control_plane');
    expect(queryRes.status).toBe('started');
    expect(queryRes.triggeredBy).toBe('control_plane');
    expect(queryRes.runId).toBeDefined();

    // Cleanup
    (agent as any).running = false;
    (agent as any).currentRunTriggeredBy = null;
    risk.stop();
  });

  it('routes alert diagnosis objectives to lockless diagnostic triage without trade execution', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    const emittedEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => emittedEvents.push(ev));

    jest.spyOn((agent as any).tools, 'execute').mockResolvedValueOnce({
      status: 'success',
      data: { IDX_I: { '13': { last_price: 24000 } } }
    });

    try {
      const res = await agent.run('Diagnose and remediate alert [ERROR] (marketData): Stale Market Tick: OK → ERROR');
      expect(res.status).toBe('started');

      await new Promise((r) => setTimeout(r, 120));
      const steps = emittedEvents.map((e) => e.payload || e);
      const actProbe = steps.find((e) => e.type === 'ACT' && e.tool === 'dhan_ltp');
      expect(actProbe).toBeDefined();

      const answer = steps.find((e) => e.summary?.includes('Answer:'));
      expect(answer).toBeDefined();
      expect(answer.summary).toMatch(/Diagnostic Findings|Exchange|Feed/i);
    } finally {
      unsubscribe();
      risk.stop();
    }
  });

  it('engages multi-agent personas and audits running strategies for concurrency alert remediation', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    // Mock 5 running strategies: 3 active with open positions, 2 flat/idle
    await createPaperStrategy({ id: 's1', name: 'NIFTY ORB', symbol: 'NIFTY', type: 'ORB_15M', lots: 1, legs: [{ instrument: 'NIFTY24050CE', qty: 50, side: 'BUY' }] });
    await createPaperStrategy({ id: 's2', name: 'BANKNIFTY Straddle', symbol: 'BANKNIFTY', type: 'STRADDLE', lots: 1, legs: [{ instrument: 'BNF50000CE', qty: 30, side: 'SELL' }] });
    await createPaperStrategy({ id: 's3', name: 'SENSEX Condor', symbol: 'SENSEX', type: 'IRON_CONDOR', lots: 1, legs: [{ instrument: 'SENSEX80000CE', qty: 20, side: 'BUY' }] });
    await createPaperStrategy({ id: 's4', name: 'FINNIFTY Breakout', symbol: 'FINNIFTY', type: 'ORB_15M', lots: 1, legs: [] });
    await createPaperStrategy({ id: 's5', name: 'MIDCPNIFTY VWAP', symbol: 'MIDCPNIFTY', type: 'VWAP_RSI', lots: 1, legs: [] });

    const emittedEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => emittedEvents.push(ev));

    try {
      const res = await agent.run('Diagnose and remediate alert [ERROR] (risk_engine): Concurrent Strategies: WARN → ERROR (current 5, threshold 5). Action: Block new strategy deploys — correlated pile-up across indices');
      expect(res.status).toBe('started');

      await new Promise((r) => setTimeout(r, 150));
      const steps = emittedEvents.map((e) => e.payload || e);

      expect(steps.some((e) => e.agent === 'planner' && e.type === 'THINK')).toBe(true);
      expect(steps.some((e) => e.agent === 'risk' && e.type === 'ACT')).toBe(true);
      expect(steps.some((e) => e.agent === 'strategy' && e.type === 'ACT')).toBe(true);
      expect(steps.some((e) => e.agent === 'execution' && e.type === 'THINK')).toBe(true);
      expect(steps.some((e) => e.agent === 'analyst' && e.type === 'OBSERVE')).toBe(true);

      const answer = steps.find((e) => e.summary?.includes('Answer:'));
      expect(answer).toBeDefined();
      expect(answer.summary).toContain('REMEDIATION: STOP_STRATEGIES');
      expect(answer.summary).toContain('FINNIFTY Breakout');
      expect(answer.summary).toContain('MIDCPNIFTY VWAP');
    } finally {
      unsubscribe();
      risk.stop();
    }
  });

  it('unwinds a multi-leg deploy when only some legs fill (EXEC-01)', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { agent } = await stubEngines(100); // quote exists only for security '44000'
      const strat = {
        id: `exec01_test_${Date.now()}`,
        name: 'Test Bull Call Spread',
        symbol: 'NIFTY',
        type: 'BULL_CALL_SPREAD' as any,
        lots: 1,
        estimatedNetPremium: 0,
        lotSize: 50,
        legs: [
          // Fillable: quote exists for this security.
          { instrument: 'NIFTY24050CE', securityId: '44000', side: 'BUY' as const, qty: 50, strike: 24050, optionType: 'CE' as const, price: 100, exchangeSegment: 'NSE_FNO' },
          // Unfillable: no quote for this security and no fallback price → paper.placeOrder REJECTs.
          { instrument: 'NIFTY24150CE', securityId: '99999', side: 'SELL' as const, qty: 50, strike: 24150, optionType: 'CE' as const, price: 0, exchangeSegment: 'NSE_FNO' },
        ],
      };
      const result: any = await (agent as any).executeStrategy('run1', 'deploy this spread', strat, true);
      expect(result.status).toBe('FAILED');
      expect(result.reason).toBe('partial_fill_unwound');
      const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'NIFTY24050CE');
      expect(Number(pos?.netQty || 0)).toBe(0); // the leg that filled was unwound back to flat
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not log an ERROR when unwind finds the leg already flat — closed by another exit path first (e.g. long-option giveback policy)', async () => {
    // Regression, found live: a leg filled, the long-option giveback policy
    // closed it independently within ~40ms, and THEN this leg's own unwind
    // (triggered by a sibling leg failing) found nothing left to close —
    // portfolio.closePosition() correctly returns 'noop', which used to be
    // logged as ERROR (and fed a pointless self-healing "investigate root
    // cause" promotion) even though flat-with-no-exposure is exactly the
    // state a successful unwind was trying to reach anyway.
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z'));
    try {
      const { agent, risk } = await stubEngines(100);
      // Defensive: stubEngines()'s mocked canTrade() blocks on isKilled(),
      // which reads persisted kill state shared across RiskEngine instances
      // in this file (pre-existing cross-test leakage, unrelated to this
      // fix) — don't let an earlier test's leftover armed kill switch
      // reject this test's entry leg before it even reaches the unwind path.
      if (risk.isKilled()) await risk.disarmKillSwitch();
      const logSpy = jest.spyOn(eventBus, 'log');
      jest.spyOn(risk.getPortfolio(), 'closePosition').mockResolvedValueOnce({ status: 'noop', reason: 'No open position found', symbol: 'NOOPTEST24050CE' } as any);

      const strat = {
        id: `exec01_noop_test_${Date.now()}`,
        name: 'Test Bull Call Spread (already-flat unwind)',
        symbol: 'NIFTY',
        type: 'BULL_CALL_SPREAD' as any,
        lots: 1,
        estimatedNetPremium: 0,
        lotSize: 50,
        legs: [
          // Distinct symbol (not NIFTY24050CE) so this test's margin/wallet
          // state isn't polluted by EXEC-01 above, which fills the same
          // security_id '44000' under that symbol without a wallet reset
          // between AgentOrchestrator tests in this file.
          { instrument: 'NOOPTEST24050CE', securityId: '44000', side: 'BUY' as const, qty: 50, strike: 24050, optionType: 'CE' as const, price: 100, exchangeSegment: 'NSE_FNO' },
          { instrument: 'NOOPTEST24150CE', securityId: '99999', side: 'SELL' as const, qty: 50, strike: 24150, optionType: 'CE' as const, price: 0, exchangeSegment: 'NSE_FNO' },
        ],
      };
      const result: any = await (agent as any).executeStrategy('run_noop', 'deploy this spread', strat, true);
      expect(result.status).toBe('FAILED');
      expect(result.reason).toBe('partial_fill_unwound');
      expect(logSpy).not.toHaveBeenCalledWith('ERROR', expect.stringContaining('Unwind FAILED'), 'agent');
      expect(logSpy).toHaveBeenCalledWith('INFO', expect.stringContaining('already flat'), 'agent');
    } finally {
      jest.useRealTimers();
    }
  });

  it('unwinds a partially-filled leg even when canTrade() has since gone false — the exact condition that likely caused the partial fill', async () => {
    // Regression test: the unwind used to call engine.placeOrder() for the
    // reversing order, which re-checks risk.canTrade() — the SAME gate a
    // breaker tripping or the kill switch arming BETWEEN legs would have
    // just failed on leg 2. That left leg 1 open, naked, and (since
    // monitor.untrack() ran unconditionally regardless of the unwind's own
    // outcome) with no stop-loss either.
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z'));
    try {
      const { agent, risk } = await stubEngines(100);
      // Leg 1's entry sees canTrade() allowed; every call after — leg 2's
      // entry, and (pre-fix) the unwind itself — sees it blocked.
      jest.spyOn(risk, 'canTrade')
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValue({ allowed: false, reason: 'blocked mid-deploy' });

      const strat = {
        id: `exec01b_test_${Date.now()}`,
        name: 'Test Bull Call Spread (gate race)',
        symbol: 'NIFTY',
        type: 'BULL_CALL_SPREAD' as any,
        lots: 1,
        estimatedNetPremium: 0,
        lotSize: 50,
        legs: [
          { instrument: 'NIFTY24060CE', securityId: '44000', side: 'BUY' as const, qty: 50, strike: 24060, optionType: 'CE' as const, price: 100, exchangeSegment: 'NSE_FNO' },
          { instrument: 'NIFTY24160CE', securityId: '99998', side: 'SELL' as const, qty: 50, strike: 24160, optionType: 'CE' as const, price: 0, exchangeSegment: 'NSE_FNO' },
        ],
      };
      const result: any = await (agent as any).executeStrategy('run1b', 'deploy this spread', strat, true);
      expect(result.status).toBe('FAILED');
      expect(result.reason).toBe('partial_fill_unwound');
      const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'NIFTY24060CE');
      expect(Number(pos?.netQty || 0)).toBe(0); // unwound despite canTrade() being false throughout
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Database layer — fallback mode honesty', () => {
  afterAll(async () => {
    await resetPaperWallet(100000);
    await pool.end();
  });

  it('reports which persistence mode is active', () => {
    expect(['postgres', 'memory']).toContain(dbMode());
  });

  it('reconcileLedger no-ops in memory mode — nothing durable to compare mem against', async () => {
    // This whole suite runs in memory mode (no TEST_DATABASE_URL) — the
    // real Postgres-comparison path is covered separately in
    // ledgerReconciler.test.ts, which requires a live database.
    expect(dbMode()).toBe('memory');
    const report = await reconcileLedger();
    expect(report).toEqual({ ok: true, checkedPositions: 0, mismatches: [], missingInPostgres: [], missingInMem: [] });
  });
});

describe('findMissingOrders — journal boot cross-check', () => {
  beforeAll(async () => { await initDatabase(); });

  it('finds nothing missing for an entry order matched by correlation_id', async () => {
    const order = await executePaperOrder({
      symbol: 'FMO_ENTRY', securityId: '88001', quantity: 50,
      transactionType: 'BUY', price: 100, correlationId: 'fmo_corr_1',
    });
    expect(order.status).toBe('TRADED');
    expect(await findMissingOrders(['fmo_corr_1'])).toEqual([]);
  });

  it('finds nothing missing for an exit order matched by the generated order id', async () => {
    await executePaperOrder({ symbol: 'FMO_EXIT', securityId: '88002', quantity: 50, transactionType: 'BUY', price: 100 });
    const close = await closePaperPosition('FMO_EXIT', 110);
    expect(close.status).toBe('TRADED');
    // closePaperPosition's journaled "correlation_id" is the generated
    // orderId (see db.ts's closePaperPosition) — this is exactly what
    // core.ts's cross-check passes in from the journal.
    expect(await findMissingOrders([(close as any).orderId])).toEqual([]);
  });

  it('reports an id with no matching order at all', async () => {
    expect(await findMissingOrders(['never_placed_this_one'])).toEqual(['never_placed_this_one']);
  });

  it('returns an empty array for an empty input without querying anything', async () => {
    expect(await findMissingOrders([])).toEqual([]);
  });
});
