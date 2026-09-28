import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { api } from '../services/api';

/**
 * Tool registry + agent memory.
 *
 * The tool catalog is fetched LIVE from the backend agent orchestrator,
 * which exposes the actual DhanHQ SDK AgentToolRegistry (44 policy-gated
 * tools). Memory shows persisted agent_events from PostgreSQL — real run
 * history, not seeded anecdotes.
 */
export function AgentToolsMemory() {
  const { state } = useApp();
  const [tools, setTools] = useState<Array<{ name: string; desc: string; type: string; params: string[]; scope: string }>>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [t, e] = await Promise.all([
          api.agentTools().catch((err) => { throw err; }),
          api.agentEvents(30).catch(() => []),
        ]);
        if (!alive) return;
        setTools(t as any);
        setEvents(e as any[]);
        setError(null);
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  const tagClasses: Record<string, string> = {
    read_only: 'bg-sky/10 text-sky',
    trade_adjacent_read: 'bg-gold/10 text-gold',
    destructive_write: 'bg-danger/10 text-danger',
  };

  const liveEvents = state.telemetryEvents.length > 0 ? state.telemetryEvents : events;
  const criticMemories = liveEvents.filter((e) => e.agent === 'critic' && e.summary).slice(0, 8);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <div>
            <div className="text-xs font-bold text-white">Tool Registry (Pillar 2: The Hands)</div>
            <div className="text-[9.5px] font-mono text-muted">Live DhanHQ SDK AgentToolRegistry behind Policy.fromEnv()</div>
          </div>
          <span className="inline-flex items-center px-1.75 py-0.5 rounded text-[9.5px] font-mono font-semibold bg-accent/12 text-accent">{tools.length} Tools</span>
        </div>
        {error && <div className="text-[10px] font-mono text-danger">Registry unavailable: {error}</div>}
        <div className="space-y-2.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
          {tools.map((t) => (
            <div key={t.name} className="p-2.5 rounded bg-surface-50 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-weight-600 font-mono ${tagClasses[t.type] || 'bg-sky/10 text-sky'}`}>{t.type.toUpperCase()}</span>
                <span className="text-xs font-mono font-bold text-white">{t.name}</span>
                <span className="text-[8.5px] font-mono text-muted ml-auto">{t.scope}</span>
              </div>
              <div className="text-[10px] text-muted">{t.desc}</div>
              {t.params?.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {t.params.slice(0, 6).map((p) => (
                    <span key={p} className="text-[8.5px] font-mono bg-bg text-muted px-1.5 py-0.5 rounded border border-border">{p}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {tools.length === 0 && !error && <div className="text-center py-6 text-muted text-[11px]">Loading live tool registry…</div>}
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="p-4 space-y-3">
          <div className="text-xs font-bold text-white border-b border-border pb-2">Agent Memory System (Pillar 3: Memory)</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-sky uppercase mb-1 font-semibold">Working Memory</div>
              <div className="text-[9px] text-muted">Current run context (in-memory).</div>
              <div className="mt-2 text-[9px] font-mono text-sky">{state.agentRunning ? 'ACTIVE RUN' : '[Idle]'}</div>
            </div>
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-gold uppercase mb-1 font-semibold">Short-Term Memory</div>
              <div className="text-[9px] text-muted">Live telemetry events.</div>
              <div className="mt-2 text-[9px] font-mono text-gold">{state.telemetryEvents.length} events</div>
            </div>
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-purple uppercase mb-1 font-semibold">Long-Term Memory</div>
              <div className="text-[9px] text-muted">agent_events table (PostgreSQL).</div>
              <div className="mt-2 text-[9px] font-mono text-purple">{events.length} persisted</div>
            </div>
          </div>
        </Card>

        <Card className="p-4 space-y-2.5">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Critic Agent Run History (persisted)</div>
          <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
            {criticMemories.length === 0 ? (
              <div className="text-center py-6 text-muted text-[11px]">
                No persisted run history yet — completed agent runs store their critic reviews here.
              </div>
            ) : criticMemories.map((m) => (
              <div key={m.id} className="p-2.5 rounded bg-surface-50 border border-border text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9.5px] font-mono text-muted">{m.time}</span>
                  <span className="text-[9px] font-mono text-purple bg-purple/10 px-1.5 py-0.5 rounded">{m.runId}</span>
                </div>
                <div className="text-white/90 text-[11px]">{m.summary}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
