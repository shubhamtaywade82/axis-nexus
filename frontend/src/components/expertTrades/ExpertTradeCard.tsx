import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { fmt, pnlClass } from '../../utils/formatters';
import { TrendingUp, ShieldAlert, Clock } from 'lucide-react';
import type { ExpertTrade, ExpertTradeState } from '../../types/expertTrades';

const STATE_STYLE: Record<ExpertTradeState, { label: string; dot: string; text: string; cardBorder: string }> = {
  NEW: { label: 'NEW', dot: 'bg-sky', text: 'text-sky', cardBorder: 'border-sky/20' },
  ACTIVE: { label: 'ACTIVE', dot: 'bg-accent shadow-[0_0_6px_var(--color-accent)]', text: 'text-accent', cardBorder: 'border-accent/25' },
  TARGET_1: { label: 'TARGET 1 HIT', dot: 'bg-accent shadow-[0_0_6px_var(--color-accent)]', text: 'text-accent', cardBorder: 'border-accent/25' },
  TARGET_2: { label: 'TARGET 2 HIT', dot: 'bg-accent', text: 'text-accent', cardBorder: 'border-accent/30' },
  STOPPED: { label: 'STOPPED OUT', dot: 'bg-danger', text: 'text-danger', cardBorder: 'border-danger/25' },
  EXPIRED: { label: 'EXPIRED', dot: 'bg-muted', text: 'text-muted', cardBorder: 'border-border' },
  INVALIDATED: { label: 'INVALIDATED', dot: 'bg-muted', text: 'text-muted', cardBorder: 'border-border' },
};

const SETUP_LABEL: Record<string, string> = {
  BREAKOUT: 'Breakout',
  BREAKOUT_RETEST: 'Breakout Retest',
  TREND_PULLBACK: 'Trend Pullback',
  BASE_EXPANSION: 'Base Expansion',
  MOMENTUM_CONTINUATION: 'Momentum Continuation',
};

const HORIZON_LABEL: Record<string, string> = {
  SHORT_TERM: 'Short Term',
  MID_TERM: 'Mid Term',
  LONG_TERM: 'Long Term',
};

/** Position of the current price along the SL -> Entry -> T1 -> T2 axis, clamped to [0, 1]. */
function axisPosition(trade: ExpertTrade): number {
  const { stopLoss, target2 } = trade.levels;
  const price = trade.lastEvaluatedPrice ?? trade.levels.current;
  if (target2 === stopLoss) return 0.5;
  return Math.min(1, Math.max(0, (price - stopLoss) / (target2 - stopLoss)));
}

export function ExpertTradeCard({ trade, onViewDetail }: { trade: ExpertTrade; onViewDetail?: (id: string) => void }) {
  const style = STATE_STYLE[trade.state];
  const isOpen = trade.state === 'NEW' || trade.state === 'ACTIVE' || trade.state === 'TARGET_1';
  const price = trade.lastEvaluatedPrice ?? trade.levels.current;

  const pnlPct = trade.triggeredAt != null
    ? ((price - trade.levels.entry) / trade.levels.entry) * 100
    : null;

  return (
    <Card className={`p-5 slide-in ${style.cardBorder}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-bold text-white">{trade.symbol}</div>
          <div className="text-[9.5px] font-mono text-muted mt-0.5">
            {trade.name} · {SETUP_LABEL[trade.setup.type] || trade.setup.type} · {HORIZON_LABEL[trade.horizon] || trade.horizon}
          </div>
          {!trade.setup.intradayAligned && (
            <div className="text-[9px] font-mono text-gold mt-0.5 flex items-center gap-1">
              <ShieldAlert size={10} /> 60m structure not yet confirming — daily setup only
            </div>
          )}
        </div>
        <span className="flex items-center gap-1.5">
          <span className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${style.dot}`} />
          <span className={`${style.text} text-[10px] font-mono font-semibold`}>{style.label}</span>
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3 bg-surface-50 p-2.5 rounded border border-border">
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">Current</div>
          <div className="text-lg font-mono font-bold text-white">₹{fmt(price)}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">Score</div>
          <div className="text-lg font-mono font-bold text-sky">{trade.setup.score}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">{trade.triggeredAt != null ? 'Unrealized' : 'Potential'}</div>
          <div className={`text-lg font-mono font-bold ${pnlClass(pnlPct ?? trade.metrics.potentialProfitPct)}`}>
            {(pnlPct ?? trade.metrics.potentialProfitPct) >= 0 ? '+' : ''}{fmt(pnlPct ?? trade.metrics.potentialProfitPct, 1)}%
          </div>
        </div>
      </div>

      <LevelBar trade={trade} position={axisPosition(trade)} />

      <div className="grid grid-cols-4 gap-2 my-3 text-center text-[10px] font-mono">
        <LevelStat label="Stop" value={trade.levels.stopLoss} className="text-danger" />
        <LevelStat label="Entry" value={trade.levels.entry} className="text-sky" />
        <LevelStat label="Target 1" value={trade.levels.target1} className="text-accent" />
        <LevelStat label="Target 2" value={trade.levels.target2} className="text-accent" />
      </div>

      <div className="flex items-center gap-3 text-[10px] font-mono text-muted mb-3">
        <span className="flex items-center gap-1"><TrendingUp size={11} /> R:R {trade.metrics.rr1.toFixed(2)} / {trade.metrics.rr2.toFixed(2)}</span>
        <span className="flex items-center gap-1"><Clock size={11} /> {trade.metrics.expectedHoldingDays.min}-{trade.metrics.expectedHoldingDays.max}d</span>
        {trade.state === 'STOPPED' || trade.state === 'INVALIDATED' ? (
          <span className="flex items-center gap-1 text-danger"><ShieldAlert size={11} /> Risk realized</span>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={() => onViewDetail?.(trade.id)}>View Setup</Button>
        {isOpen && <Button variant="primary" className="flex-1 bg-sky hover:bg-sky/80 text-black font-semibold">Quick Buy</Button>}
      </div>
    </Card>
  );
}

function LevelStat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div>
      <div className="text-muted uppercase text-[8.5px]">{label}</div>
      <div className={`font-bold ${className}`}>₹{fmt(value)}</div>
    </div>
  );
}

/** Visual SL -> Entry -> T1 -> T2 axis with a marker at the current price. */
function LevelBar({ trade, position }: { trade: ExpertTrade; position: number }) {
  const { stopLoss, entry, target1, target2 } = trade.levels;
  const span = target2 - stopLoss || 1;
  const entryPct = ((entry - stopLoss) / span) * 100;
  const t1Pct = ((target1 - stopLoss) / span) * 100;

  return (
    <div className="relative h-1.5 rounded-full bg-surface-50 border border-border">
      <div className="absolute inset-y-0 left-0 rounded-full bg-danger/30" style={{ width: `${Math.max(0, Math.min(100, entryPct))}%` }} />
      <div className="absolute inset-y-0 rounded-full bg-accent/30" style={{ left: `${Math.max(0, Math.min(100, entryPct))}%`, width: `${Math.max(0, Math.min(100, t1Pct - entryPct))}%` }} />
      <div
        className="absolute -top-1 w-3.5 h-3.5 rounded-full bg-white border-2 border-sky shadow-[0_0_4px_rgba(255,255,255,0.6)]"
        style={{ left: `calc(${Math.max(0, Math.min(100, position * 100))}% - 7px)` }}
        title={`CMP ₹${fmt(trade.lastEvaluatedPrice ?? trade.levels.current)}`}
      />
    </div>
  );
}
