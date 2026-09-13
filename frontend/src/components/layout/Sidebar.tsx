import { StatusDot } from '../ui/StatusDot';
import { useApp } from '../../store/AppContext';
import {
  ChartLine, ChessKnight, Layers, Wallet, Receipt, Brain, Satellite, Database,
  Calculator, Shield, ListChecks, Bell, Terminal, Settings, TrendingUp, BookOpen, Zap,
} from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

const tradingItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <ChartLine size={13} /> },
  { id: 'strategies', label: 'Strategies', icon: <ChessKnight size={13} /> },
  { id: 'options-chain', label: 'Option Chain', icon: <Layers size={13} /> },
  { id: 'positions', label: 'Positions', icon: <Wallet size={13} /> },
  { id: 'orders', label: 'Order Book', icon: <Receipt size={13} /> },
];

const agentItems: NavItem[] = [
  { id: 'agent-console', label: 'Agent Console', icon: <Brain size={13} /> },
  { id: 'research-console', label: 'Research Console', icon: <BookOpen size={13} /> },
  { id: 'scalp-monitor', label: 'Scalp Monitor', icon: <Zap size={13} /> },
  { id: 'agent-monitor', label: 'Ops Telemetry', icon: <Satellite size={13} /> },
  { id: 'agent-tools-memory', label: 'Tools & Memory', icon: <Database size={13} /> },
];

const analyticsItems: NavItem[] = [
  { id: 'options-analysis', label: 'Options Behavior', icon: <TrendingUp size={13} /> },
  { id: 'greeks-analytics', label: 'Greeks & Vol', icon: <Calculator size={13} /> },
  { id: 'margin-risk', label: 'Margin & Risk', icon: <Shield size={13} /> },
];

const infraItems: NavItem[] = [
  { id: 'sidekiq-infra', label: 'Sidekiq Jobs', icon: <ListChecks size={13} /> },
  { id: 'alerts', label: 'Alerts', icon: <Bell size={13} /> },
  { id: 'logs', label: 'Logs & Traces', icon: <Terminal size={13} /> },
  { id: 'config', label: 'Configuration', icon: <Settings size={13} /> },
];

function NavSection({ title, items, activePage, onNavigate }: { title: string; items: NavItem[]; activePage: string; onNavigate: (id: string) => void }) {
  return (
    <>
      <div className="text-[9px] font-mono text-muted uppercase tracking-[0.15em] px-3 py-2 font-semibold">{title}</div>
      {items.map((item) => (
        <div
          key={item.id}
          onClick={() => onNavigate(item.id)}
          className={`flex items-center gap-[9px] px-3.5 py-2 rounded-md cursor-pointer transition-all text-[12.5px] font-medium whitespace-nowrap
            ${activePage === item.id
              ? 'text-accent bg-accent/8 font-semibold'
              : 'text-muted hover:text-white hover:bg-surface-200'}`}
        >
          {item.icon}
          {item.label}
          {item.badge !== undefined && (
            <span className="ml-auto bg-danger/20 text-danger text-[9.5px] font-mono px-1.5 py-0.5 rounded">{item.badge}</span>
          )}
        </div>
      ))}
    </>
  );
}

export function Sidebar({ activePage, onNavigate }: { activePage: string; onNavigate: (id: string) => void }) {
  const { state } = useApp();
  const hasData = state.marketSource !== 'none';
  const tickAge = state.marketTickAgeSec;
  const unreadAlerts = state.alerts.filter((a) => !a.read).length;
  const infraItemsWithBadge = infraItems.map((item) =>
    item.id === 'alerts' && unreadAlerts > 0 ? { ...item, badge: unreadAlerts } : item
  );

  return (
    <aside className="w-[215px] min-w-[215px] bg-surface-100 border-r border-border flex flex-col justify-between">
      <nav className="p-3 space-y-0.5 overflow-y-auto flex-1">
        <NavSection title="Trading Core" items={tradingItems} activePage={activePage} onNavigate={onNavigate} />
        <NavSection title="Agentic Intel" items={agentItems} activePage={activePage} onNavigate={onNavigate} />
        <NavSection title="Analytics & Risk" items={analyticsItems} activePage={activePage} onNavigate={onNavigate} />
        <NavSection title="Infrastructure" items={infraItemsWithBadge} activePage={activePage} onNavigate={onNavigate} />
      </nav>

      <div className="p-3 border-t border-border bg-surface-50 space-y-1.5">
        <div className="text-[8.5px] font-mono text-muted uppercase tracking-widest font-semibold">System Connectivity</div>
        <SystemStatusRow
          label="DhanHQ API"
          latency={hasData ? state.marketSource.toUpperCase() : 'no data'}
          status={hasData ? 'live' : 'error'}
        />
        <SystemStatusRow
          label="WS Ticks"
          latency={state.marketWsConnected ? 'connected' : tickAge != null ? `${tickAge}s stale` : 'REST fallback'}
          status={state.marketWsConnected ? 'live' : 'warn'}
        />
        <SystemStatusRow
          label="Persistence"
          latency={state.persistence}
          status={state.persistence === 'postgres' ? 'live' : 'warn'}
          valueClass="text-sky"
        />
        <SystemStatusRow
          label="LLM"
          latency={state.llmMode}
          status={state.llmMode === 'ollama' ? 'live' : 'idle'}
          valueClass="text-purple"
        />
      </div>
    </aside>
  );
}

function SystemStatusRow({ label, latency, status, valueClass }: { label: string; latency: string; status: 'live' | 'warn' | 'error' | 'idle'; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between text-[10px] font-mono">
      <span className="flex items-center gap-1.5">
        <StatusDot status={status} pulse={status === 'live'} />
        {label}
      </span>
      <span className={valueClass || 'text-accent'}>{latency}</span>
    </div>
  );
}
