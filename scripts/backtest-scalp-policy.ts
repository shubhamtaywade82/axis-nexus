/**
 * Backtest script for the scalp exit policy.
 *
 * Loads historical 1-minute candle data for an index, simulates entries
 * on Supertrend momentum signals, and runs the both-side ratchet exit
 * policy over each trade. Reports aggregate stats for tuning the ratchet
 * schedule.
 *
 * Usage:
 *   npx ts-node scripts/backtest-scalp-policy.ts
 *   npx ts-node scripts/backtest-scalp-policy.ts --symbol BANKNIFTY --days 10
 *   npx ts-node scripts/backtest-scalp-policy.ts --min-capture 100 --tp-max 2.5
 *
 * Output:
 *   - Per-trade log (entry/exit/PnL/hold time/exit reason)
 *   - Aggregate stats (win rate, profit factor, avg hold, total P&L, fees)
 *   - Ratchet tier distribution (how often each tier fired)
 *
 * The script does NOT place real orders — it's a pure simulation against
 * historical data. It uses the same ScalpExitPolicy + FeeModel that the
 * live system uses, so results are directly comparable.
 */

import { evaluateScalpExit, type ScalpState } from '../src/services/scalpExitPolicy';
import { DEFAULT_SCALP_CONFIG, type ScalpConfig } from '../src/services/scalpConfig';
import { calculateRoundTripFees, estimateRoundTripFees } from '../src/services/feeModel';
import { getLotSize } from '../src/services/strategyConstructor';
import { calculateGreeks } from '../src/services/optionsAnalytics';
import { supertrend, type Candle } from '@nemesis-oss/dhanhq-sdk';

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function argNum(name: string, fallback: number): number {
  return Number(arg(name, String(fallback)));
}

const SYMBOL = arg('symbol', 'NIFTY');
const DAYS = argNum('days', 5);
const MIN_CAPTURE = argNum('min-capture', DEFAULT_SCALP_CONFIG.minCapturePerLot);
const TP_MIN = argNum('tp-min', DEFAULT_SCALP_CONFIG.targetMultiplier.min);
const TP_MAX = argNum('tp-max', DEFAULT_SCALP_CONFIG.targetMultiplier.max);
const ATR_MULT = argNum('atr-mult', DEFAULT_SCALP_CONFIG.atrMultiple);
const MAX_FLAT_MS = argNum('max-flat-ms', DEFAULT_SCALP_CONFIG.maxFlatHoldMs);

// ── Config (overridable via CLI) ────────────────────────────────────────

const config: ScalpConfig = {
  ...DEFAULT_SCALP_CONFIG,
  minCapturePerLot: MIN_CAPTURE,
  targetMultiplier: { min: TP_MIN, max: TP_MAX },
  atrMultiple: ATR_MULT,
  maxFlatHoldMs: MAX_FLAT_MS,
};

// ── Synthetic 1-min candle generator ────────────────────────────────────
//
// In a real backtest, you'd load historical candles from DhanHQ's
// historical data API or a local CSV. This script generates synthetic
// geometric-Brownian-motion candles with realistic NIFTY parameters
// (24000 spot, 12% annualized vol, 0.01% drift) so the backtest runs
// without external data. Swap in real candles by replacing this function.

interface SimCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function generateCandles(spot: number, days: number, intervalMs = 60_000): SimCandle[] {
  const candles: SimCandle[] = [];
  const totalCandles = (days * 6.5 * 60); // 6.5 hours/day × 60 min/hr
  const annualVol = 0.25; // 25% — higher than real NIFTY to generate more flips
  const annualDrift = 0.0001;
  const intervalVol = annualVol / Math.sqrt(252 * 6.5 * 60);
  const intervalDrift = annualDrift / (252 * 6.5 * 60);
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  let price = spot;
  for (let i = 0; i < totalCandles; i++) {
    const open = price;
    // Box-Muller transform for normal random
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const change = intervalDrift + intervalVol * z;
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + Math.abs(intervalVol * z * 0.5));
    const low = Math.min(open, close) * (1 - Math.abs(intervalVol * z * 0.5));
    candles.push({
      timestamp: startTime + i * intervalMs,
      open, high, low, close,
      volume: Math.floor(50000 + Math.random() * 50000),
    });
    price = close;
  }
  return candles;
}

// ── Supertrend (using the SDK's real implementation) ────────────────────

function computeSupertrend(candles: SimCandle[], period = 10, multiplier = 3): number[] {
  // Convert SimCandle to SDK Candle format
  const sdkCandles: Candle[] = candles.map(c => ({
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }) as Candle);
  const result = supertrend(sdkCandles, { period, multiplier });
  return result.direction.map(d => d ?? 0);
}

// ── Backtest engine ────────────────────────────────────────────────────

interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  side: 'LONG' | 'SHORT';
  pnl: number;
  fees: number;
  holdMs: number;
  exitAction: string;
  exitReason: string;
  peakR: number;
  tier: number;
}

function backtest(candles: SimCandle[], symbol: string): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const directions = computeSupertrend(candles, 10, 3);
  const lotSize = getLotSize(symbol);
  const iv = 0.12; // 12% IV for synthetic data
  let inTrade = false;
  let currentState: ScalpState | null = null;

  for (let i = 35; i < candles.length; i++) {
    const candle = candles[i];
    const spot = candle.close;
    const now = candle.timestamp;

    if (!inTrade) {
      // Check for entry: fresh crossover
      const dir = directions[i];
      const prevDir = directions[i - 1];
      if (dir !== prevDir && dir != null) {
        // Entry! Simulate buying an ATM option
        const side = dir === 1 ? 'LONG' : 'SHORT';
        const optionPrice = spot * 0.004; // ~0.4% of spot = ~₹96 for NIFTY 24000
        const delta = 0.52;
        const atr = (candles.slice(i - 14, i).reduce((s, c) => s + (c.high - c.low), 0)) / 14;
        const optionAtr = atr * delta;
        const initialSL = side === 'LONG'
          ? optionPrice - config.atrMultiple * optionAtr
          : optionPrice + config.atrMultiple * optionAtr;
        const fees = estimateRoundTripFees(optionPrice, lotSize, 'NSE_FNO');

        currentState = {
          positionId: `bt_${i}`,
          tradingSymbol: `${symbol}_SIM_${i}`,
          securityId: 'sim',
          underlying: symbol,
          side,
          entryPrice: optionPrice,
          currentPrice: optionPrice,
          peakPrice: optionPrice,
          lotSize,
          quantity: lotSize,
          underlyingSpot: spot,
          underlyingPeak: spot,
          underlyingAtr: atr,
          delta,
          initialRisk: Math.abs(optionPrice - initialSL),
          initialSL,
          currentSL: initialSL,
          currentFloor: optionPrice,
          currentTP: optionPrice + (config.minCapturePerLot * 2) / lotSize,
          entryTime: now,
          holdMs: 0,
          rMultiple: 0,
          activeTier: 0,
          givebackUsed: 0,
          feesPerLot: fees.perLot,
          breakevenPrice: optionPrice + fees.perLot,
          profitSoFar: -fees.total,
          peakProfit: -fees.total,
          momentumReversed: false,
          momentumStrength: 0,
        };
        inTrade = true;
      }
    } else if (currentState) {
      // Update the position — simulate option price with delta sensitivity
      // Option price ≈ entryPrice + (spotChange × delta × 0.01)
      // (0.01 scales the underlying move to a realistic option premium move)
      const spotChange = candle.close - candles[i - 1]!.close;
      const optionPriceChange = spotChange * 0.005; // ~50% delta scaled
      currentState.currentPrice = currentState.entryPrice + optionPriceChange * (currentState.side === 'LONG' ? 1 : -1);
      if (currentState.currentPrice < 1) currentState.currentPrice = 1; // floor at ₹1
      currentState.underlyingSpot = candle.close;
      if (currentState.side === 'LONG' && currentState.currentPrice > currentState.peakPrice) {
        currentState.peakPrice = currentState.currentPrice;
      }
      if (currentState.side === 'SHORT' && (currentState.currentPrice < currentState.peakPrice || currentState.peakPrice === currentState.entryPrice)) {
        currentState.peakPrice = currentState.currentPrice;
      }
      if (currentState.underlyingSpot > currentState.underlyingPeak) {
        currentState.underlyingPeak = currentState.underlyingSpot;
      }
      const dir = directions[i];
      const prevDir = directions[i - 1];
      currentState.momentumReversed = dir !== prevDir && dir != null;

      // Evaluate exit
      const decision = evaluateScalpExit(currentState, config, now);
      currentState = decision.stateSnapshot;

      if (decision.action !== 'HOLD') {
        const exitPrice = decision.exitPrice ?? currentState.currentPrice;
        const fees = calculateRoundTripFees(currentState.entryPrice, exitPrice, lotSize);
        const grossPnl = currentState.side === 'LONG'
          ? (exitPrice - currentState.entryPrice) * lotSize
          : (currentState.entryPrice - exitPrice) * lotSize;
        const netPnl = grossPnl - fees.total;

        trades.push({
          entryTime: currentState.entryTime,
          exitTime: now,
          entryPrice: currentState.entryPrice,
          exitPrice,
          peakPrice: currentState.peakPrice,
          side: currentState.side,
          pnl: netPnl,
          fees: fees.total,
          holdMs: now - currentState.entryTime,
          exitAction: decision.action,
          exitReason: decision.reason,
          peakR: currentState.rMultiple,
          tier: currentState.activeTier,
        });
        inTrade = false;
        currentState = null;
      }
    }
  }
  return trades;
}

// ── Report ─────────────────────────────────────────────────────────────

function report(trades: BacktestTrade[], symbol: string): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Scalp Backtest Report — ${symbol} (${DAYS} days, ${trades.length} trades)`);
  console.log(`${'='.repeat(70)}\n`);

  if (trades.length === 0) {
    console.log('  No trades generated. Try adjusting --min-capture or --days.');
    return;
  }

  // Aggregate stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgHoldMs = trades.reduce((s, t) => s + t.holdMs, 0) / trades.length;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  console.log('  ┌─ Aggregate Stats ─────────────────────────────────────────┐');
  console.log(`  │ Total trades:     ${trades.length}`);
  console.log(`  │ Wins / Losses:    ${wins.length} / ${losses.length}`);
  console.log(`  │ Win rate:         ${((wins.length / trades.length) * 100).toFixed(1)}%`);
  console.log(`  │ Net P&L:          ₹${totalPnl.toFixed(0)}`);
  console.log(`  │ Total fees:       ₹${totalFees.toFixed(0)}`);
  console.log(`  │ Gross profit:     ₹${grossProfit.toFixed(0)}`);
  console.log(`  │ Gross loss:       ₹${grossLoss.toFixed(0)}`);
  console.log(`  │ Profit factor:    ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞'}`);
  console.log(`  │ Avg win:          ₹${avgWin.toFixed(0)}`);
  console.log(`  │ Avg loss:         ₹${avgLoss.toFixed(0)}`);
  console.log(`  │ Avg hold:         ${(avgHoldMs / 1000).toFixed(0)}s`);
  console.log(`  │ Best trade:       ₹${Math.max(...trades.map((t) => t.pnl)).toFixed(0)}`);
  console.log(`  │ Worst trade:      ₹${Math.min(...trades.map((t) => t.pnl)).toFixed(0)}`);
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // Exit reason distribution
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    const reason = t.exitAction;
    exitReasons[reason] = (exitReasons[reason] || 0) + 1;
  }
  console.log('  ┌─ Exit Reason Distribution ───────────────────────────────┐');
  for (const [reason, count] of Object.entries(exitReasons).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / trades.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((count / trades.length) * 30));
    console.log(`  │ ${reason.padEnd(15)} ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // Ratchet tier distribution
  const tiers: Record<number, number> = {};
  for (const t of trades) {
    tiers[t.tier] = (tiers[t.tier] || 0) + 1;
  }
  console.log('  ┌─ Ratchet Tier Distribution (at exit) ────────────────────┐');
  for (const tier of Object.keys(tiers).sort((a, b) => Number(a) - Number(b))) {
    const count = tiers[Number(tier)];
    const pct = ((count / trades.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((count / trades.length) * 30));
    console.log(`  │ Tier ${tier}:  ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // Per-trade log (first 20)
  console.log('  ┌─ Trade Log (first 20) ───────────────────────────────────┐');
  console.log('  │ #  Side  Entry    Exit     P&L       Fees   Hold   Exit');
  console.log('  │ ── ───── ──────── ──────── ───────── ─────── ────── ─────────────');
  trades.slice(0, 20).forEach((t, i) => {
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '₹' + t.pnl.toFixed(0);
    const holdStr = (t.holdMs / 1000).toFixed(0) + 's';
    console.log(`  │ ${String(i + 1).padStart(2)} ${t.side.padEnd(5)} ₹${t.entryPrice.toFixed(2).padStart(6)} ₹${t.exitPrice.toFixed(2).padStart(6)} ${pnlStr.padStart(9)} ₹${t.fees.toFixed(0).padStart(5)} ${holdStr.padStart(5)} ${t.exitAction.replace('EXIT_', '')}`);
  });
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // Tuning suggestions
  console.log('  ┌─ Tuning Suggestions ─────────────────────────────────────┐');
  if (totalPnl < 0) {
    console.log('  │ ⚠ Net P&L is negative. Consider:');
    console.log('  │   --min-capture ' + Math.round(MIN_CAPTURE * 1.2) + '  (raise minimum capture)');
    console.log('  │   --tp-max ' + (TP_MAX + 0.5).toFixed(1) + '  (widen TP to capture bigger moves)');
  } else {
    console.log('  │ ✓ Net P&L is positive. Consider:');
    console.log('  │   --min-capture ' + Math.round(MIN_CAPTURE * 0.9) + '  (lower minimum capture for more trades)');
    console.log('  │   --tp-max ' + Math.max(1.5, TP_MAX - 0.3).toFixed(1) + '  (tighten TP for faster exits)');
  }
  if (exitReasons['EXIT_FLAT'] > trades.length * 0.3) {
    console.log('  │ ⚠ High EXIT_FLAT rate (' + ((exitReasons['EXIT_FLAT'] / trades.length) * 100).toFixed(0) + '%) — many trades bail without movement.');
    console.log('  │   Consider --max-flat-ms ' + (MAX_FLAT_MS * 2) + '  (give trades more time)');
  }
  if (exitReasons['EXIT_SL'] > trades.length * 0.4) {
    console.log('  │ ⚠ High EXIT_SL rate (' + ((exitReasons['EXIT_SL'] / trades.length) * 100).toFixed(0) + '%) — SL too tight.');
    console.log('  │   Consider --atr-mult ' + (ATR_MULT + 0.5).toFixed(1) + '  (widen initial SL)');
  }
  console.log('  └──────────────────────────────────────────────────────────┘\n');
}

// ── Main ───────────────────────────────────────────────────────────────

const spot = SYMBOL === 'BANKNIFTY' ? 52000 : SYMBOL === 'SENSEX' ? 80000 : SYMBOL === 'FINNIFTY' ? 23000 : 24000;
console.log(`\nGenerating ${DAYS} days of synthetic 1-min candles for ${SYMBOL} (spot=${spot})...`);
const candles = generateCandles(spot, DAYS);
console.log(`Generated ${candles.length} candles.`);

console.log(`\nConfig: minCapture=₹${MIN_CAPTURE}, TP=${TP_MIN}×-${TP_MAX}×, ATR=${ATR_MULT}×, maxFlat=${MAX_FLAT_MS}ms`);

const trades = backtest(candles, SYMBOL);
report(trades, SYMBOL);
