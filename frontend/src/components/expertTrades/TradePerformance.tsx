import { Card } from '../ui/Card';
import { fmt, pnlClass } from '../../utils/formatters';
import type { OutcomeStats } from '../../types/expertTrades';

const SETUP_LABEL: Record<string, string> = {
  BREAKOUT: 'Breakout',
  BREAKOUT_RETEST: 'Breakout Retest',
  TREND_PULLBACK: 'Trend Pullback',
  BASE_EXPANSION: 'Base Expansion',
  MOMENTUM_CONTINUATION: 'Momentum Continuation',
};

const pct = (v: number | null, decimals = 0) => (v == null ? '—' : `${fmt(v * 100, decimals)}%`);
const signedPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${fmt(v, 1)}%`);

/**
 * Outcome analytics over closed trade ideas — win rate, target/stop hit
 * rates and expectancy, measured off the actual observed exit price
 * (never the idealized entry/target/stop levels; see analytics.ts).
 * `null` fields render as "—", never as 0%, so an empty track record never
 * reads as "0% win rate".
 */
export function TradePerformance({ overall, bySetup }: { overall: OutcomeStats; bySetup: OutcomeStats[] }) {
  if (overall.sampleSize === 0) {
    return (
      <Card className="p-4 text-xs text-muted">
        No closed, triggered trade ideas yet — outcome statistics need at least one idea to run its full course
        (target hit, stopped out, or expired). {overall.neverTriggered > 0 && `${overall.neverTriggered} idea(s) closed without ever triggering.`}
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono text-muted uppercase tracking-widest font-semibold">
          Outcome Statistics · {overall.sampleSize} realized trade{overall.sampleSize === 1 ? '' : 's'}
        </div>
        {overall.neverTriggered > 0 && (
          <div className="text-[9.5px] font-mono text-muted">{overall.neverTriggered} never triggered (excluded)</div>
        )}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        <Stat label="Win Rate" value={pct(overall.winRate)} valueClass={overall.winRate != null && overall.winRate >= 0.5 ? 'text-accent' : 'text-danger'} />
        <Stat label="Expectancy" value={signedPct(overall.expectancyPct)} valueClass={pnlClass(overall.expectancyPct ?? 0)} />
        <Stat label="T1 Hit Rate" value={pct(overall.target1HitRate)} valueClass="text-sky" />
        <Stat label="T2 Hit Rate" value={pct(overall.target2HitRate)} valueClass="text-sky" />
        <Stat label="Stop Rate" value={pct(overall.stopRate)} valueClass="text-danger" />
        <Stat label="Median Hold" value={overall.medianHoldingDays == null ? '—' : `${fmt(overall.medianHoldingDays, 1)}d`} valueClass="text-white" />
      </div>

      <div className="grid grid-cols-2 gap-3 pt-1 border-t border-border">
        <Stat label="Avg Winner" value={signedPct(overall.avgWinnerPct)} valueClass="text-accent" />
        <Stat label="Avg Loser" value={signedPct(overall.avgLoserPct)} valueClass="text-danger" />
      </div>

      {bySetup.length > 1 && (
        <div className="pt-2 border-t border-border">
          <div className="text-[9px] font-mono text-muted uppercase tracking-wider mb-1.5 font-semibold">By Setup Type</div>
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-muted text-left">
                <th className="font-normal pb-1">Setup</th>
                <th className="font-normal pb-1 text-right">N</th>
                <th className="font-normal pb-1 text-right">Win %</th>
                <th className="font-normal pb-1 text-right">Expectancy</th>
              </tr>
            </thead>
            <tbody>
              {bySetup.map((s) => (
                <tr key={s.setupType} className="border-t border-border/50">
                  <td className="py-1 text-white">{SETUP_LABEL[s.setupType] || s.setupType}</td>
                  <td className="py-1 text-right text-muted">{s.sampleSize}</td>
                  <td className="py-1 text-right">{pct(s.winRate)}</td>
                  <td className={`py-1 text-right font-semibold ${pnlClass(s.expectancyPct ?? 0)}`}>{signedPct(s.expectancyPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div>
      <div className="text-[8.5px] font-mono text-muted uppercase">{label}</div>
      <div className={`text-sm font-mono font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
