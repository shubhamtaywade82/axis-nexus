import { useState } from "react";
import type { AppState } from "../store/types";
import { useApp } from "../store/AppContext";
import { Card } from "../components/ui/Card";
import { Badge, StratBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { LerpNumber } from "../components/ui/LerpNumber";
import { fmt, fmtINR, pnlClass, sideClass } from "../utils/formatters";
import { usePnlChart, type PnlPoint } from "../hooks/usePnlChart";
import { Plus, Brain } from "lucide-react";

interface DashboardProps {
  onNavigate: (id: string) => void;
  onDeploy: () => void;
}

type PnlChartPeriod = '15M' | '1H' | 'SESSION';
const PNL_PERIOD_SECONDS: Record<PnlChartPeriod, number | null> = { '15M': 15 * 60, '1H': 60 * 60, SESSION: null };

export function Dashboard({ onNavigate, onDeploy }: DashboardProps) {
  const { state } = useApp();
  const [pnlPeriod, setPnlPeriod] = useState<PnlChartPeriod>('SESSION');
  // Day P&L is session-scoped (resets at IST day rollover), not the wallet's
  // lifetime realizedPnl — falls back to it only if the backend predates
  // sessionRealizedPnl (RISK-01). Both figures come from the backend's own
  // WalletSnapshot, not a re-sum of state.positions here — positions and
  // funds arrive via separate WS pushes on different cadences, so an
  // independent per-component sum drifts from the wallet's own numbers
  // (and from any other component computing the same thing its own way).
  const realizedPnl = Number(state.funds.sessionRealizedPnl ?? state.funds.realizedPnl ?? 0);
  const unrealizedPnl = Number(state.funds.unrealizedPnl || 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const windowSecs = PNL_PERIOD_SECONDS[pnlPeriod];
  const pnlSeries: PnlPoint[] = windowSecs
    ? state.pnlHistory.filter((p) => p.t >= Date.now() - windowSecs * 1000)
    : state.pnlHistory;
  const canvasRef = usePnlChart(pnlSeries.length > 0 ? pnlSeries : [{ t: Date.now(), v: totalPnl }]);
  const recentOrders = state.orders.slice(0, 8);

  return (
    <div className="dashboard-shell space-y-5">
      <MetricsGrid state={state} totalPnl={totalPnl} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="col-span-2 p-4 h-[320px] flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Intraday P&L Performance Curve</span>
              <span className="text-[9px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">REALTIME</span>
            </div>
            <div className="flex gap-1.5">
              {(['15M', '1H', 'SESSION'] as PnlChartPeriod[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPnlPeriod(p)}
                  className={`btn btn-ghost text-[10px] py-0.5 px-2.5 ${pnlPeriod === p ? 'border-accent/30 text-accent' : ''}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <canvas ref={canvasRef} className="w-full h-full" />
          </div>
        </Card>
        <Card className="p-4 h-[320px] flex flex-col">
          <div className="flex items-center justify-between mb-3 gap-2">
            <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Active Strategies</span>
            <button className="text-[10px] font-mono text-accent hover:underline whitespace-nowrap" onClick={() => onNavigate("strategies")}>
              View All ({state.strategies.filter((s) => s.status !== "STOPPED").length}) →
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2 scrollbar-thin scrollbar-thumb-border hover:scrollbar-thumb-muted/30">
            {state.strategies.filter((s) => s.status !== "STOPPED").length === 0 ? (
              <div className="text-center py-6 text-muted text-xs">No active strategies.</div>
            ) : (
              state.strategies.filter((s) => s.status !== "STOPPED").map((s) => (
                <div key={s.id} className="p-2.5 rounded-lg bg-surface-50 border border-border hover:border-[#2a3d5e] transition-all cursor-pointer" onClick={() => onNavigate("strategies")}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-[11px] font-semibold text-white truncate min-w-0">{s.name}</span>
                    <StratBadge status={s.status} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-mono text-muted shrink-0">{s.symbol} · {s.type} · {s.lots}L</span>
                    <span className={`text-[11px] font-mono font-bold whitespace-nowrap ${pnlClass(s.pnl)}`}>{fmtINR(s.pnl)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <Button className="w-full mt-3 shrink-0" onClick={onDeploy}><Plus size={14} /> Deploy New Strategy</Button>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-3 font-semibold">Market Spot Indices</div>
          <div className="space-y-2.5">
            {Object.entries(state.indices).map(([sym, d]) => {
              if (!d) return null;
              return (
                <div key={sym} className="flex items-center justify-between p-2 rounded bg-surface-50 border border-border">
                  <div>
                    <div className="text-xs font-semibold text-white">{sym}</div>
                    <div className="text-[9px] font-mono text-muted">SPOT</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono font-bold text-white"><LerpNumber value={d.ltp} /></div>
                    <div className={`${d.change >= 0 ? "text-accent" : "text-danger"} text-[10px] font-mono`}>
                      {d.change >= 0 ? "▲" : "▼"}<LerpNumber value={Math.abs(d.change)} /> (<LerpNumber value={Math.abs(d.pct)} suffix="%" />)
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Recent Order Fills (Audit Stream)</span>
            <button className="text-[10px] font-mono text-accent hover:underline" onClick={() => onNavigate("orders")}>Full Order Book →</button>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  {["Time", "Instrument", "Side", "Qty", "Price", "Strategy / Corr ID", "Status"].map((h) => (
                    <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-6 text-muted text-xs">No orders recorded yet.</td>
                  </tr>
                ) : (
                  recentOrders.map((f, i) => (
                    <tr key={i} className="hover:bg-surface-200/50">
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">
                        {f.time}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">
                        {f.instrument}
                      </td>
                      <td
                        className={`px-2.5 py-[7px] border-b border-border/60 font-semibold ${sideClass(f.side)}`}
                      >
                        {f.side}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">
                        {f.qty}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">
                        {fmt(f.price)}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-sky text-[9.5px] font-mono">
                        {f.corr || f.id}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60">
                        <Badge status={f.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="p-3.5 bg-surface-50 border-purple/20">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-purple">
            <Brain size={14} />
            <span>Multi-Agent Activity Digest</span>
          </div>
          <span className="text-[9px] font-mono text-muted">
            Live from backend agent telemetry
          </span>
        </div>
        {state.telemetryEvents.length === 0 ? (
          <div className="text-[10.5px] text-muted py-2">
            No agent activity yet — submit an objective in the Agent Console. When runs execute,
            their ReAct steps (planner → analyst → strategy → risk → execution → critic) appear here live.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-[10.5px]">
            {state.telemetryEvents.slice(-4).map((ev) => {
              const color = ev.agent === 'risk' ? 'text-danger' : ev.agent === 'analyst' ? 'text-accent'
                : ev.agent === 'strategy' ? 'text-gold' : ev.agent === 'execution' ? 'text-purple' : 'text-sky';
              return (
                <div key={ev.id} className="bg-surface-100 p-2 rounded border border-border">
                  <span className={`font-mono font-bold ${color} mr-1`}>
                    [{ev.agent}]
                  </span>
                  <span className="text-muted">{(ev.summary || '').slice(0, 140)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function MetricsGrid({
  state,
  totalPnl,
}: {
  state: Pick<AppState, 'positions' | 'orders' | 'funds' | 'strategies' | 'indices' | 'tradingMode'>;
  totalPnl: number;
}) {
  const mode = state.tradingMode || 'paper';
  const isPaper = mode === 'paper';
  const isSandbox = mode === 'sandbox';
  const avail = Number(state.funds.availableMargin || 100000);
  const used = Number(state.funds.usedMargin || 0);
  const total = Number(state.funds.totalBalance || (avail + used));
  const utilPct = total > 0 ? (used / total) * 100 : 0;
  const realized = Number(state.funds.sessionRealizedPnl ?? state.funds.realizedPnl ?? 0);
  const unrealized = totalPnl - realized;
  const equity = Number(state.funds.equity ?? (total + unrealized));
  const totalOrders = state.orders.length;
  const filledOrders = state.orders.filter((o) => (o.status || '').toUpperCase() === "TRADED").length;
  const rejectedOrders = state.orders.filter((o) => (o.status || '').toUpperCase() === "REJECTED").length;
  const pendingOrders = state.orders.filter((o) => ['PENDING', 'TRANSIT', 'OPEN'].includes((o.status || '').toUpperCase())).length;
  const openPositions = state.positions.filter((p) => Number(p.netQty ?? p.net_qty ?? 0) !== 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Card className="metric-card p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Day P&L
        </div>
        <div className={`text-xl font-bold font-mono ${pnlClass(totalPnl)}`}>
          <LerpNumber value={totalPnl} format={fmtINR} />
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Realized <span className={realized >= 0 ? "text-accent" : "text-danger"}><LerpNumber value={realized} format={fmtINR} /></span> · Unr{" "}
          <span className={unrealized >= 0 ? "text-accent" : "text-danger"}><LerpNumber value={unrealized} format={fmtINR} /></span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Margin Used
        </div>
        <div className="text-xl font-bold font-mono text-white"><LerpNumber value={used} format={fmtINR} /></div>
        <div className="h-1 bg-border rounded mt-2">
          <div className="h-full bg-gold rounded" style={{ width: `${Math.min(100, utilPct)}%` }} />
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          <LerpNumber value={utilPct} decimals={1} suffix="%" /> · Avail: <span className="text-accent"><LerpNumber value={avail} format={fmtINR} /></span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Open Positions
        </div>
        <div className="text-xl font-bold font-mono text-sky">{openPositions.length}</div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Status: <span className="text-sky font-semibold">Active Tracker</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          {isPaper ? 'Demo Wallet' : isSandbox ? 'Sandbox Net Worth' : 'Live Net Worth'}
        </div>
        <div className="text-xl font-bold font-mono text-gold"><LerpNumber value={equity} format={fmtINR} /></div>
        <div className="text-[10px] font-mono text-muted mt-1">
          {isPaper ? (
            <>Initial: <span className="text-muted">₹1,00,000</span></>
          ) : (
            <>
              Avail: <span className="text-accent"><LerpNumber value={avail} format={fmtINR} /></span>
              {' · '}Blocked: <span className="text-gold"><LerpNumber value={used} format={fmtINR} /></span>
            </>
          )}
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Active Strats
        </div>
        <div className="text-xl font-bold font-mono text-white">
          {state.strategies.filter((s) => s.status !== "STOPPED").length}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          {isPaper ? (
            <>Paper Engine: <span className="text-accent">Ready</span></>
          ) : (
            <span className="text-accent">{isSandbox ? 'Sandbox' : 'Live'} execution</span>
          )}
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Orders Today
        </div>
        <div className="text-xl font-bold font-mono text-white">
          {totalOrders}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Filled <span className="text-accent">{filledOrders}</span> · Rejected{" "}
          <span className="text-danger">{rejectedOrders}</span> · Pending{" "}
          <span className="text-muted">{pendingOrders}</span>
        </div>
      </Card>
    </div>
  );
}
