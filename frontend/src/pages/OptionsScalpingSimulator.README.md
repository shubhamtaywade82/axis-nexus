# Options Scalping Simulator

A standalone React component that simulates the **fee-aware, both-side ratchet scalping strategy** with real-time Chart.js visualization.

## What it does

The simulator runs the **exact same exit policy** as the backend (`src/services/scalpExitPolicy.ts`) against synthetic tick data, so you can:

- **Visualize** the both-side ratchet behavior (trailing SL, profit floor, dynamic TP) in real time
- **Tune** the ratchet schedule, TP multiplier, ATR multiple, and fee parameters — see the effect immediately
- **Run 100-trade batch simulations** to measure win rate, profit factor, and P&L distribution
- **Understand** how the trailing SL ratchets up while the profit floor converges — the two-sided exit that prevents giving back more than the ratchet allows

## Files

| File | Description |
|---|---|
| `OptionsScalpingSimulator.tsx` | The React component (TypeScript) |
| `OptionsScalpingSimulator.css` | Styling (dark theme, responsive) |

## Install

```bash
cd frontend
npm install chart.js react-chartjs-2
```

## Use

```tsx
import { OptionsScalpingSimulator } from './pages/OptionsScalpingSimulator';

export default function App() {
  return <OptionsScalpingSimulator />;
}
```

### With custom config

```tsx
import { OptionsScalpingSimulator } from './pages/OptionsScalpingSimulator';

const customConfig = {
  minCapturePerLot: 150,
  targetMultiplier: { min: 2, max: 3.5 },
  lotSize: 30, // BANKNIFTY
};

export default function App() {
  return <OptionsScalpingSimulator initialConfig={customConfig} />;
}
```

### With exit callback

```tsx
import { OptionsScalpingSimulator } from './pages/OptionsScalpingSimulator';

function handleExit(record) {
  console.log('Trade exited:', record.pnl, record.exitAction);
}

export default function App() {
  return <OptionsScalpingSimulator onTradeExit={handleExit} />;
}
```

## Features

### Single-trade mode
- Real-time price chart with overlayed trailing SL (red dashed), profit floor (green dashed), and TP (blue dashed)
- Live trade state: entry, current, peak, R-multiple, active tier, P&L (net of fees)
- Speed control (50ms–1000ms per tick)
- Volatility control (0.1%–2%)

### 100-trade batch mode
- Runs 100 simulated trades synchronously
- Progress bar
- P&L distribution bar chart (green = win, red = loss)
- Aggregate stats: net P&L, win rate, profit factor, avg win, avg loss, total fees, best/worst trade

### Exit history table
- Last 30 trades with: side, entry, exit, P&L, fees, peak R, tier, exit reason

### Config editor
- Live-tunable: min capture per lot, TP multiplier range, ATR multiple, lot size, max flat hold
- Ratchet schedule table (5 tiers: 0R → 2R+)

## Architecture

The simulator is a **pure frontend component** — no backend required. It ports the exact same logic from:

| Backend file | Simulator equivalent |
|---|---|
| `src/services/scalpExitPolicy.ts` | `evaluateExit()` in the component |
| `src/services/feeModel.ts` | `calculateRoundTripFees()` in the component |
| `src/services/scalpConfig.ts` | `DEFAULT_CONFIG` in the component |

### Why port instead of import?

The backend files are TypeScript modules that import `pg`, `ioredis`, and other Node-only deps. The frontend can't import them directly. The ported copy is deliberately kept in sync — if you change the backend ratchet, update the ported copy here too.

### Live vs. simulation

The simulator uses **synthetic ticks** (geometric Brownian motion). The backend uses **live DhanHQ WS ticks**. Both run through the same `evaluateExit()` logic, so the simulator's behavior matches what the live system would do.

```
SIMULATION MODE                    LIVE MODE
    │                                 │
    ▼                                 ▼
Synthetic ticks                   DhanHQ WS ticks
    │                                 │
    ▼                                 ▼
evaluateExit()  ◄── same logic ──► evaluateExit()
    │                                 │
    ▼                                 ▼
Chart.js visualization             Real order execution
```

## Fee model

The simulator uses the same NSE/BSE fee calculator as the backend:

| Charge | Formula |
|---|---|
| Brokerage | ₹20 × 2 (entry + exit) |
| STT | 0.05% of premium × qty (sell side) |
| Exchange txn | 0.05% of turnover |
| Stamp duty | 0.003% (buy side, capped at ₹600) |
| GST | 18% of (brokerage + exchange + SEBI) |
| SEBI | ₹10 per crore |

**Round-trip cost for a typical NIFTY ATM scalp (₹100 premium, 75 qty): ~₹56**

## Ratchet schedule

The both-side ratchet has 5 tiers. As peak profit grows (measured in R-multiples of initial risk), the SL tightens AND the profit floor rises:

| Tier | Peak R | SL Trail % | Floor R | Giveback % |
|---|---|---|---|---|
| 0 | 0R | 8.0% | 0 | 100% |
| 1 | 0.5R | 7.0% | 0.25R | 75% |
| 2 | 1.0R | 5.0% | 0.50R | 50% |
| 3 | 1.5R | 4.0% | 0.70R | 30% |
| 4 | 2.0R+ | 3.0% | 0.85R | 15% |

At 2R, you lock 85% of peak profit and only allow 15% giveback.

## Exit priority

1. **EXIT_SL** — trailing stop-loss hit (hard stop)
2. **EXIT_FLOOR** — profit floor / giveback limit hit
3. **EXIT_MOMENTUM** — underlying momentum reversed (5% chance per tick after 10 ticks)
4. **EXIT_FLAT** — fee-aware bailout (held > 5 min without exceeding fees)
5. **EXIT_TP** — dynamic take-profit hit

## Integration with the live system

The simulator is wired into the frontend at `/#scalp-simulator`. The live Scalp Monitor is at `/#scalp-monitor`. Both share the same ratchet logic — the simulator is for **tuning and visualization**, the monitor is for **real-time position tracking**.

To enable the live scalp engine:
```bash
echo "SCALP_ENABLED=true" >> .env
npm run dev:server
```
