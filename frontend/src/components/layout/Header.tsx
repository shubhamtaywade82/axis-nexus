import { useState, useEffect } from "react";
import { useApp } from "../../store/AppContext";
import { fmtINR, pnlClass } from "../../utils/formatters";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { Bolt, Menu, Power } from "lucide-react";
import { LerpNumber } from "../ui/LerpNumber";

interface HeaderProps {
  pageTitle: string;
  pageSubtitle: string;
  onKillSwitch: () => void;
  onToggleMenu: () => void;
}

/** NSE regular session, 09:15–15:30 IST Mon–Fri (holiday-blind: the backend
 * risk engine owns the authoritative trading-day calendar). */
function isNseSessionOpen(now: Date): boolean {
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60_000);
  const day = ist.getDay();
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && minutes >= 555 && minutes < 930;
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

export function Header({ pageTitle, pageSubtitle, onKillSwitch, onToggleMenu }: HeaderProps) {
  const { state, connected } = useApp();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const timeStr = now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" });
  const isSessionOpen = isNseSessionOpen(now);
  const statusLabel = state.killed ? "SYSTEM HALTED" : !connected ? "OFFLINE" : isSessionOpen ? "MARKET OPEN" : "MARKET CLOSED";
  const statusClass = state.killed || !connected ? "text-danger" : isSessionOpen ? "text-accent" : "text-gold";

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

  const tickers = (
    <>
      <Ticker label="NIFTY" data={nifty} />
      <Ticker label="BANKNIFTY" data={bnf} />
      <Ticker label="SENSEX" data={sensex} />
      <Ticker label="INDIA VIX" data={vix} valueClass="text-gold" />
    </>
  );

  return (
    <>
    <header className="app-header h-14 min-h-[56px] bg-surface-100 border-b border-border flex items-center justify-between gap-2 px-3 md:px-5 z-20">
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        <button
          type="button"
          onClick={onToggleMenu}
          className="lg:hidden w-9 h-9 -ml-1 rounded-md flex items-center justify-center text-muted hover:text-white hover:bg-surface-200"
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 items-center justify-center">
            <Bolt size={14} className="text-accent" />
          </div>
          <div className="hidden md:block">
            <div className="text-sm font-bold tracking-wider text-white flex items-center gap-2 whitespace-nowrap">
              <span>AXIS NEXUS</span>
              <span className="text-[9px] font-mono bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded">
                v4.2 PROD
              </span>
            </div>
            <div className="text-[9.5px] font-mono text-muted tracking-wide whitespace-nowrap hidden 2xl:block">
              Options Engine & Multi-Agent Control Plane
            </div>
          </div>
        </div>
        <div className="h-6 w-px bg-border mx-1 hidden md:block" />
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xs font-semibold text-white whitespace-nowrap">{pageTitle}</h1>
          <span className="hidden lg:inline text-[9px] font-mono text-muted bg-surface-300 px-2 py-0.5 rounded border border-border whitespace-nowrap">
            {pageSubtitle}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 md:gap-4 shrink-0">
        <div className="hidden 2xl:flex items-center gap-4 font-mono text-xs">{tickers}</div>

        {/* Live Equity & Day P&L Capsule (Smooth LERP) */}
        <div className="hidden sm:flex items-center gap-3 shrink-0 px-3 py-1.5 rounded-lg bg-surface-50 border border-border/80 font-mono shadow-sm tabular-nums">
          <div className="flex flex-col min-w-[80px]">
            <span className="text-[8.5px] font-mono text-muted uppercase tracking-wider leading-none">
              {state.tradingMode === 'paper' ? 'Equity' : 'Net Worth'}
            </span>
            <span className="text-xs font-bold text-white leading-tight">
              <LerpNumber value={totalEquity} decimals={0} prefix="₹" />
            </span>
          </div>
          <div className="h-5 w-px bg-border shrink-0" />
          <div className="flex flex-col min-w-[110px]">
            <span className="text-[8.5px] font-mono text-muted uppercase tracking-wider leading-none">
              Day P&amp;L
            </span>
            <div className="flex items-center gap-1.5 leading-tight">
              <span className={`text-xs font-bold ${pnlClass(totalPnl)}`}>
                <LerpNumber value={totalPnl} format={fmtINR} />
              </span>
              <span className={`text-[9.5px] ${pnlClass(totalPnl)} hidden md:inline`}>
                (<LerpNumber value={pnlPct} decimals={2} prefix={totalPnl >= 0 ? "+" : ""} suffix="%" />)
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 md:border-l border-border md:pl-4">
          <div className="font-mono text-xs text-muted hidden md:block tabular-nums">{timeStr}</div>
          <div className="flex items-center gap-1.5" title={connected ? "Realtime stream connected" : "Realtime stream disconnected"}>
            <StatusDot status={connected ? "live" : "error"} pulse={connected} />
            <span className={`text-[11px] font-mono font-semibold hidden sm:inline ${statusClass}`}>{statusLabel}</span>
          </div>
        </div>
        <Button variant="danger" className="text-[11px] px-2.5 md:px-3.5 py-1.5" onClick={onKillSwitch} aria-label="Kill switch">
          <Power size={12} /> <span className="hidden md:inline">KILL SWITCH</span>
        </Button>
      </div>
    </header>
    {/* Compact live strip so small screens still see indices + P&L. */}
    <div className="2xl:hidden flex items-center gap-4 px-3 md:px-5 py-1.5 bg-surface-50 border-b border-border font-mono text-xs overflow-x-auto whitespace-nowrap no-scrollbar">
      <div className="sm:hidden flex items-center gap-1.5 tabular-nums">
        <span className="text-muted text-[10px]">P&amp;L</span>
        <span className={`font-semibold ${pnlClass(totalPnl)}`}><LerpNumber value={totalPnl} format={fmtINR} /></span>
      </div>
      {tickers}
    </div>
    </>
  );
}
