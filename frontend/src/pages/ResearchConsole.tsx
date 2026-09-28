import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Search, Loader2, BookOpen, Filter, Clock, LayoutDashboard } from 'lucide-react';
import { ResearchScreener } from './ResearchScreener';
import { ResearchWatchlist } from './ResearchWatchlist';
import { ResearchDashboard } from './ResearchDashboard';
import {
  ResearchTabs,
  VerdictTab,
  ValuationTab,
  DebateTab,
  SignalTab,
  EvidenceTab,
} from './ResearchDetailTabs';

export function ResearchConsole() {
  const [viewMode, setViewMode] = useState<'dashboard' | 'watchlist' | 'screener' | 'single'>('dashboard');
  const [symbol, setSymbol] = useState('RELIANCE');
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'verdict' | 'valuation' | 'debate' | 'signal' | 'evidence'>('verdict');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadRecentRuns(); }, []);

  const loadRecentRuns = async () => {
    try {
      const data = await api.researchRuns(15);
      setRuns(data.runs || []);
      if (data.runs?.length > 0 && !run) loadRun(data.runs[0].id);
    } catch { /* ignore initial load errors */ }
  };

  const loadRun = async (runId: string) => {
    try {
      const [runData, evData] = await Promise.all([api.researchRun(runId), api.researchEvidence(runId)]);
      setRun(runData);
      setEvidence(evData.evidence || []);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load research run');
    }
  };

  const runAnalysis = async (targetSym: string) => {
    if (!targetSym.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const newRun = await api.researchAnalyze(targetSym.trim().toUpperCase());
      setRun(newRun);
      const evData = await api.researchEvidence(newRun.runId);
      setEvidence(evData.evidence || []);
      loadRecentRuns();
    } catch (err: any) {
      const msg = err.message?.includes('fetch')
        ? 'Cannot connect to backend server (port 3003). Ensure backend is running.'
        : err.message || 'Analysis failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto pb-10">
      <div className="flex items-center gap-1 bg-surface-100 p-1 border border-border rounded-lg w-fit max-w-full overflow-x-auto">
        <button
          onClick={() => setViewMode('dashboard')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all ${viewMode === 'dashboard' ? 'bg-accent text-black font-bold' : 'text-muted hover:text-white'}`}
        >
          <LayoutDashboard size={13} />
          <span>Dashboard</span>
        </button>
        <button
          onClick={() => setViewMode('watchlist')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all ${viewMode === 'watchlist' ? 'bg-accent text-black font-bold' : 'text-muted hover:text-white'}`}
        >
          <Clock size={13} />
          <span>Active Watchlist & Schedule</span>
        </button>
        <button
          onClick={() => setViewMode('screener')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all ${viewMode === 'screener' ? 'bg-accent text-black font-bold' : 'text-muted hover:text-white'}`}
        >
          <Filter size={13} />
          <span>Multi-Stock Screener</span>
        </button>
        <button
          onClick={() => setViewMode('single')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all ${viewMode === 'single' ? 'bg-accent text-black font-bold' : 'text-muted hover:text-white'}`}
        >
          <Search size={13} />
          <span>Single Stock Intelligence</span>
        </button>
      </div>

      {viewMode === 'dashboard' ? (
        <ResearchDashboard
          onSelectSymbol={(s) => {
            setSymbol(s);
            setViewMode('single');
            runAnalysis(s);
          }}
          onOpenScreener={() => setViewMode('screener')}
        />
      ) : viewMode === 'watchlist' ? (
        <ResearchWatchlist
          onSelectSymbol={(s) => {
            setSymbol(s);
            setViewMode('single');
            runAnalysis(s);
          }}
        />
      ) : viewMode === 'screener' ? (
        <ResearchScreener
          onSelectSymbol={(s) => {
            setSymbol(s);
            setViewMode('single');
            runAnalysis(s);
          }}
        />
      ) : (
        <>
          <ResearchHeader symbol={symbol} setSymbol={setSymbol} loading={loading} onAnalyze={(e: any) => { if (e) e.preventDefault(); runAnalysis(symbol); }} />
          {error && <div className="p-3 bg-danger/10 border border-danger/30 rounded text-danger text-xs font-mono">{error}</div>}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            <RecentRunsSidebar runs={runs} activeRunId={run?.runId} onSelect={loadRun} />
            <div className="lg:col-span-3 space-y-4">
              {run ? (
                <>
                  <VerdictScoreBanner verdict={run.verdict} symbol={run.symbol} />
                  <ResearchTabs activeTab={activeTab} onSelect={setActiveTab} count={evidence.length} />
                  {activeTab === 'verdict' && <VerdictTab run={run} />}
                  {activeTab === 'valuation' && <ValuationTab fin={run.financialValuation} />}
                  {activeTab === 'debate' && <DebateTab debate={run.debate} />}
                  {activeTab === 'signal' && <SignalTab signal={run.tradeSignal} options={run.optionsIntelligence} />}
                  {activeTab === 'evidence' && <EvidenceTab evidence={evidence} />}
                </>
              ) : (
                <div className="p-12 text-center text-muted border border-border/50 rounded-lg bg-surface-100">
                  <BookOpen className="mx-auto mb-3 text-muted/50" size={32} />
                  <div className="text-sm font-semibold text-white">No Research Run Loaded</div>
                  <div className="text-xs text-muted mt-1">Search an Indian stock (e.g. RELIANCE, TCS, INFY) to initiate institutional analysis.</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ResearchHeader({ symbol, setSymbol, loading, onAnalyze }: any) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-surface-100 border border-border rounded-lg">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded bg-accent/10 border border-accent/20 flex items-center justify-center text-accent"><BookOpen size={18} /></div>
        <div>
          <div className="text-sm font-bold text-white uppercase tracking-wider">Institutional Equity Research</div>
          <div className="text-[11px] text-muted font-mono">10-Module Fundamental, Moat, DCF & Derivatives Intelligence</div>
        </div>
      </div>
      <form onSubmit={onAnalyze} className="flex items-center gap-2">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="SYMBOL (e.g. RELIANCE)"
          className="w-48 bg-bg border border-border rounded px-3 py-1.5 text-xs text-white uppercase font-mono placeholder:text-muted/50 focus:border-accent outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-accent hover:bg-accent/90 text-black font-semibold text-xs rounded transition-all disabled:opacity-50 cursor-pointer"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          <span>{loading ? 'Analyzing...' : 'Run Research'}</span>
        </button>
      </form>
    </div>
  );
}

function RecentRunsSidebar({ runs, activeRunId, onSelect }: any) {
  return (
    <div className="bg-surface-100 border border-border rounded-lg p-3 space-y-2 h-fit">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider font-semibold px-1">Recent Analyses</div>
      <div className="space-y-1 max-h-[500px] overflow-y-auto">
        {runs.map((r: any) => {
          const isSelected = r.id === activeRunId;
          const color = r.verdict === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : r.verdict === 'AVOID' ? 'text-rose-400 bg-rose-500/10' : 'text-amber-400 bg-amber-500/10';
          return (
            <div
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={`p-2 rounded cursor-pointer transition-all border ${isSelected ? 'bg-surface-200 border-accent/40' : 'hover:bg-surface-200/50 border-transparent'}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white font-mono">{r.symbol}</span>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${color}`}>{r.verdict || 'PENDING'}</span>
              </div>
              <div className="text-[10px] text-muted mt-0.5 flex justify-between">
                <span>Score: {r.quality_score ?? '--'}</span>
                <span>{new Date(r.created_at || Date.now()).toLocaleDateString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VerdictScoreBanner({ verdict, symbol }: any) {
  if (!verdict) return null;
  const badge = verdict.stance === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : verdict.stance === 'AVOID' ? 'bg-rose-500/20 text-rose-400 border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border-amber-500/30';
  return (
    <div className="p-4 bg-surface-100 border border-border rounded-lg flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-white font-mono">{symbol}</h2>
          <span className={`text-xs font-bold font-mono px-2.5 py-0.5 border rounded ${badge}`}>{verdict.stance}</span>
        </div>
        <p className="text-xs text-muted mt-1 max-w-xl">{verdict.summary}</p>
      </div>
      <div className="flex items-center gap-2">
        {[['Quality', verdict.qualityScore, false], ['Valuation', verdict.valuationScore, false], ['Composite', verdict.compositeScore, true]].map(([l, val, h]: any) => (
          <div key={l} className={`p-2 rounded border text-center min-w-[65px] ${h ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-surface-200 border-border text-white'}`}>
            <div className="text-[9px] uppercase font-mono text-muted">{l}</div>
            <div className="text-xs font-bold font-mono mt-0.5">{val ?? '--'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
