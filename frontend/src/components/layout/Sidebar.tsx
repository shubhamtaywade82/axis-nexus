import { useEffect, useRef } from 'react';
import { StatusDot } from '../ui/StatusDot';
import { useApp } from '../../store/AppContext';
import {
  ChartLine, Layers, Brain, BookOpen, Zap, Shield, Server,
} from 'lucide-react';

interface NavTab {
  id: string;
  label: string;
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ReactNode;
  tabs: NavTab[];
}

/** Sidebar shows one entry per group; a group's pages render as tabs above
 * the content (see SectionTabs). Page ids stay the URL hash, so deep links
 * like #positions keep working. */
const NAV_GROUPS: NavGroup[] = [
  { id: 'overview', label: 'Dashboard', icon: <ChartLine size={15} />, tabs: [{ id: 'dashboard', label: 'Dashboard' }] },
  {
    id: 'trading', label: 'Trading', icon: <Layers size={15} />, tabs: [
      { id: 'positions', label: 'Positions' },
      { id: 'orders', label: 'Order Book' },
      { id: 'strategies', label: 'Strategies' },
      { id: 'options-chain', label: 'Option Chain' },
    ],
  },
  {
    id: 'scalping', label: 'Scalping', icon: <Zap size={15} />, tabs: [
      { id: 'scalp-monitor', label: 'Monitor' },
      { id: 'scalp-simulator', label: 'Simulator' },
    ],
  },
  {
    id: 'analytics', label: 'Analytics & Risk', icon: <Shield size={15} />, tabs: [
      { id: 'margin-risk', label: 'Margin & Risk' },
      { id: 'greeks-analytics', label: 'Greeks & Vol' },
      { id: 'options-analysis', label: 'Options Behavior' },
    ],
  },
  {
    id: 'research', label: 'Research', icon: <BookOpen size={15} />, tabs: [
      { id: 'research-console', label: 'Research Console' },
      { id: 'expert-trades', label: 'Expert Trades' },
    ],
  },
  {
    id: 'agents', label: 'Agents', icon: <Brain size={15} />, tabs: [
      { id: 'agent-console', label: 'Console' },
      { id: 'agent-monitor', label: 'Ops Telemetry' },
      { id: 'agent-tools-memory', label: 'Tools & Memory' },
    ],
  },
  {
    id: 'system', label: 'System', icon: <Server size={15} />, tabs: [
      { id: 'alerts', label: 'Alerts' },
      { id: 'logs', label: 'Logs & Traces' },
      { id: 'sidekiq-infra', label: 'Jobs' },
      { id: 'config', label: 'Configuration' },
    ],
  },
];

function findNavGroup(pageId: string): NavGroup {
  return NAV_GROUPS.find((g) => g.tabs.some((t) => t.id === pageId)) ?? NAV_GROUPS[0];
}

function useUnreadAlertCount(): number {
  const { state } = useApp();
  return state.alerts.filter((a) => !a.read).length;
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="ml-auto bg-danger/20 text-danger text-[9.5px] font-mono px-1.5 py-0.5 rounded">{count}</span>;
}

/** Tab strip for the active group's pages; renders nothing for single-page groups. */
export function SectionTabs({ activePage, onNavigate }: { activePage: string; onNavigate: (id: string) => void }) {
  const unreadAlerts = useUnreadAlertCount();
  const group = findNavGroup(activePage);
  if (group.tabs.length < 2) return null;
  return (
    <div role="tablist" className="flex items-center gap-1 mb-4 border-b border-border overflow-x-auto whitespace-nowrap">
      {group.tabs.map((tab) => {
        const isActive = tab.id === activePage;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onNavigate(tab.id)}
            className={`flex items-center gap-2 px-3.5 py-2 -mb-px text-[12.5px] font-medium border-b-2 transition-colors
              focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent
              ${isActive ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-white hover:border-surface-400'}`}
          >
            {tab.label}
            {tab.id === 'alerts' && <CountBadge count={unreadAlerts} />}
          </button>
        );
      })}
    </div>
  );
}

interface SidebarProps {
  activePage: string;
  onNavigate: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ activePage, onNavigate, isOpen, onClose }: SidebarProps) {
  const { state } = useApp();
  const hasData = state.marketSource !== 'none';
  const tickAge = state.marketTickAgeSec;
  const unreadAlerts = useUnreadAlertCount();
  const activeGroupId = findNavGroup(activePage).id;
  // Re-opening a group returns to the tab last used in it, not its first tab.
  const lastTabByGroup = useRef<Record<string, string>>({});
  useEffect(() => {
    lastTabByGroup.current[activeGroupId] = activePage;
  }, [activeGroupId, activePage]);

  return (
    <>
    {isOpen && (
      <div className="fixed inset-0 top-14 z-30 bg-black/60 backdrop-blur-[1px] lg:hidden" onClick={onClose} aria-hidden="true" />
    )}
    {/* Below lg the sidebar is an off-canvas drawer; from lg up it is static. */}
    <aside
      className={`fixed top-14 bottom-0 left-0 z-40 w-[240px] lg:static lg:w-[215px] lg:min-w-[215px] lg:translate-x-0
        bg-surface-100 border-r border-border flex flex-col justify-between transition-transform duration-200 ease-out
        ${isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}
    >
      <nav className="p-3 space-y-1 overflow-y-auto flex-1">
        {NAV_GROUPS.map((group) => {
          const isActive = group.id === activeGroupId;
          return (
            <button
              type="button"
              key={group.id}
              onClick={() => onNavigate(lastTabByGroup.current[group.id] ?? group.tabs[0].id)}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-md cursor-pointer transition-colors text-[13px] font-medium whitespace-nowrap text-left border-l-2
                focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent
                ${isActive
                  ? 'text-accent bg-accent/8 font-semibold border-accent'
                  : 'text-muted border-transparent hover:text-white hover:bg-surface-200'}`}
            >
              {group.icon}
              {group.label}
              {group.id === 'system' && <CountBadge count={unreadAlerts} />}
              {group.tabs.length > 1 && !isActive && !(group.id === 'system' && unreadAlerts > 0) && (
                <span className="ml-auto text-[9.5px] font-mono text-muted/70">{group.tabs.length}</span>
              )}
            </button>
          );
        })}
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
    </>
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
