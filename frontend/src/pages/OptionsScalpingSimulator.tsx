/**
 * Options Scalping Simulator — a standalone React component that runs the
 * same both-side ratchet exit policy as the backend (scalpExitPolicy.ts)
 * against synthetic tick data, with real-time Chart.js visualization.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The backend ScalpPositionManager runs against live DhanHQ ticks. This
 * simulator lets you:
 *   - Visualize the ratchet behavior without a live market
 *   - Tune the ratchet schedule / TP multiplier / ATR multiple and see
 *     the effect immediately
 *   - Run 100-trade batch simulations to measure win rate, profit factor,
 *     and P&L distribution
 *   - Understand how the both-side trailing SL + floor + TP interact
 *
 * ── What it shares with the backend ────────────────────────────────────
 *
 * The ratchet logic, fee model, and config shape are ported directly from:
 *   - src/services/scalpExitPolicy.ts (evaluateScalpExit)
 *   - src/services/feeModel.ts (calculateRoundTripFees)
 *   - src/services/scalpConfig.ts (DEFAULT_SCALP_CONFIG)
 *
 * If you change the backend ratchet, update the ported copy here too.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiRequest } from '../services/api';
import { useBackendStream, type Envelope, type Channel } from '../hooks/useBackendStream';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartData,
  type ChartOptions,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import './OptionsScalpingSimulator.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  Title,
  Tooltip,
  Legend,
  Filler,
);

const SCALP_CHANNELS: Channel[] = ['scalp'];

// ── Types (mirror backend src/services/scalpExitPolicy.ts) ──────────────

interface ScalpRatchetTier {
  peakR: number;
  slTrailPctOfPeak: number;
  floorR: number;
  givebackPct: number;
}

interface ScalpConfig {
  minCapturePerLot: number;
  ratchet: ScalpRatchetTier[];
  targetMultiplier: { min: number; max: number };
  atrMultiple: number;
  maxFlatHoldMs: number;
  minMoveToHold: number;
  lotSize: number;
}

interface TradeState {
  isActive: boolean;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  entryTime: number;
  initialRisk: number;
  quantity: number;
  currentSL: number;
  currentFloor: number;
  currentTP: number;
  rMultiple: number;
  activeTier: number;
  profitSoFar: number;
  peakProfit: number;
  holdMs: number;
  momentumReversed: boolean;
  momentumStrength: number;
}

interface ExitRecord {
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

// ── Live scalp state (mirror of backend ScalpState) ─────────────────────
// Used when the simulator is connected to a running backend with real
// scalp positions. Fetched from GET /api/scalp/positions and updated in
// real-time via the 'scalp' EventBus channel.

interface LiveScalpState {
  positionId: string;
  tradingSymbol: string;
  securityId: string;
  underlying: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  lotSize: number;
  quantity: number;
  underlyingSpot: number;
  underlyingPeak: number;
  delta: number;
  initialRisk: number;
  initialSL: number;
  currentSL: number;
  currentFloor: number;
  currentTP: number;
  entryTime: number;
  holdMs: number;
  rMultiple: number;
  activeTier: number;
  givebackUsed: number;
  feesPerLot: number;
  breakevenPrice: number;
  profitSoFar: number;
  peakProfit: number;
  momentumReversed: boolean;
  momentumStrength: number;
}

// ── Default config (mirror of backend DEFAULT_SCALP_CONFIG) ─────────────

const DEFAULT_CONFIG: ScalpConfig = {
  minCapturePerLot: 130,
  ratchet: [
    { peakR: 0,   slTrailPctOfPeak: 8.0, floorR: 0,    givebackPct: 1.0 },
    { peakR: 0.5, slTrailPctOfPeak: 7.0, floorR: 0.25, givebackPct: 0.75 },
    { peakR: 1.0, slTrailPctOfPeak: 5.0, floorR: 0.50, givebackPct: 0.50 },
    { peakR: 1.5, slTrailPctOfPeak: 4.0, floorR: 0.70, givebackPct: 0.30 },
    { peakR: 2.0, slTrailPctOfPeak: 3.0, floorR: 0.85, givebackPct: 0.15 },
  ],
  targetMultiplier: { min: 1.5, max: 3.0 },
  atrMultiple: 1.5,
  maxFlatHoldMs: 5 * 60 * 1000,
  minMoveToHold: 130,
  lotSize: 75,
};

// ── Fee calculator (mirror of backend feeModel.ts) ──────────────────────

function calculateRoundTripFees(premium: number, qty: number): number {
  const turnover = premium * qty;
  const brokerage = 20 * 2;
  const stt = turnover * 0.0005;
  const exchangeTxn = turnover * 0.0005;
  const stampDuty = Math.min(turnover * 0.00003, 600);
  const sebi = turnover * 0.000001;
  const gst = (brokerage + exchangeTxn + sebi) * 0.18;
  return Math.ceil(brokerage + stt + exchangeTxn + stampDuty + sebi + gst);
}

// ── Exit policy (mirror of backend scalpExitPolicy.ts) ──────────────────

type ExitAction = 'HOLD' | 'EXIT_SL' | 'EXIT_FLOOR' | 'EXIT_TP' | 'EXIT_FLAT' | 'EXIT_MOMENTUM';

interface ExitDecision {
  action: ExitAction;
  reason: string;
  exitPrice?: number;
  state: TradeState;
}

function evaluateExit(state: TradeState, config: ScalpConfig, now: number): ExitDecision {
  const { entryPrice, currentPrice, peakPrice, initialRisk, side } = state;
  const isLong = side === 'LONG';
  const profit = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const peakProfit = isLong ? peakPrice - entryPrice : entryPrice - peakPrice;
  const rMultiple = initialRisk > 0 ? peakProfit / initialRisk : 0;

  // Find active ratchet tier
  const tiers = [...config.ratchet].sort((a, b) => b.peakR - a.peakR);
  const tier = tiers.find((t) => rMultiple >= t.peakR) || config.ratchet[0]!;
  const activeTier = config.ratchet.indexOf(tier);

  // Calculate both-side trailing levels
  const slTrailDistance = peakPrice * (tier.slTrailPctOfPeak / 100);
  const trailingSL = isLong ? peakPrice - slTrailDistance : peakPrice + slTrailDistance;

  const floorProfit = initialRisk * tier.floorR;
  const profitFloor = isLong ? entryPrice + floorProfit : entryPrice - floorProfit;
  const givebackAmount = peakProfit * tier.givebackPct;
  const givebackLimit = isLong ? peakPrice - givebackAmount : peakPrice + givebackAmount;
  const effectiveFloor = isLong
    ? Math.max(profitFloor, givebackLimit)
    : Math.min(profitFloor, givebackLimit);

  // Dynamic TP
  const momentumStrength = Math.min(1, rMultiple / 2);
  const targetMultiplier = config.targetMultiplier.min +
    (config.targetMultiplier.max - config.targetMultiplier.min) * momentumStrength;
  const targetProfit = config.minCapturePerLot * targetMultiplier;
  const targetPrice = isLong
    ? entryPrice + targetProfit / config.lotSize
    : entryPrice - targetProfit / config.lotSize;

  const updatedState: TradeState = {
    ...state,
    currentSL: trailingSL,
    currentFloor: effectiveFloor,
    currentTP: targetPrice,
    rMultiple,
    activeTier,
    holdMs: now - state.entryTime,
    profitSoFar: profit * state.quantity - calculateRoundTripFees(entryPrice, state.quantity),
    peakProfit: peakProfit * state.quantity - calculateRoundTripFees(entryPrice, state.quantity),
    momentumStrength,
  };

  const totalProfit = profit * state.quantity;

  // Exit checks (priority order)
  if (isLong ? currentPrice <= trailingSL : currentPrice >= trailingSL) {
    return { action: 'EXIT_SL', reason: `Trailing SL hit at ₹${trailingSL.toFixed(2)} (tier ${activeTier}: ${tier.peakR}R)`, exitPrice: currentPrice, state: updatedState };
  }
  if (profit > 0 && (isLong ? currentPrice <= effectiveFloor : currentPrice >= effectiveFloor)) {
    return { action: 'EXIT_FLOOR', reason: `Floor exit at ₹${effectiveFloor.toFixed(2)} (locked ${tier.floorR}R)`, exitPrice: currentPrice, state: updatedState };
  }
  if (state.momentumReversed && totalProfit > config.minCapturePerLot) {
    return { action: 'EXIT_MOMENTUM', reason: 'Momentum reversed — exit with profit', exitPrice: currentPrice, state: updatedState };
  }
  const holdMs = now - state.entryTime;
  if (holdMs > config.maxFlatHoldMs && totalProfit < config.minMoveToHold) {
    return { action: 'EXIT_FLAT', reason: `Held ${Math.round(holdMs / 1000)}s without movement — bailout`, exitPrice: currentPrice, state: updatedState };
  }
  if (isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice) {
    return { action: 'EXIT_TP', reason: `TP hit at ₹${targetPrice.toFixed(2)} (${targetMultiplier.toFixed(1)}× fees)`, exitPrice: currentPrice, state: updatedState };
  }

  return { action: 'HOLD', reason: `${rMultiple.toFixed(2)}R peak | SL ₹${trailingSL.toFixed(2)} | floor ₹${effectiveFloor.toFixed(2)} | TP ₹${targetPrice.toFixed(2)}`, state: updatedState };
}

// ── Main component ──────────────────────────────────────────────────────

function generateTick(prevPrice: number, volatility: number, drift: number): number {
  const change = drift + volatility * (Math.random() - 0.5) * 2;
  return Math.max(1, prevPrice * (1 + change));
}

function generateEntryPrice(spot: number): number {
  // Option premium ≈ 0.4% of spot (ATM-ish)
  return spot * 0.004 * (0.9 + Math.random() * 0.2);
}

// ── Main component ──────────────────────────────────────────────────────

export interface OptionsScalpingSimulatorProps {
  /** Initial config — defaults to DEFAULT_CONFIG. */
  initialConfig?: Partial<ScalpConfig>;
  /** Called when a trade exits — useful for parent dashboards. */
  onTradeExit?: (record: ExitRecord) => void;
  /** className for the root container. */
  className?: string;
}

export function OptionsScalpingSimulator({
  initialConfig,
  onTradeExit,
  className = '',
}: OptionsScalpingSimulatorProps) {
  const [config, setConfig] = useState<ScalpConfig>({ ...DEFAULT_CONFIG, ...initialConfig });
  const [isRunning, setIsRunning] = useState(false);
  const [speed, setSpeed] = useState(200); // ms per tick
  const [volatility, setVolatility] = useState(0.003);
  const [mode, setMode] = useState<'live' | 'single' | 'batch'>('live');

  // ── Live mode state ───────────────────────────────────────────────────
  // Real scalp positions fetched from /api/scalp/positions and updated
  // in real-time via the 'scalp' WS channel. Per-position price/SL/floor/
  // TP history is accumulated from WS ticks so the Chart.js visualization
  // works identically for live and simulated data.
  const [livePositions, setLivePositions] = useState<LiveScalpState[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [livePriceHistory, setLivePriceHistory] = useState<Record<string, number[]>>({});
  const [liveSlHistory, setLiveSlHistory] = useState<Record<string, number[]>>({});
  const [liveFloorHistory, setLiveFloorHistory] = useState<Record<string, number[]>>({});
  const [liveTpHistory, setLiveTpHistory] = useState<Record<string, number[]>>({});
  const [liveExitHistory, setLiveExitHistory] = useState<ExitRecord[]>([]);
  const [backendConnected, setBackendConnected] = useState(false);
  const liveHistoryRef = useRef<{
    price: Record<string, number[]>;
    sl: Record<string, number[]>;
    floor: Record<string, number[]>;
    tp: Record<string, number[]>;
  }>({ price: {}, sl: {}, floor: {}, tp: {} });

  // Single-trade state
  const [tradeState, setTradeState] = useState<TradeState | null>(null);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [slHistory, setSlHistory] = useState<number[]>([]);
  const [floorHistory, setFloorHistory] = useState<number[]>([]);
  const [tpHistory, setTpHistory] = useState<number[]>([]);

  // Batch state
  const [batchResults, setBatchResults] = useState<ExitRecord[]>([]);
  const [batchProgress, setBatchProgress] = useState(0);

  // Exit history (shared)
  const [exitHistory, setExitHistory] = useState<ExitRecord[]>([]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickCountRef = useRef(0);

  // ── Live mode: fetch real positions + subscribe to WS ─────────────────

  const refreshLive = useCallback(async () => {
    try {
      const [posRes, histRes] = await Promise.all([
        apiRequest<{ positions: LiveScalpState[] }>('/api/scalp/positions').catch(() => ({ positions: [] })),
        apiRequest<{ history: ExitRecord[] }>('/api/scalp/history').catch(() => ({ history: [] })),
      ]);
      setLivePositions(posRes.positions || []);
      setLiveExitHistory(histRes.history || []);
      setBackendConnected(true);
      // Auto-select the first position if none is selected
      if (posRes.positions && posRes.positions.length > 0 && !selectedPositionId) {
        setSelectedPositionId(posRes.positions[0]!.positionId);
      }
      // Clear selection if the selected position is no longer open
      if (selectedPositionId && posRes.positions && !posRes.positions.some((p) => p.positionId === selectedPositionId)) {
        const first = posRes.positions[0];
        setSelectedPositionId(first ? first.positionId : null);
      }
    } catch {
      setBackendConnected(false);
    }
  }, [selectedPositionId]);

  // Poll for live positions when in live mode (fallback for when WS is not
  // connected — the WS subscription below handles real-time updates)
  useEffect(() => {
    if (mode !== 'live') return;
    refreshLive();
    const interval = setInterval(refreshLive, 5000);
    return () => clearInterval(interval);
  }, [mode, refreshLive]);

  // Subscribe to the 'scalp' WS channel for real-time position updates
  useBackendStream(useCallback((env: Envelope) => {
    if (env.channel !== 'scalp' || mode !== 'live') return;
    const p = env.payload || {};
    const hist = liveHistoryRef.current;

    switch (p.type) {
      case 'tick': {
        // Update all open positions + accumulate per-position chart history
        const positions: LiveScalpState[] = p.positions || [];
        setLivePositions(positions);
        setBackendConnected(true);
        for (const pos of positions) {
          const id = pos.positionId;
          hist.price[id] = [...(hist.price[id] || []), pos.currentPrice].slice(-100);
          hist.sl[id] = [...(hist.sl[id] || []), pos.currentSL].slice(-100);
          hist.floor[id] = [...(hist.floor[id] || []), pos.currentFloor].slice(-100);
          hist.tp[id] = [...(hist.tp[id] || []), pos.currentTP].slice(-100);
        }
        setLivePriceHistory({ ...hist.price });
        setLiveSlHistory({ ...hist.sl });
        setLiveFloorHistory({ ...hist.floor });
        setLiveTpHistory({ ...hist.tp });
        break;
      }
      case 'entry': {
        // New position opened — add it to the list
        if (p.position) {
          setLivePositions((prev) => [...prev.filter((x) => x.positionId !== p.position.positionId), p.position]);
          if (!selectedPositionId) setSelectedPositionId(p.position.positionId);
        }
        break;
      }
      case 'exit': {
        // Position closed — remove from open list, refresh history
        setLivePositions((prev) => prev.filter((x) => x.positionId !== p.position?.positionId));
        // Clear history for the closed position
        if (p.position?.positionId) {
          const id = p.position.positionId;
          delete hist.price[id];
          delete hist.sl[id];
          delete hist.floor[id];
          delete hist.tp[id];
        }
        // Add to exit history
        if (p.position && p.decision) {
          const record: ExitRecord = {
            entryPrice: p.position.entryPrice,
            exitPrice: p.decision.exitPrice ?? p.position.currentPrice,
            peakPrice: p.position.peakPrice,
            side: p.position.side,
            pnl: p.pnl ?? 0,
            fees: p.fees ?? 0,
            holdMs: p.position.holdMs,
            exitAction: p.decision.action,
            exitReason: p.decision.reason,
            peakR: p.position.rMultiple,
            tier: p.position.activeTier,
          };
          setLiveExitHistory((prev) => [record, ...prev].slice(0, 100));
          onTradeExit?.(record);
        }
        break;
      }
    }
  }, [mode, selectedPositionId, onTradeExit]), SCALP_CHANNELS);

  // ── Start a single trade ──────────────────────────────────────────────

  const startSingleTrade = useCallback(() => {
    const entryPrice = generateEntryPrice(24000);
    const initialSL = entryPrice * (1 - 0.08); // 8% initial SL
    const initialRisk = entryPrice - initialSL;
    const fees = calculateRoundTripFees(entryPrice, config.lotSize);

    const state: TradeState = {
      isActive: true,
      side: Math.random() > 0.5 ? 'LONG' : 'SHORT',
      entryPrice,
      currentPrice: entryPrice,
      peakPrice: entryPrice,
      entryTime: Date.now(),
      initialRisk,
      quantity: config.lotSize,
      currentSL: initialSL,
      currentFloor: entryPrice,
      currentTP: entryPrice + (config.minCapturePerLot * 2) / config.lotSize,
      rMultiple: 0,
      activeTier: 0,
      profitSoFar: -fees,
      peakProfit: -fees,
      holdMs: 0,
      momentumReversed: false,
      momentumStrength: 0,
    };

    setTradeState(state);
    setPriceHistory([entryPrice]);
    setSlHistory([initialSL]);
    setFloorHistory([entryPrice]);
    setTpHistory([state.currentTP]);
    tickCountRef.current = 0;
    setIsRunning(true);
  }, [config]);

  // ── Tick loop ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isRunning || !tradeState) return;

    intervalRef.current = setInterval(() => {
      setTradeState((prev) => {
        if (!prev || !prev.isActive) return prev;

        // Generate next tick
        const drift = (Math.random() - 0.5) * 0.001;
        const newPrice = generateTick(prev.currentPrice, volatility, drift);
        tickCountRef.current++;

        // Update peak
        let newPeak = prev.peakPrice;
        if (prev.side === 'LONG' && newPrice > newPeak) newPeak = newPrice;
        if (prev.side === 'SHORT' && (newPrice < newPeak || newPeak === prev.entryPrice)) newPeak = newPrice;

        // Random momentum reversal (5% chance after 10 ticks)
        const momentumReversed = tickCountRef.current > 10 && Math.random() < 0.05;

        const updated: TradeState = {
          ...prev,
          currentPrice: newPrice,
          peakPrice: newPeak,
          momentumReversed,
        };

        // Evaluate exit
        const decision = evaluateExit(updated, config, Date.now());

        // Update history
        setPriceHistory((h) => [...h.slice(-99), newPrice]);
        setSlHistory((h) => [...h.slice(-99), decision.state.currentSL]);
        setFloorHistory((h) => [...h.slice(-99), decision.state.currentFloor]);
        setTpHistory((h) => [...h.slice(-99), decision.state.currentTP]);

        if (decision.action !== 'HOLD') {
          // Trade exited
          const exitPrice = decision.exitPrice ?? newPrice;
          const fees = calculateRoundTripFees(prev.entryPrice, config.lotSize);
          const grossPnl = prev.side === 'LONG'
            ? (exitPrice - prev.entryPrice) * config.lotSize
            : (prev.entryPrice - exitPrice) * config.lotSize;
          const netPnl = grossPnl - fees;

          const record: ExitRecord = {
            entryPrice: prev.entryPrice,
            exitPrice,
            peakPrice: newPeak,
            side: prev.side,
            pnl: netPnl,
            fees,
            holdMs: Date.now() - prev.entryTime,
            exitAction: decision.action,
            exitReason: decision.reason,
            peakR: decision.state.rMultiple,
            tier: decision.state.activeTier,
          };

          setExitHistory((h) => [record, ...h].slice(0, 100));
          onTradeExit?.(record);

          setIsRunning(false);
          return { ...decision.state, isActive: false };
        }

        return decision.state as TradeState;
      });
    }, speed);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, tradeState, speed, volatility, config, onTradeExit]);

  // ── Batch simulation (100 trades) ─────────────────────────────────────

  const runBatch = useCallback(async () => {
    setBatchResults([]);
    setBatchProgress(0);
    const results: ExitRecord[] = [];

    for (let i = 0; i < 100; i++) {
      // Simulate one trade synchronously
      const entryPrice = generateEntryPrice(24000);
      const initialSL = entryPrice * (1 - 0.08);
      const initialRisk = entryPrice - initialSL;
      const fees = calculateRoundTripFees(entryPrice, config.lotSize);
      const side: 'LONG' | 'SHORT' = Math.random() > 0.5 ? 'LONG' : 'SHORT';

      let state: TradeState = {
        isActive: true,
        side,
        entryPrice,
        currentPrice: entryPrice,
        peakPrice: entryPrice,
        entryTime: Date.now() - 600000, // simulate 10 min ago
        initialRisk,
        quantity: config.lotSize,
        currentSL: initialSL,
        currentFloor: entryPrice,
        currentTP: entryPrice + (config.minCapturePerLot * 2) / config.lotSize,
        rMultiple: 0,
        activeTier: 0,
        profitSoFar: -fees,
        peakProfit: -fees,
        holdMs: 0,
        momentumReversed: false,
        momentumStrength: 0,
      };

      let exited = false;
      let tickCount = 0;

      while (!exited && tickCount < 500) {
        const drift = (Math.random() - 0.5) * 0.001;
        const newPrice = generateTick(state.currentPrice, volatility, drift);
        tickCount++;

        let newPeak = state.peakPrice;
        if (side === 'LONG' && newPrice > newPeak) newPeak = newPrice;
        if (side === 'SHORT' && (newPrice < newPeak || newPeak === entryPrice)) newPeak = newPrice;

        state = {
          ...state,
          currentPrice: newPrice,
          peakPrice: newPeak,
          momentumReversed: tickCount > 10 && Math.random() < 0.05,
        };

        const decision = evaluateExit(state, config, Date.now());
        state = decision.state as TradeState;

        if (decision.action !== 'HOLD') {
          const exitPrice = decision.exitPrice ?? newPrice;
          const grossPnl = side === 'LONG'
            ? (exitPrice - entryPrice) * config.lotSize
            : (entryPrice - exitPrice) * config.lotSize;
          results.push({
            entryPrice,
            exitPrice,
            peakPrice: newPeak,
            side,
            pnl: grossPnl - fees,
            fees,
            holdMs: tickCount * speed,
            exitAction: decision.action,
            exitReason: decision.reason,
            peakR: decision.state.rMultiple,
            tier: decision.state.activeTier,
          });
          exited = true;
        }
      }

      setBatchProgress(i + 1);
      // Yield to UI
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    setBatchResults(results);
    setExitHistory(results);
  }, [config, volatility, speed]);

  // ── Stats ─────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const trades = exitHistory;
    if (trades.length === 0) return null;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalFees = trades.reduce((s, t) => s + t.fees, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / trades.length) * 100,
      netPnl: totalPnl,
      totalFees,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
      avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      bestTrade: Math.max(...trades.map((t) => t.pnl)),
      worstTrade: Math.min(...trades.map((t) => t.pnl)),
    };
  }, [exitHistory]);

  // ── Chart data ────────────────────────────────────────────────────────

  const lineChartData: ChartData<'line'> = useMemo(() => {
    const labels = priceHistory.map((_, i) => i.toString());
    return {
      labels,
      datasets: [
        {
          label: 'Price',
          data: priceHistory,
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251, 191, 36, 0.1)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
        },
        {
          label: 'Trailing SL',
          data: slHistory,
          borderColor: '#ef4444',
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Floor',
          data: floorHistory,
          borderColor: '#22c55e',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'TP',
          data: tpHistory,
          borderColor: '#3b82f6',
          borderWidth: 1,
          borderDash: [2, 2],
          pointRadius: 0,
          fill: false,
        },
      ],
    };
  }, [priceHistory, slHistory, floorHistory, tpHistory]);

  // ── Live mode chart data (real position) ──────────────────────────────

  const selectedLivePosition = useMemo(() => {
    if (!selectedPositionId || livePositions.length === 0) return null;
    return livePositions.find((p) => p.positionId === selectedPositionId) ?? null;
  }, [selectedPositionId, livePositions]);

  const liveLineChartData: ChartData<'line'> = useMemo(() => {
    if (!selectedPositionId) return { labels: [], datasets: [] };
    const prices = livePriceHistory[selectedPositionId] || [];
    const sls = liveSlHistory[selectedPositionId] || [];
    const floors = liveFloorHistory[selectedPositionId] || [];
    const tps = liveTpHistory[selectedPositionId] || [];
    const labels = prices.map((_, i) => i.toString());
    return {
      labels,
      datasets: [
        { label: 'Price', data: prices, borderColor: '#fbbf24', backgroundColor: 'rgba(251, 191, 36, 0.1)', borderWidth: 2, pointRadius: 0, fill: true },
        { label: 'Trailing SL', data: sls, borderColor: '#ef4444', borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false },
        { label: 'Floor', data: floors, borderColor: '#22c55e', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false },
        { label: 'TP', data: tps, borderColor: '#3b82f6', borderWidth: 1, borderDash: [2, 2], pointRadius: 0, fill: false },
      ],
    };
  }, [selectedPositionId, livePriceHistory, liveSlHistory, liveFloorHistory, liveTpHistory]);

  // Live stats (from real exit history)
  const liveStats = useMemo(() => {
    const trades = liveExitHistory;
    if (trades.length === 0) return null;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalFees = trades.reduce((s, t) => s + t.fees, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / trades.length) * 100,
      netPnl: totalPnl,
      totalFees,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
      avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      bestTrade: Math.max(...trades.map((t) => t.pnl)),
      worstTrade: Math.min(...trades.map((t) => t.pnl)),
    };
  }, [liveExitHistory]);

  const livePnlChartData: ChartData<'bar'> = useMemo(() => {
    const trades = liveExitHistory.slice(0, 50).reverse();
    return {
      labels: trades.map((_, i) => `#${i + 1}`),
      datasets: [{
        label: 'P&L',
        data: trades.map((t) => t.pnl),
        backgroundColor: trades.map((t) => t.pnl >= 0 ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
        borderColor: trades.map((t) => t.pnl >= 0 ? '#22c55e' : '#ef4444'),
        borderWidth: 1,
      }],
    };
  }, [liveExitHistory]);

  const lineChartOptions: ChartOptions<'line'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
      legend: { labels: { color: '#9ca3af', font: { size: 11 } } },
      tooltip: { mode: 'index', intersect: false },
    },
    scales: {
      x: { display: false },
      y: {
        ticks: { color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(75, 85, 99, 0.2)' },
      },
    },
  }), []);

  const pnlChartData: ChartData<'bar'> = useMemo(() => {
    const trades = (mode === 'batch' ? batchResults : exitHistory).slice(0, 50).reverse();
    return {
      labels: trades.map((_, i) => `#${i + 1}`),
      datasets: [{
        label: 'P&L',
        data: trades.map((t) => t.pnl),
        backgroundColor: trades.map((t) => t.pnl >= 0 ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
        borderColor: trades.map((t) => t.pnl >= 0 ? '#22c55e' : '#ef4444'),
        borderWidth: 1,
      }],
    };
  }, [exitHistory, batchResults, mode]);

  const pnlChartOptions: ChartOptions<'bar'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#6b7280', font: { size: 9 } }, grid: { display: false } },
      y: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(75, 85, 99, 0.2)' } },
    },
  }), []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className={`scalp-simulator ${className}`}>
      <div className="sim-header">
        <h2>Options Scalping Simulator</h2>
        <div className="sim-mode-toggle">
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>Live Positions</button>
          <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>Simulate</button>
          <button className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}>Batch (100)</button>
        </div>
      </div>

      {/* ── LIVE MODE: real active positions from the backend ──────────── */}
      {mode === 'live' && (
        <>
          <div className="sim-live-status">
            <span className={`sim-conn-dot ${backendConnected ? 'connected' : 'disconnected'}`} />
            <span>{backendConnected ? 'Backend connected' : 'Backend unreachable — start with npm run dev:server'}</span>
            {livePositions.length > 0 && (
              <span className="sim-pos-count">{livePositions.length} active position{livePositions.length > 1 ? 's' : ''}</span>
            )}
          </div>

          {/* Position selector (if multiple) */}
          {livePositions.length > 1 && (
            <div className="sim-pos-selector">
              <label>Select position: </label>
              <select value={selectedPositionId ?? ''} onChange={(e) => setSelectedPositionId(e.target.value)}>
                {livePositions.map((p) => (
                  <option key={p.positionId} value={p.positionId}>
                    {p.tradingSymbol} — {p.side} @ ₹{p.entryPrice.toFixed(2)} (R: {p.rMultiple.toFixed(1)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* No active positions */}
          {livePositions.length === 0 && backendConnected && (
            <div className="sim-empty">
              <p>No active scalp positions right now.</p>
              <p>The scalp scanner will open positions here when it finds momentum setups that pass the fee-aware entry gates.</p>
              <p className="sim-empty-hint">
                To enable: set <code>SCALP_ENABLED=true</code> in .env and restart the backend.<br/>
                Or switch to <strong>Simulate</strong> mode to see how the ratchet works with synthetic data.
              </p>
            </div>
          )}

          {/* Live position state + chart */}
          {selectedLivePosition && (
            <>
              <div className="sim-trade-state live">
                <div className="sim-state-row">
                  <span className={`sim-side ${selectedLivePosition.side}`}>{selectedLivePosition.side}</span>
                  <span className="sim-symbol">{selectedLivePosition.tradingSymbol}</span>
                  {selectedLivePosition.momentumReversed && (
                    <span className="sim-warn">⚠ MOMENTUM REVERSED</span>
                  )}
                </div>
                <div className="sim-state-row">
                  <span>Entry: ₹{selectedLivePosition.entryPrice.toFixed(2)}</span>
                  <span>Current: ₹{selectedLivePosition.currentPrice.toFixed(2)}</span>
                  <span>Peak: ₹{selectedLivePosition.peakPrice.toFixed(2)}</span>
                  <span className={selectedLivePosition.profitSoFar >= 0 ? 'profit' : 'loss'}>
                    P&L: ₹{selectedLivePosition.profitSoFar.toFixed(0)}
                  </span>
                </div>
                <div className="sim-state-row">
                  <span>R: {selectedLivePosition.rMultiple.toFixed(2)}R</span>
                  <span>Tier: {selectedLivePosition.activeTier}</span>
                  <span>SL: ₹{selectedLivePosition.currentSL.toFixed(2)}</span>
                  <span>Floor: ₹{selectedLivePosition.currentFloor.toFixed(2)}</span>
                  <span>TP: ₹{selectedLivePosition.currentTP.toFixed(2)}</span>
                </div>
                <div className="sim-state-row">
                  <span>Δ: {selectedLivePosition.delta.toFixed(2)}</span>
                  <span>Spot: ₹{selectedLivePosition.underlyingSpot.toFixed(0)}</span>
                  <span>BE: ₹{selectedLivePosition.breakevenPrice.toFixed(2)}</span>
                  <span>Hold: {(selectedLivePosition.holdMs / 1000).toFixed(0)}s</span>
                </div>
              </div>

              {/* Live ratchet chart */}
              <div className="sim-chart-container">
                <Line data={liveLineChartData} options={lineChartOptions} />
              </div>
            </>
          )}

          {/* Live stats */}
          {liveStats && (
            <div className="sim-stats">
              <div className="sim-stat"><span className="label">Net P&L</span><span className={`value ${liveStats.netPnl >= 0 ? 'profit' : 'loss'}`}>₹{liveStats.netPnl.toFixed(0)}</span></div>
              <div className="sim-stat"><span className="label">Win Rate</span><span className="value">{liveStats.winRate.toFixed(1)}%</span></div>
              <div className="sim-stat"><span className="label">Trades</span><span className="value">{liveStats.totalTrades}</span></div>
              <div className="sim-stat"><span className="label">Profit Factor</span><span className="value">{isFinite(liveStats.profitFactor) ? liveStats.profitFactor.toFixed(2) : '∞'}</span></div>
              <div className="sim-stat"><span className="label">Avg Win</span><span className="value profit">₹{liveStats.avgWin.toFixed(0)}</span></div>
              <div className="sim-stat"><span className="label">Avg Loss</span><span className="value loss">₹{liveStats.avgLoss.toFixed(0)}</span></div>
              <div className="sim-stat"><span className="label">Fees</span><span className="value">₹{liveStats.totalFees.toFixed(0)}</span></div>
              <div className="sim-stat"><span className="label">Best</span><span className="value profit">₹{liveStats.bestTrade.toFixed(0)}</span></div>
            </div>
          )}

          {/* Live P&L distribution */}
          {liveExitHistory.length > 0 && (
            <div className="sim-chart-container">
              <h3>P&L Distribution (real trades)</h3>
              <Bar data={livePnlChartData} options={pnlChartOptions} />
            </div>
          )}

          {/* Live exit history */}
          {liveExitHistory.length > 0 && (
            <div className="sim-history">
              <h3>Exit History — Real Trades ({liveExitHistory.length})</h3>
              <div className="sim-history-scroll">
                <table>
                  <thead>
                    <tr><th>#</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Fees</th><th>Peak R</th><th>Tier</th><th>Exit</th></tr>
                  </thead>
                  <tbody>
                    {liveExitHistory.slice(0, 30).map((t, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td className={t.side === 'LONG' ? 'long' : 'short'}>{t.side}</td>
                        <td>₹{t.entryPrice.toFixed(2)}</td>
                        <td>₹{t.exitPrice.toFixed(2)}</td>
                        <td className={t.pnl >= 0 ? 'profit' : 'loss'}>₹{t.pnl.toFixed(0)}</td>
                        <td>₹{t.fees.toFixed(0)}</td>
                        <td>{t.peakR.toFixed(1)}R</td>
                        <td>{t.tier}</td>
                        <td>{t.exitAction.replace('EXIT_', '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── SIMULATION MODE ─────────────────────────────────────────────── */}
      {mode !== 'live' && (
        <>
        <div className="sim-controls">
          {mode === 'single' ? (
            <>
              <button className="sim-btn primary" onClick={startSingleTrade} disabled={isRunning}>
                {isRunning ? 'Running…' : 'Start Trade'}
              </button>
              <label>Speed: {speed}ms/tick
                <input type="range" min="50" max="1000" step="50" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
              </label>
              <label>Volatility: {(volatility * 100).toFixed(1)}%
                <input type="range" min="0.001" max="0.02" step="0.001" value={volatility} onChange={(e) => setVolatility(Number(e.target.value))} />
              </label>
            </>
          ) : (
            <>
              <button className="sim-btn primary" onClick={runBatch} disabled={batchProgress > 0 && batchProgress < 100}>
                {batchProgress > 0 && batchProgress < 100 ? `Running… ${batchProgress}/100` : 'Run 100 Trades'}
              </button>
              {batchProgress > 0 && batchProgress < 100 && (
                <div className="sim-progress-bar">
                  <div className="sim-progress-fill" style={{ width: `${batchProgress}%` }} />
                </div>
              )}
            </>
          )}
        </div>

      {/* Live trade state */}
      {tradeState && mode === 'single' && (
        <div className="sim-trade-state">
          <div className="sim-state-row">
            <span className={`sim-side ${tradeState.side}`}>{tradeState.side}</span>
            <span>Entry: ₹{tradeState.entryPrice.toFixed(2)}</span>
            <span>Current: ₹{tradeState.currentPrice.toFixed(2)}</span>
            <span>Peak: ₹{tradeState.peakPrice.toFixed(2)}</span>
            <span className={tradeState.profitSoFar >= 0 ? 'profit' : 'loss'}>
              P&L: ₹{tradeState.profitSoFar.toFixed(0)}
            </span>
          </div>
          <div className="sim-state-row">
            <span>R: {tradeState.rMultiple.toFixed(2)}R</span>
            <span>Tier: {tradeState.activeTier}</span>
            <span>SL: ₹{tradeState.currentSL.toFixed(2)}</span>
            <span>Floor: ₹{tradeState.currentFloor.toFixed(2)}</span>
            <span>TP: ₹{tradeState.currentTP.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Price chart */}
      {mode === 'single' && (
        <div className="sim-chart-container">
          <Line data={lineChartData} options={lineChartOptions} />
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="sim-stats">
          <div className="sim-stat">
            <span className="label">Net P&L</span>
            <span className={`value ${stats.netPnl >= 0 ? 'profit' : 'loss'}`}>₹{stats.netPnl.toFixed(0)}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Win Rate</span>
            <span className="value">{stats.winRate.toFixed(1)}%</span>
          </div>
          <div className="sim-stat">
            <span className="label">Trades</span>
            <span className="value">{stats.totalTrades}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Profit Factor</span>
            <span className="value">{isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Avg Win</span>
            <span className="value profit">₹{stats.avgWin.toFixed(0)}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Avg Loss</span>
            <span className="value loss">₹{stats.avgLoss.toFixed(0)}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Fees</span>
            <span className="value">₹{stats.totalFees.toFixed(0)}</span>
          </div>
          <div className="sim-stat">
            <span className="label">Best</span>
            <span className="value profit">₹{stats.bestTrade.toFixed(0)}</span>
          </div>
        </div>
      )}

      {/* P&L distribution */}
      {exitHistory.length > 0 && (
        <div className="sim-chart-container">
          <h3>P&L Distribution</h3>
          <Bar data={pnlChartData} options={pnlChartOptions} />
        </div>
      )}

      {/* Exit history table */}
      {exitHistory.length > 0 && (
        <div className="sim-history">
          <h3>Exit History ({exitHistory.length})</h3>
          <div className="sim-history-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>P&L</th>
                  <th>Fees</th>
                  <th>Peak R</th>
                  <th>Tier</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody>
                {exitHistory.slice(0, 30).map((t, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className={t.side === 'LONG' ? 'long' : 'short'}>{t.side}</td>
                    <td>₹{t.entryPrice.toFixed(2)}</td>
                    <td>₹{t.exitPrice.toFixed(2)}</td>
                    <td className={t.pnl >= 0 ? 'profit' : 'loss'}>₹{t.pnl.toFixed(0)}</td>
                    <td>₹{t.fees.toFixed(0)}</td>
                    <td>{t.peakR.toFixed(1)}R</td>
                    <td>{t.tier}</td>
                    <td>{t.exitAction.replace('EXIT_', '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Config editor */}
      <details className="sim-config">
        <summary>Configuration (ratchet schedule + fees)</summary>
        <div className="sim-config-grid">
          <label>Min Capture / Lot: ₹<input type="number" value={config.minCapturePerLot} onChange={(e) => setConfig({ ...config, minCapturePerLot: Number(e.target.value) })} /></label>
          <label>TP Min: <input type="number" step="0.1" value={config.targetMultiplier.min} onChange={(e) => setConfig({ ...config, targetMultiplier: { ...config.targetMultiplier, min: Number(e.target.value) } })} />×</label>
          <label>TP Max: <input type="number" step="0.1" value={config.targetMultiplier.max} onChange={(e) => setConfig({ ...config, targetMultiplier: { ...config.targetMultiplier, max: Number(e.target.value) } })} />×</label>
          <label>ATR Multiple: <input type="number" step="0.1" value={config.atrMultiple} onChange={(e) => setConfig({ ...config, atrMultiple: Number(e.target.value) })} />×</label>
          <label>Lot Size: <input type="number" value={config.lotSize} onChange={(e) => setConfig({ ...config, lotSize: Number(e.target.value) })} /></label>
          <label>Max Flat Hold: <input type="number" value={config.maxFlatHoldMs / 1000} onChange={(e) => setConfig({ ...config, maxFlatHoldMs: Number(e.target.value) * 1000 })} />s</label>
        </div>
        <table className="ratchet-table">
          <thead><tr><th>Tier</th><th>Peak R</th><th>SL Trail %</th><th>Floor R</th><th>Giveback %</th></tr></thead>
          <tbody>
            {config.ratchet.map((t, i) => (
              <tr key={i}>
                <td>{i}</td>
                <td>{t.peakR}R</td>
                <td>{t.slTrailPctOfPeak}%</td>
                <td>{t.floorR}R</td>
                <td>{(t.givebackPct * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
        </>
      )}
    </div>
  );
}

export default OptionsScalpingSimulator;
