import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusDot } from '../components/ui/StatusDot';
import { Trash } from 'lucide-react';

const AGENT_PERSONAS: Record<string, { name: string; color: string }> = {
  planner: { name: 'Planner Agent', color: '#38bdf8' },
  analyst: { name: 'Market Analyst', color: '#00d4aa' },
  strategy: { name: 'Strategy Agent', color: '#f0b429' },
  execution: { name: 'Execution Agent', color: '#a855f7' },
  risk: { name: 'Risk Agent', color: '#ff3b5c' },
  critic: { name: 'Critic Agent', color: '#f472b6' },
};

export function AgentMonitor() {
  const { state, setState, showToast } = useApp();

  const setEventFilter = (f: string) => {
    setState(prev => ({ ...prev, eventFilter: f }));
  };

  const filtered = state.eventFilter === 'all'
    ? state.telemetryEvents
    : state.telemetryEvents.filter(e => e.type === state.eventFilter);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      <div className="space-y-4">
        <Card className="p-3.5 space-y-2">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest font-semibold">Active Agent Instances</div>
          {Object.entries(AGENT_PERSONAS).map(([k, a]) => {
            const s = state.agentStatus[k] || { status: 'idle', steps: 0 };
            return (
              <div key={k} className="flex items-center justify-between text-xs font-mono p-1.5 rounded bg-surface-50 border border-border">
                <div className="flex items-center gap-2">
                  <StatusDot status={s.status === 'active' ? 'live' : 'idle'} pulse={s.status === 'active'} />
                  <span style={{ color: a.color }} className="font-bold">{a.name}</span>
                </div>
                <span className="text-[10px] text-muted">{s.status === 'active' ? <span className="text-accent blink">RUNNING</span> : 'IDLE'}</span>
              </div>
            );
          })}
        </Card>

        <Card className="p-3.5 space-y-2">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest font-semibold">Session Metrics</div>
          <div className="flex justify-between text-xs font-mono"><span className="text-muted">Total Steps</span><span className="text-white font-bold">{state.telemetryEvents.length}</span></div>
          <div className="flex justify-between text-xs font-mono"><span className="text-muted">Tool Invocations</span><span className="text-sky font-bold">{state.agentDhanCalls}</span></div>
          <div className="flex justify-between text-xs font-mono"><span className="text-muted">Est. Tokens</span><span className="text-purple font-bold">~{state.agentTokens}</span></div>
        </Card>
      </div>

      <Card className="lg:col-span-3 p-4 flex flex-col h-[70vh] lg:h-[calc(100vh-140px)]">
        <div className="flex items-center justify-between pb-3 border-b border-border mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-white">Event Log Telemetry Stream</span>
            <span className="text-[9px] font-mono text-accent bg-accent/10 px-2 py-0.5 rounded">READY</span>
          </div>
          <Button variant="ghost" className="text-[10px] py-1" onClick={() => { setState(prev => ({ ...prev, telemetryEvents: [] })); showToast('Telemetry cleared', 'success'); }}>
            <Trash size={10} className="mr-1" /> Clear
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {['all', 'THINK', 'ACT', 'OBSERVE', 'CRITIQUE', 'ERROR'].map((f) => (
            <button
              key={f}
              onClick={() => setEventFilter(f)}
              className={`px-3 py-[5px] cursor-pointer rounded text-[10px] font-semibold uppercase tracking-[0.3px] transition-all
                ${state.eventFilter === f ? 'text-accent bg-accent/8' : 'text-muted hover:text-white hover:bg-surface-200'}`}
            >
              {f === 'all' ? 'ALL' : f === 'ACT' ? 'ACT (TOOL)' : f}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5">
          {filtered.length === 0 && (
            <div className="text-center py-12 text-muted font-mono text-xs">No agent events recorded yet.</div>
          )}
          {filtered.map((ev) => {
            const a = AGENT_PERSONAS[ev.agent] || AGENT_PERSONAS.planner;
            return (
              <div key={ev.id} className="card p-3 slide-in border-l-2 text-xs font-mono" style={{ borderLeftColor: a.color }}>
                <div className="flex items-center justify-between pb-1 mb-1 border-b border-border text-[9.5px]">
                  <div className="flex items-center gap-1.5">
                    <StatusDot status="live" />
                    <span style={{ color: a.color }} className="font-bold">{a.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold
                      ${ev.type === 'THINK' ? 'bg-sky/12 text-sky' : ev.type === 'ACT' ? 'bg-accent/12 text-accent' : 'bg-gold/12 text-gold'}`}>
                      {ev.type}
                    </span>
                    <span>{ev.time}</span>
                  </div>
                </div>
                <div className="text-white/80">{ev.summary}</div>
                {ev.tool && <div className="code-blk mt-1.5 text-sky">{ev.tool}</div>}
                {ev.response && <div className="code-blk mt-1 text-muted">{ev.response}</div>}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
