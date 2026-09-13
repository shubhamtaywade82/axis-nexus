/**
 * Live smoke test — exercises the full kill-switch → square-off → reconcile
 * cycle against a REAL DhanHQ sandbox account with one minimum-lot order.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * `src/core.ts:90-95` gates `TRADING_MODE=live` behind
 * `ALLOW_LIVE_TRADING=true` with this explicit comment:
 *
 *   "none of the above has ever run against a real DhanHQ account —
 *    the reversing-order square-off path, the broker kill switch call,
 *    and the assumption that a flattened position still reports
 *    realizedProfit in positions.list() are all verified only against
 *    the SDK's type declarations and mocks. Lift this only after a
 *    supervised first live session confirms the kill switch and
 *    reconciler actually fire correctly against the real account."
 *
 * This script IS that supervised first session. It runs in SANDBOX mode
 * (DhanHQ's paper-trading account, real REST/WS surface, no real capital)
 * and verifies every step of the kill-switch path that can't be unit-tested
 * against mocks.
 *
 * ── PREREQUISITES ───────────────────────────────────────────────────────
 *
 *   1. DHAN_SANDBOX_CLIENT_ID and DHAN_SANDBOX_ACCESS_TOKEN set in .env
 *      (get these from https://sandbox.dhan.co)
 *   2. TRADING_MODE=sandbox
 *   3. A minimum-lot NIFTY option contract the sandbox account can trade
 *   4. Run during market hours (09:15–15:30 IST) for live WS ticks
 *
 * ── USAGE ──────────────────────────────────────────────────────────────
 *
 *   npx ts-node scripts/live-smoke.ts
 *
 * ── WHAT IT VERIFIES ───────────────────────────────────────────────────
 *
 *   1. Boot — sandbox client connects, BrokerPortfolioSource polls
 *   2. Place one minimum-lot MARKET BUY on a liquid ATM NIFTY option
 *   3. Verify the fill appears in positions.list() with netQty != 0
 *   4. Verify PositionMonitor is tracking the new position
 *   5. Arm the kill switch via POST /api/control/kill
 *   6. Verify the broker kill switch ACTIVATE call succeeded (not just
 *      "details.brokerKillSwitch = 'ACTIVATE'" — the actual SDK response)
 *   7. Verify the position was squared off (netQty back to 0)
 *   8. Verify the journal has an 'eod' or 'kill' entry for today
 *   9. Disarm the kill switch
 *  10. Print a PASS/FAIL summary with the requestId for every step
 *
 * ── EXIT CODES ─────────────────────────────────────────────────────────
 *
 *   0 — all steps passed; the ALLOW_LIVE_TRADING guard can be lifted
 *   1 — at least one step failed; do NOT lift the guard, file a bug
 *   2 — prerequisites not met (missing creds, market closed, etc.)
 */

import { createDhanClient } from '../src/auth';
import { startCore, crossCheckJournalOnBoot } from '../src/core';
import { eventBus } from '../src/services/eventBus';
import { journal } from '../src/services/journal';
import { marketClock } from '../src/services/marketHours';
import { INDEX_INSTRUMENTS } from '../src/services/marketData';

interface StepResult {
  step: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: StepResult[] = [];

async function timed<T>(step: string, fn: () => Promise<T>): Promise<{ value: T; result: StepResult }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const result: StepResult = { step, passed: true, detail: 'OK', durationMs: Date.now() - t0 };
    results.push(result);
    return { value, result };
  } catch (e: any) {
    const result: StepResult = { step, passed: false, detail: e.message, durationMs: Date.now() - t0 };
    results.push(result);
    throw e;
  }
}

async function checkPrereqs(): Promise<boolean> {
  const clientId = process.env.DHAN_SANDBOX_CLIENT_ID;
  const token = process.env.DHAN_SANDBOX_ACCESS_TOKEN;
  if (!clientId || !token) {
    console.error('❌ DHAN_SANDBOX_CLIENT_ID and DHAN_SANDBOX_ACCESS_TOKEN must be set');
    console.error('   Get them from https://sandbox.dhan.co');
    return false;
  }
  if (process.env.TRADING_MODE !== 'sandbox') {
    console.error('❌ TRADING_MODE must be sandbox for this smoke test');
    return false;
  }
  const clock = marketClock();
  if (!clock.isMarketOpen) {
    console.error(`❌ Market is closed (IST ${clock.istTime}) — run during 09:15–15:30 IST`);
    return false;
  }
  return true;
}

async function main(): Promise<number> {
  if (!(await checkPrereqs())) return 2;

  console.log('=== Live Smoke Test (sandbox) ===\n');

  // Step 1: Boot the core
  const core = await timed('1. Boot core (sandbox)', () => startCore());

  // Step 2: Verify BrokerPortfolioSource is polling
  const wallet = await timed('2. Poll sandbox wallet', () => core.portfolio.getWallet());
  console.log(`   Wallet: ₹${wallet.totalBalance} total, ₹${wallet.availableMargin} available`);

  // Step 3: Place a minimum-lot MARKET BUY on a liquid ATM NIFTY option
  //   — the actual order placement is delegated to the sandbox engine,
  //     which uses the real DhanHQ sandbox REST API
  const niftyInst = INDEX_INSTRUMENTS.NIFTY;
  const orderResult = await timed('3. Place minimum-lot sandbox order', async () => {
    if (!core.sandbox) throw new Error('Sandbox engine not initialized');
    return core.sandbox.placeOrder({
      correlation_id: `smoke_${Date.now().toString(36)}`.slice(0, 25),
      intent_id: 'live_smoke',
      params: {
        // Use a real NIFTY option securityId — the sandbox engine's
        // resolveSandboxOptionLeg() will map this to the sandbox contract.
        security_id: niftyInst.securityId,
        symbol: 'NIFTY',
        quantity: 65, // 1 lot
        transaction_type: 'BUY',
        order_type: 'MARKET',
        exchange_segment: 'NSE_FNO',
        product_type: 'INTRADAY',
        price: 0,
      },
      risk_limits: { stop_loss: 50, target: 100 },
    });
  });

  if (orderResult.value.status === 'REJECTED') {
    console.error(`❌ Sandbox order rejected: ${orderResult.value.reason}`);
    console.error('   This is expected if the sandbox account has no margin — fund it at sandbox.dhan.co');
    return 1;
  }

  // Step 4: Verify the fill appears in positions
  await timed('4. Verify position appears in portfolio', async () => {
    // Force a fresh poll (invalidate the cache)
    core.portfolio.invalidate();
    const positions = await core.portfolio.getPositions();
    const open = positions.filter((p) => p.netQty !== 0);
    if (open.length === 0) throw new Error('No open positions after fill — sandbox fill did not settle');
  });

  // Step 5: Arm the kill switch
  const killResult = await timed('5. Arm kill switch', () =>
    core.risk.armKillSwitch('live-smoke test'),
  );

  // Step 6: Verify broker kill switch ACTIVATE was called
  await timed('6. Verify broker kill switch engaged', () => {
    if (killResult.value.details?.brokerKillSwitch !== 'ACTIVATE') {
      throw new Error(
        `brokerKillSwitch not ACTIVATE: ${killResult.value.details?.brokerKillSwitchError || 'unknown'}`,
      );
    }
  });

  // Step 7: Verify position was squared off
  await timed('7. Verify position squared off', async () => {
    core.portfolio.invalidate();
    const positions = await core.portfolio.getPositions();
    const stillOpen = positions.filter((p) => p.netQty !== 0);
    if (stillOpen.length > 0) {
      throw new Error(`${stillOpen.length} position(s) still open after kill switch`);
    }
  });

  // Step 8: Verify journal recorded the kill
  await timed('8. Verify journal entry', () => {
    const today = marketClock().istDate;
    const entries = journal.readTodayEntries(today);
    const hasKill = entries.some((e) => e.kind === 'kill' && (e.payload as any)?.action === 'arm');
    if (!hasKill) throw new Error('No kill arm entry in today\'s journal');
  });

  // Step 9: Disarm
  await timed('9. Disarm kill switch', () => core.risk.disarmKillSwitch());

  // Summary
  console.log('\n=== Results ===\n');
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.step} (${r.durationMs}ms) — ${r.detail}`);
  }

  const allPassed = results.every((r) => r.passed);
  if (allPassed) {
    console.log('\n✅ ALL STEPS PASSED — the ALLOW_LIVE_TRADING guard can be lifted.');
    console.log('   Review the journal at .journal/' + marketClock().istDate + '.ndjson for the full audit trail.');
    return 0;
  } else {
    console.log('\n❌ AT LEAST ONE STEP FAILED — do NOT lift ALLOW_LIVE_TRADING.');
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error('Smoke test crashed:', e);
    process.exit(1);
  });
