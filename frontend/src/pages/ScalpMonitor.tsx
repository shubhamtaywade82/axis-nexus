import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/api';
import { useBackendStream, type Envelope } from '../hooks/useBackendStream';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { FlashValue } from '../components/ui/FlashValue';
import { StatusDot } from '../components/ui/StatusDot';

// ── Types (mirror backend src/services/scalpExitPolicy.ts) ──────────────

interface ScalpState {
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

interface ScalpExitRecord {
  positionId: string;
  tradingSymbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  fees: number;
  holdMs: number;
  exitReason: string;
  exitAction: string;
  peakR: number;
  entryTime: number;
  exitTime: number;
}

interface ScalpStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  netPnl: number;
  avgHoldMs: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

interface ScalpConfig {
  minCapturePerLot: number;
  spreadBufferPerLot: number;
  ratchet: Array<{
    peakR: number;
    slTrailPctOfPeak: number;
    floorR: number;
    givebackPct: number;
  }>;
  targetMultiplier: { min: number; max: number };
  useUnderlyingTrail: boolean;
  atrMultiple: number;
  maxFlatHoldMs: number;
  minMoveToHold: number;
  deltaGate: { min: number; max: number };
  maxSpreadPct: number;
  minIvRank: number;
  minVolume: number;
  minExpectedMoveMultiple: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}₹${fmt(n, 0)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pnlColor(n: number): string {
  return n >= 0 ? 'text-green-400' : 'text-red-400';
}

// ── Ratchet visualization bar ───────────────────────────────────────────

function RatchetBar({ state }: { state: ScalpState }) {
  const range = state.currentTP - state.currentSL;
  if (range <= 0) return null;

  const pct = (price: number) => ((price - state.currentSL) / range) * 100;
  const currentPct = Math.max(0, Math.min(100, pct(state.currentPrice)));
  const floorPct = Math.max(0, Math.min(100, pct(state.currentFloor)));
  const entryPct = Math.max(0, Math.min(100, pct(state.entryPrice)));
  const peakPct = Math.max(0, Math.min(100, pct(state.peakPrice)));

  return (
    <div className="space-y-1">
      <div className="relative h-8 bg-gray-800 rounded overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-red-900/50" style={{ width: `${floorPct}%` }} />
        <div className="absolute inset-y-0 bg-green-900/30" style={{ left: `${floorPct}%`, right: 0 }} />
        <div className="absolute inset-y-0 w-0.5 bg-blue-500" style={{ left: `${entryPct}%` }} title={`Entry: ₹${fmt(state.entryPrice)}`} />
        <div className="absolute inset-y-0 w-0.5 bg-purple-400" style={{ left: `${peakPct}%` }} title={`Peak: ₹${fmt(state.peakPrice)}`} />
        <div className="absolute inset-y-0 w-1 bg-yellow-300 shadow-lg" style={{ left: `calc(${currentPct}% - 2px)` }} title={`Current: ₹${fmt(state.currentPrice)}`} />
      </div>
      <div className="flex justify-between text-xs text-gray-500">
        <span>SL ₹{fmt(state.currentSL)}</span>
        <span>Floor ₹{fmt(state.currentFloor)}</span>
        <span>TP ₹{fmt(state.currentTP)}</span>
      </div>
    </div>
  );
}

// ── Position card ───────────────────────────────────────────────────────

function PositionCard({ state }: { state: ScalpState }) {
  const tierColors = ['bg-gray-600', 'bg-blue-600', 'bg-green-600', 'bg-yellow-600', 'bg-purple-600'];
  const tierColor = tierColors[Math.min(state.activeTier, tierColors.length - 1)];

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge status={state.side === 'LONG' ? 'TRADED' : 'REJECTED'} className={state.side === 'LONG' ? 'text-green-400' : 'text-red-400'}>
          </Badge>
          <span className="font-mono text-sm font-semibold">{state.side}</span>
          <span className="font-mono text-sm font-semibold">{state.tradingSymbol}</span>
          {state.momentumReversed && <span className="text-yellow-400 text-xs font-semibold">⚠ REVERSED</span>}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>{fmtMs(state.holdMs)}</span>
          <span>•</span>
          <span>Tier {state.activeTier}</span>
          <div className={`w-2 h-2 rounded-full ${tierColor}`} />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-gray-500 text-xs">Entry</div>
          <div className="font-mono">₹{fmt(state.entryPrice)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-xs">Current</div>
          <FlashValue value={state.currentPrice} className="font-mono">
            ₹{fmt(state.currentPrice)}
          </FlashValue>
        </div>
        <div>
          <div className="text-gray-500 text-xs">Peak</div>
          <div className="font-mono text-purple-300">₹{fmt(state.peakPrice)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-xs">P&L (net)</div>
          <div className={`font-mono font-bold ${pnlColor(state.profitSoFar)}`}>
            {fmtPnl(state.profitSoFar)}
          </div>
        </div>
      </div>

      <RatchetBar state={state} />

      <div className="grid grid-cols-4 gap-3 text-xs text-gray-400">
        <div><span className="text-gray-600">R:</span> {state.rMultiple.toFixed(2)}R</div>
        <div><span className="text-gray-600">Δ:</span> {state.delta.toFixed(2)}</div>
        <div><span className="text-gray-600">Fees:</span> ₹{fmt(state.feesPerLot * state.quantity, 0)}</div>
        <div><span className="text-gray-600">BE:</span> ₹{fmt(state.breakevenPrice)}</div>
      </div>
    </Card>
  );
}

// ── Stats panel ─────────────────────────────────────────────────────────

function StatsPanel({ stats }: { stats: ScalpStats | null }) {
  if (!stats || stats.totalTrades === 0) {
    return <Card className="p-4 text-center text-gray-500">No scalp trades yet</Card>;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card className="p-3">
        <div className="text-xs text-gray-500">Net P&L</div>
        <div className={`text-xl font-bold ${pnlColor(stats.netPnl)}`}>{fmtPnl(stats.netPnl)}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Win Rate</div>
        <div className="text-xl font-bold">{stats.winRate.toFixed(1)}%</div>
        <div className="text-xs text-gray-500">{stats.wins}W / {stats.losses}L</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Profit Factor</div>
        <div className="text-xl font-bold">{isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Avg Hold</div>
        <div className="text-xl font-bold">{fmtMs(stats.avgHoldMs)}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Total Fees</div>
        <div className="text-lg font-mono text-orange-400">₹{fmt(stats.totalFees, 0)}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Avg Win</div>
        <div className="text-lg font-mono text-green-400">{fmtPnl(stats.avgWin)}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Avg Loss</div>
        <div className="text-lg font-mono text-red-400">{fmtPnl(stats.avgLoss)}</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs text-gray-500">Streak</div>
        <div className="text-lg font-bold">
          {stats.consecutiveWins > 0 && <span className="text-green-400">{stats.consecutiveWins}W</span>}
          {stats.consecutiveLosses > 0 && <span className="text-red-400">{stats.consecutiveLosses}L</span>}
          {stats.consecutiveWins === 0 && stats.consecutiveLosses === 0 && '—'}
        </div>
      </Card>
    </div>
  );
}

// ── History table ───────────────────────────────────────────────────────

function HistoryTable({ history }: { history: ScalpExitRecord[] }) {
  if (history.length === 0) {
    return <Card className="p-4 text-center text-gray-500">No completed scalps yet</Card>;
  }
  return (
    <Card className="p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Symbol</th>
              <th className="px-3 py-2 text-left">Side</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Exit</th>
              <th className="px-3 py-2 text-right">P&L</th>
              <th className="px-3 py-2 text-right">Fees</th>
              <th className="px-3 py-2 text-right">Hold</th>
              <th className="px-3 py-2 text-right">Peak R</th>
              <th className="px-3 py-2 text-left">Exit Reason</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t) => (
              <tr key={t.positionId} className="border-t border-gray-800 hover:bg-gray-800/50">
                <td className="px-3 py-2 text-gray-500 text-xs">
                  {new Date(t.exitTime).toLocaleTimeString('en-GB', { hour12: false })}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{t.tradingSymbol}</td>
                <td className="px-3 py-2">
                  <span className={t.side === 'LONG' ? 'text-green-400' : 'text-red-400'}>{t.side}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono">₹{fmt(t.entryPrice)}</td>
                <td className="px-3 py-2 text-right font-mono">₹{fmt(t.exitPrice)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pnlColor(t.pnl)}`}>
                  {fmtPnl(t.pnl)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-orange-400">₹{fmt(t.fees, 0)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{fmtMs(t.holdMs)}</td>
                <td className="px-3 py-2 text-right font-mono">{t.peakR.toFixed(1)}R</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  <Badge status={t.pnl >= 0 ? 'TRADED' : 'REJECTED'} />
                  <span className="ml-2">{t.exitReason.slice(0, 50)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────

export function ScalpMonitor() {
  const [positions, setPositions] = useState<ScalpState[]>([]);
  const [history, setHistory] = useState<ScalpExitRecord[]>([]);
  const [stats, setStats] = useState<ScalpStats | null>(null);
  const [config, setConfig] = useState<ScalpConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const lastTickRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const [posRes, histRes, statsRes, cfgRes] = await Promise.all([
        apiRequest<{ positions: ScalpState[] }>('/api/scalp/positions'),
        apiRequest<{ history: ScalpExitRecord[] }>('/api/scalp/history'),
        apiRequest<ScalpStats>('/api/scalp/stats'),
        apiRequest<ScalpConfig>('/api/scalp/config'),
      ]);
      setPositions(posRes.positions || []);
      setHistory(histRes.history || []);
      setStats(statsRes);
      setConfig(cfgRes);
    } catch {
      // Backend may not have scalp enabled yet — silent fail
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  useBackendStream(useCallback((env: Envelope) => {
    if (env.channel !== 'scalp') return;
    lastTickRef.current = Date.now();
    const p = env.payload || {};
    switch (p.type) {
      case 'tick':
        if (p.positions) setPositions(p.positions);
        break;
      case 'entry':
        if (p.position) setPositions((prev) => [...prev.filter((x) => x.positionId !== p.position.positionId), p.position]);
        break;
      case 'exit':
        setPositions((prev) => prev.filter((x) => x.positionId !== p.position?.positionId));
        setTimeout(refresh, 500);
        break;
      case 'stats':
        if (p.stats) setStats(p.stats);
        break;
      case 'config':
        if (p.config) setConfig(p.config);
        break;
    }
  }, [refresh]), ['scalp']);

  useEffect(() => {
    const checkInterval = setInterval(() => {
      setWsConnected(Date.now() - lastTickRef.current < 10_000);
    }, 2000);
    return () => clearInterval(checkInterval);
  }, []);

  const toggleEnabled = useCallback(async () => {
    try {
      const res = await apiRequest<{ enabled: boolean }>('/api/scalp/enable', {
        method: 'POST',
        body: JSON.stringify({ enabled: !enabled }),
      });
      setEnabled(res.enabled);
    } catch {
      // ignore
    }
  }, [enabled]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">Scalp Monitor</h2>
          <StatusDot status={wsConnected ? 'live' : 'idle'} pulse={wsConnected} />
          <span className="text-xs text-gray-500">{wsConnected ? 'Live' : 'Connecting...'}</span>
          <Badge status={enabled ? 'TRADED' : 'PENDING'} className={enabled ? 'text-green-400' : 'text-gray-400'} />
        </div>
        <Button onClick={toggleEnabled} variant={enabled ? 'danger' : 'primary'}>
          {enabled ? 'Stop Scalping' : 'Start Scalping'}
        </Button>
      </div>

      <StatsPanel stats={stats} />

      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-2">
          Open Positions ({positions.length})
        </h3>
        {positions.length === 0 ? (
          <Card className="p-8 text-center text-gray-500">
            No open scalp positions. The scanner will register entries here when the scalp engine is enabled.
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {positions.map((pos) => (
              <PositionCard key={pos.positionId} state={pos} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-2">
          Trade History ({history.length})
        </h3>
        <HistoryTable history={history} />
      </div>

      {config && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Configuration</h3>
          <Card className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-gray-500">Min Capture / Lot</div>
                <div className="font-mono">₹{config.minCapturePerLot}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">TP Multiplier</div>
                <div className="font-mono">{config.targetMultiplier.min}× - {config.targetMultiplier.max}×</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">ATR Multiple</div>
                <div className="font-mono">{config.atrMultiple}×</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Max Flat Hold</div>
                <div className="font-mono">{fmtMs(config.maxFlatHoldMs)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Delta Gate</div>
                <div className="font-mono">{config.deltaGate.min} - {config.deltaGate.max}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Max Spread</div>
                <div className="font-mono">{config.maxSpreadPct}%</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Min IV Rank</div>
                <div className="font-mono">{config.minIvRank}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Min Volume</div>
                <div className="font-mono">{config.minVolume}</div>
              </div>
            </div>
            <div className="mt-4">
              <div className="text-xs text-gray-500 mb-2">Ratchet Schedule</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500">
                    <tr>
                      <th className="px-2 py-1 text-left">Tier</th>
                      <th className="px-2 py-1 text-right">Peak R</th>
                      <th className="px-2 py-1 text-right">SL Trail %</th>
                      <th className="px-2 py-1 text-right">Floor R</th>
                      <th className="px-2 py-1 text-right">Giveback %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.ratchet.map((t, i) => (
                      <tr key={i} className="border-t border-gray-800">
                        <td className="px-2 py-1">{i}</td>
                        <td className="px-2 py-1 text-right font-mono">{t.peakR}R</td>
                        <td className="px-2 py-1 text-right font-mono">{t.slTrailPctOfPeak}%</td>
                        <td className="px-2 py-1 text-right font-mono">{t.floorR}R</td>
                        <td className="px-2 py-1 text-right font-mono">{(t.givebackPct * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
