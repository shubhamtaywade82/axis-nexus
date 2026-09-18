import { useState, useEffect } from "react";
import { useApp } from "../../store/AppContext";
import { fmtINR, pnlClass } from "../../utils/formatters";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { Bolt, Power } from "lucide-react";
import { LerpNumber } from "../ui/LerpNumber";

interface HeaderProps {
  pageTitle: string;
  pageSubtitle: string;
  onKillSwitch: () => void;
}

interface TickerData {
  ltp: number;
  change: number;
  pct: number;
}

function Ticker({ label, data, valueClass = "text-white" }: { label: string; data: TickerData | null; valueClass?: string }) {
  return (
    <div className="flex items-center gap-1.5 tabular-nums">
      <span className="text-muted text-[10px]">{label}</span>
      {data ? (
        <>
          <span className={`${valueClass} font-semibold`}>
            <LerpNumber value={data.ltp} decimals={2} />
          </span>
          <span className={`text-[10px] ${data.change >= 0 ? "text-accent" : "text-danger"}`}>
            {data.change >= 0 ? "+" : ""}
            <LerpNumber value={data.pct} decimals={2} suffix="%" />
          </span>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
    </div>
  );
}

export function Header({ pageTitle, pageSubtitle, onKillSwitch }: HeaderProps) {
  const { state, connected } = useApp();
  const [timeStr, setTimeStr] = useState(() =>
    new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" }),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeStr(new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // No fabricated fallback quotes — an index shows "—" until a real live tick arrives.
  const indices = state.indices || {};
  const nifty = indices.NIFTY?.ltp ? indices.NIFTY : null;
  const bnf = indices.BANKNIFTY?.ltp ? indices.BANKNIFTY : null;
  const sensex = indices.SENSEX?.ltp ? indices.SENSEX : null;
  const vix = indices.INDIAVIX?.ltp ? indices.INDIAVIX : null;

  // Day P&L and Net Worth read straight off the backend's WalletSnapshot —
  // the same fields Dashboard's MetricsGrid uses — rather than re-summing
  // state.positions here. Positions and funds arrive via separate WS
  // pushes on different cadences, so a second independent calculation
  // drifts from the wallet's own numbers (RISK-01 sibling bug).
  const realizedPnl = Number(state.funds.sessionRealizedPnl ?? state.funds.realizedPnl ?? 0);
  const unrealizedPnl = Number(state.funds.unrealizedPnl || 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const avail = Number(state.funds.availableMargin || 100000);
  const used = Number(state.funds.usedMargin || 0);
  const baseBalance = Number(state.funds.totalBalance || (avail + used));
  const totalEquity = Number(state.funds.equity ?? (baseBalance + unrealizedPnl));
  const pnlPct = baseBalance > 0 ? (totalPnl / baseBalance) * 100 : 0;

  return (
    <header className="app-header h-14 min-h-[56px] bg-surface-100 border-b border-border flex items-center justify-between px-5 z-20">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
            <Bolt size={14} className="text-accent" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-wider text-white flex items-center gap-2">
              <span>AXIS NEXUS</span>
              <span className="text-[9px] font-mono bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded">
                v4.2 PROD
              </span>
            </div>
            <div className="text-[9.5px] font-mono text-muted tracking-wide">
              Options Engine & Multi-Agent Control Plane
            </div>
          </div>
        </div>
        <div className="h-6 w-px bg-border mx-2" />
        <div className="flex items-center gap-2">
          <h1 className="text-xs font-semibold text-white">{pageTitle}</h1>
          <span className="text-[9px] font-mono text-muted bg-surface-300 px-2 py-0.5 rounded border border-border">
            {pageSubtitle}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden xl:flex items-center gap-4 font-mono text-xs">
          <Ticker label="NIFTY" data={nifty} />
          <Ticker label="BANKNIFTY" data={bnf} />
          <Ticker label="SENSEX" data={sensex} />
          <Ticker label="INDIA VIX" data={vix} valueClass="text-gold" />
        </div>

        {/* Live Equity & Day P&L Capsule (Fixed Width, Smooth LERP) */}
        <div className="flex items-center justify-between w-[250px] shrink-0 px-3 py-1.5 rounded-lg bg-surface-50 border border-border/80 font-mono shadow-sm tabular-nums">
          <div className="flex flex-col w-[95px] shrink-0">
            <span className="text-[8.5px] font-mono text-muted uppercase tracking-wider leading-none">
              {state.tradingMode === 'paper' ? 'Equity' : 'Net Worth'}
            </span>
            <span className="text-xs font-bold text-white leading-tight truncate">
              <LerpNumber value={totalEquity} decimals={0} prefix="₹" />
            </span>
          </div>
          <div className="h-5 w-px bg-border shrink-0" />
          <div className="flex flex-col w-[130px] shrink-0 pl-1">
            <span className="text-[8.5px] font-mono text-muted uppercase tracking-wider leading-none">
              Day P&amp;L
            </span>
            <div className="flex items-center justify-between leading-tight">
              <span className={`text-xs font-bold ${pnlClass(totalPnl)} truncate`}>
                <LerpNumber value={totalPnl} format={fmtINR} />
              </span>
              <span className={`text-[9.5px] ${pnlClass(totalPnl)} shrink-0`}>
                (<LerpNumber value={pnlPct} decimals={2} prefix={totalPnl >= 0 ? "+" : ""} suffix="%" />)
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 border-l border-border pl-4">
          <div className="font-mono text-xs text-muted hidden sm:block">{timeStr}</div>
          <div className="flex items-center gap-1.5">
            <StatusDot status={connected ? "live" : "error"} pulse={connected} />
            <span
              className={`text-[11px] font-mono font-semibold ${connected ? "text-accent" : "text-danger"}`}
            >
              {state.killed ? "SYSTEM HALTED" : connected ? "MARKET OPEN" : "OFFLINE"}
            </span>
          </div>
        </div>
        <Button variant="danger" className="text-[11px] px-3.5 py-1.5" onClick={onKillSwitch}>
          <Power size={12} /> KILL SWITCH
        </Button>
      </div>
    </header>
  );
}
