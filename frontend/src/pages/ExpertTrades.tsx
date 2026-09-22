import { useState, useEffect, useCallback } from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { ExpertTradeCard } from '../components/expertTrades/ExpertTradeCard';
import { TradePerformance } from '../components/expertTrades/TradePerformance';
import { QuickBuyModal } from '../components/expertTrades/QuickBuyModal';
import { api } from '../services/api';
import { useApp } from '../store/AppContext';
import { RefreshCw, Search } from 'lucide-react';
import type { ExpertTrade, ExpertTradeHorizon, ExpertTradeScanSummary, ExpertTradeSchedulerStatus, ExpertTradeStatsResponse } from '../types/expertTrades';

type Tab = 'open' | 'past';

/**
 * NSE Equity Expert Trade Engine console. Follows the same fetch-on-mount +
 * manual-refresh pattern as ResearchWatchlist/ResearchScreener — the
 * backend does not yet push expert_trade envelopes into AppContext state,
 * so this stays REST-driven (the 'expert_trade' EventBus channel exists for
 * a future live-push wiring, see useBackendStream.ts).
 */
export function ExpertTrades() {
  const { showToast, openModal, closeModal } = useApp();
  const [tab, setTab] = useState<Tab>('open');
  const [horizon, setHorizon] = useState<'ALL' | ExpertTradeHorizon>('ALL');
  const [trades, setTrades] = useState<ExpertTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<ExpertTradeScanSummary | null>(null);
  const [schedule, setSchedule] = useState<ExpertTradeSchedulerStatus | null>(null);
  const [stats, setStats] = useState<ExpertTradeStatsResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'open') {
        const res = await api.expertTrades(undefined, horizon === 'ALL' ? undefined : horizon);
        setTrades(res.trades);
      } else {
        const [past, statsRes] = await Promise.all([api.expertTradesPast(), api.expertTradeStats()]);
        setTrades(past.trades);
        setStats(statsRes);
      }
    } catch (e: any) {
      showToast(`Failed to load expert trades: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, horizon, showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.expertTradeScannerStatus().then((s) => {
      if (s && 'scannedAt' in s && s.scannedAt) setStatus(s as ExpertTradeScanSummary);
    }).catch(() => {});
    api.expertTradeSchedulerStatus().then(setSchedule).catch(() => {});
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const summary = await api.expertTradeScan('FNO_HEAVYWEIGHTS');
      setStatus(summary);
      showToast(`Scan complete: ${summary.published} new idea(s) from ${summary.candidatesConsidered} candidates`, 'success');
      await load();
    } catch (e: any) {
      showToast(`Scan failed: ${e.message}`, 'error');
    } finally {
      setScanning(false);
    }
  }, [load, showToast]);

  const openQuickBuy = useCallback((trade: ExpertTrade) => {
    openModal(
      <QuickBuyModal
        trade={trade}
        onClose={closeModal}
        onDone={(result) => {
          showToast(`Bought ${result.quantity} ${result.symbol} @ ₹${result.fillPrice.toFixed(2)} (paper)`, 'success');
          load();
        }}
      />,
    );
  }, [openModal, closeModal, showToast, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Expert Trade Engine</div>
          <div className="text-xs text-muted mt-0.5">
            Deterministic NSE equity setups — entry, stop-loss and two targets, never LLM-invented
          </div>
        </div>
        <div className="flex gap-2">
          <Select value={horizon} onChange={(e) => setHorizon(e.target.value as any)} className="text-xs">
            <option value="ALL">All Horizons</option>
            <option value="SHORT_TERM">Short Term</option>
            <option value="MID_TERM">Mid Term</option>
            <option value="LONG_TERM">Long Term</option>
          </Select>
          <Button variant="ghost" onClick={load}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh</Button>
          <Button onClick={runScan} disabled={scanning}><Search size={13} /> {scanning ? 'Scanning…' : 'Scan Now'}</Button>
        </div>
      </div>

      {(status || schedule) && (
        <Card className="p-3 text-[10.5px] font-mono text-muted flex flex-col gap-1">
          {status && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>Last scan: {new Date(status.scannedAt).toLocaleTimeString('en-IN')}</span>
              <span>Universe: {status.universe}</span>
              <span>Regime: <span className={status.regime === 'RISK_ON' ? 'text-accent' : status.regime === 'RISK_OFF' ? 'text-danger' : 'text-sky'}>{status.regime}</span></span>
              <span>Screened: {status.totalScreened}</span>
              <span>Setups: {status.setupsDetected}</span>
              <span>Published: {status.published}</span>
            </div>
          )}
          {schedule && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t border-border/50">
              <span>
                Autonomous scan: <span className={schedule.enabled ? 'text-accent' : 'text-muted'}>{schedule.enabled ? 'ARMED' : 'DISABLED'}</span>
              </span>
              {schedule.enabled && <span>Next: {schedule.nextScheduledJob}</span>}
              {schedule.lastRunTimes.postMarketScan && (
                <span>Last auto-scan: {new Date(schedule.lastRunTimes.postMarketScan).toLocaleString('en-IN')}</span>
              )}
            </div>
          )}
        </Card>
      )}

      <div className="flex gap-1 border-b border-border">
        {(['open', 'past'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-all ${tab === t ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-white'}`}
          >
            {t === 'open' ? 'New & Active' : 'Past Trades'}
          </button>
        ))}
      </div>

      {tab === 'past' && stats && <TradePerformance overall={stats.overall} bySetup={stats.bySetup} />}

      {trades.length === 0 ? (
        <Card className="p-8 text-center text-muted text-xs">
          {loading ? 'Loading…' : tab === 'open'
            ? 'No open trade ideas. Click "Scan Now" to run the setup/entry/stop/target pipeline against the current universe.'
            : 'No closed trade ideas yet.'}
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {trades.map((t) => <ExpertTradeCard key={t.id} trade={t} onQuickBuy={openQuickBuy} />)}
        </div>
      )}
    </div>
  );
}
