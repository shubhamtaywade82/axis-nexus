import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { LerpNumber } from '../components/ui/LerpNumber';
import { fmt, fmtINR, pnlClass, sideClass } from '../utils/formatters';
import { RotateCcw, Power } from 'lucide-react';
import { api } from '../services/api';
import type { InstrumentKey } from '../store/types';

function instrumentKeyLabel(key: InstrumentKey): string {
  return `${key.exchangeSegment}:${key.securityId}`;
}

type PolicyState = { peakNet: number; floorNet: number; captureRatioSoFar: number | null; partialTaken: boolean };
type TradingMode = 'paper' | 'sandbox' | 'live';

function modeLabel(mode: TradingMode): string {
  if (mode === 'sandbox') return 'Sandbox';
  if (mode === 'live') return 'Live';
  return 'Paper Trading';
}

function modeSubtitle(mode: TradingMode, policyEnabled: boolean) {
  const policy = policyEnabled ? <span className="text-accent"> · long-option peak-profit policy active</span> : null;
  if (mode === 'sandbox') {
    return <>DhanHQ Sandbox account positions — MTM polled from broker every few seconds{policy}</>;
  }
  if (mode === 'live') {
    return <>Live DhanHQ account positions — MTM from broker{policy}</>;
  }
  return <>PostgreSQL persistent paper positions with automated SL/TP &amp; Trailing monitoring{policy}</>;
}

export function Positions() {
  const { state, showToast, openModal, closeModal, addSystemLog, refreshPortfolio } = useApp();
  const [mode, setMode] = useState<TradingMode>('paper');
  const [policyEnabled, setPolicyEnabled] = useState(false);
  const [policyBySymbol, setPolicyBySymbol] = useState<Record<string, PolicyState>>({});

  useEffect(() => {
    api.health().then((h) => setMode((h.mode as TradingMode) || 'paper')).catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await api.longOptionPolicy();
        if (!mounted) return;
        setPolicyEnabled(res.enabled);
        setPolicyBySymbol(Object.fromEntries(res.positions.flatMap((p) => {
          const entries: [string, PolicyState][] = [[p.tradingSymbol, p]];
          if (p.securityId) entries.push([`${p.exchangeSegment || 'NSE_FNO'}:${p.securityId}`, p]);
          return entries;
        })));
      } catch { /* control plane unreachable — table just shows no lock data */ }
    };
    load();
    const interval = setInterval(load, 3000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const isPaper = mode === 'paper';

  const realPositions = state.positions
    .filter((p) => Number(p.netQty ?? p.net_qty ?? 0) !== 0)
    .map((p) => {
    const net = Number(p.netQty ?? p.net_qty ?? 0);
    const buyAvg = Number(p.buyAvg ?? p.buy_avg ?? 0);
    const sellAvg = Number(p.sellAvg ?? p.sell_avg ?? 0);
    const ltp = Number(p.ltp ?? p.costPrice ?? (net >= 0 ? buyAvg : sellAvg));
    const pnl = Number(p.unrealizedProfit ?? p.unrealizedPnl ?? p.pnl ?? p.realizedProfit ?? 0);

    return {
      id: p.id || p.tradingSymbol,
      strategy: modeLabel(mode),
      instrument: p.tradingSymbol || p.symbol || p.id,
      key: {
        securityId: String(p.securityId ?? p.security_id ?? ''),
        exchangeSegment: String(p.exchangeSegment ?? p.exchange_segment ?? 'NSE_FNO'),
      } satisfies InstrumentKey,
      side: net >= 0 ? ('BUY' as const) : ('SELL' as const),
      qty: Math.abs(net),
      bAvg: buyAvg,
      sAvg: sellAvg,
      ltp,
      pnl,
      stopLoss: p.stopLoss ?? p.stop_loss ?? null,
      target: p.target ?? p.target ?? null,
      trailingStop: p.trailingStop ?? p.trailing_stop ?? null,
      delta: '0.00',
      theta: '0',
      product: p.productType || p.product_type || 'INTRADAY',
    };
  });

  const closeOne = async (key: InstrumentKey, label: string, ltp: number) => {
    const payload = { ...key, tradingSymbol: label };
    if (isPaper) return api.closePaperPosition(payload, ltp);
    return api.closePosition(payload, ltp);
  };

  const handleClose = async (key: InstrumentKey, label: string, ltp: number) => {
    try {
      await closeOne(key, label, ltp);
      showToast(`Position ${label} closed successfully`, 'success');
      addSystemLog('INFO', `Position closed for ${label} (${key.exchangeSegment}/${key.securityId}) @ ${ltp}`, isPaper ? 'paper_execution' : 'portfolio_source');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to close ${label}: ${e.message}`, 'error');
    }
  };

  const closeAll = () => {
    openModal(
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-3 text-danger text-xl">
          <Power size={20} />
        </div>
        <div className="text-base font-bold text-danger mb-1">Close All Positions</div>
        <div className="text-xs text-muted mb-4">
          {isPaper
            ? 'This will immediately close ALL open paper positions in PostgreSQL.'
            : `This will send reversing orders to close ALL open ${mode === 'sandbox' ? 'sandbox' : 'live'} positions.`}
        </div>
        <div className="flex gap-2 justify-center">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            closeModal();
            try {
              if (isPaper) {
                for (const p of realPositions) await closeOne(p.key, p.instrument, p.ltp);
              } else {
                await api.closeAllPositions();
              }
              await refreshPortfolio();
              addSystemLog('WARN', `All ${mode} positions closed`, 'risk_engine');
              showToast('All open positions closed', 'success');
            } catch (e: any) {
              showToast(`Close all failed: ${e.message}`, 'error');
            }
          }}>Close All Now</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Active Positions & MTM</div>
          <div className="text-xs text-muted mt-0.5">
            {modeSubtitle(mode, policyEnabled)}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={async () => { await refreshPortfolio(); showToast('Portfolio synced', 'success'); }}><RotateCcw size={12} className="mr-1" /> Refresh Positions</Button>
          <Button variant="danger" onClick={closeAll}><Power size={12} className="mr-1" /> Close All Positions</Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              {['Strategy', 'Instrument', 'Side', 'Net Qty', 'Avg Price', 'LTP', 'Stop Loss', 'Target (TP)', 'Trailing SL', 'Profit Lock', 'P&L', 'Product', 'Actions'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {realPositions.length === 0 ? (
              <tr>
                <td colSpan={13} className="text-center py-8 text-muted text-xs">
                  {isPaper
                    ? 'No open positions. Place a paper trade to start!'
                    : `No open ${mode} positions — fills appear here once sandbox/live orders trade.`}
                </td>
              </tr>
            ) : (
              realPositions.map((p, i) => (
                <tr key={i} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[10px]">{p.strategy}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{p.instrument}</td>
                  <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${sideClass(p.side)}`}>{p.side}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">{p.qty}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">{p.bAvg ? fmt(p.bAvg) : (p.sAvg ? fmt(p.sAvg) : '-')}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold font-mono"><LerpNumber value={p.ltp} /></td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 font-mono text-danger font-semibold">
                    {p.stopLoss ? `₹${fmt(p.stopLoss)}` : <span className="text-muted font-normal text-[10px]">{isPaper ? 'Auto (Risk)' : 'Broker'}</span>}
                  </td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 font-mono text-accent font-semibold">
                    {p.target ? `₹${fmt(p.target)}` : <span className="text-muted font-normal text-[10px]">{isPaper ? '15:20 EOD' : '—'}</span>}
                  </td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 font-mono text-sky text-[10px]">
                    {p.trailingStop ? `±₹${p.trailingStop}` : <span className="text-muted font-normal">{isPaper ? 'Active' : '—'}</span>}
                  </td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 font-mono text-[10px]">
                    {(() => {
                      const pol = policyBySymbol[p.instrument] || policyBySymbol[instrumentKeyLabel(p.key)];
                      if (!pol) return <span className="text-muted font-normal">—</span>;
                      return (
                        <div className="flex flex-col leading-tight">
                          <span className="text-accent">peak {fmtINR(pol.peakNet)}</span>
                          <span className={pol.floorNet > 0 ? 'text-accent' : 'text-muted'}>floor {fmtINR(pol.floorNet)}</span>
                        </div>
                      );
                    })()}
                  </td>
                  <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold font-mono ${pnlClass(p.pnl)}`}><LerpNumber value={p.pnl} format={fmtINR} /></td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[10px]">{p.product}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60">
                    <Button variant="danger" className="text-[9px] px-2 py-0.5" onClick={() => handleClose(p.key, p.instrument, p.ltp)}>Close</Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
