import { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { fmt, fmtINR, pnlClass } from '../../utils/formatters';
import { api } from '../../services/api';
import { AlertTriangle } from 'lucide-react';
import type { ExpertTrade, QuickBuyPreview } from '../../types/expertTrades';

/**
 * Preview -> Risk Validation -> Confirm -> Order, per the architecture
 * discussion (section 34): quantity, capital, and max loss are always
 * shown BEFORE an order is placed, and are computed server-side (see
 * services/expertTrades/quickBuy.ts) — this modal never sizes the trade
 * itself, only displays and confirms what the server already decided.
 *
 * Paper-only, v1: exits fully at Target 1 or the stop-loss, whichever
 * comes first (no partial scale-out to Target 2 yet) — stated plainly in
 * the confirm copy rather than left implicit.
 */
export function QuickBuyModal({ trade, onClose, onDone }: { trade: ExpertTrade; onClose: () => void; onDone: (result: { symbol: string; quantity: number; fillPrice: number }) => void }) {
  const [preview, setPreview] = useState<QuickBuyPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.expertTradeQuickBuyPreview(trade.id)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: any) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [trade.id]);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.expertTradeQuickBuy(trade.id);
      if (result.status === 'TRADED') {
        onDone({ symbol: trade.symbol, quantity: result.quantity!, fillPrice: result.fillPrice! });
        onClose();
      } else {
        setError(result.reason || 'Order rejected');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="text-sm font-bold text-white mb-1">Quick Buy — {trade.symbol}</div>
      <div className="text-xs text-muted mb-4">{trade.name} · Paper mode · CNC delivery</div>

      {loading && <div className="text-xs text-muted py-6 text-center">Sizing the trade…</div>}

      {!loading && preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 bg-surface-50 p-3 rounded border border-border">
            <Stat label="Quantity" value={`${preview.quantity} shares`} />
            <Stat label="Capital Required" value={`₹${fmt(preview.capitalRequired, 0)}`} />
            <Stat label="Entry" value={`₹${fmt(preview.entry)}`} />
            <Stat label="Stop Loss" value={`₹${fmt(preview.stopLoss)}`} className="text-danger" />
            <Stat label="Target 1 (exit)" value={`₹${fmt(preview.target1)}`} className="text-accent" />
            <Stat label="Target 2 (reference)" value={`₹${fmt(preview.target2)}`} className="text-muted" />
          </div>

          <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
            <div>
              <div className="text-muted uppercase text-[9px]">Max Loss</div>
              <div className="font-bold text-danger">{fmtINR(-preview.maxLossInr)}</div>
            </div>
            <div>
              <div className="text-muted uppercase text-[9px]">Target 1 Profit</div>
              <div className={`font-bold ${pnlClass(preview.target1ProfitInr)}`}>{fmtINR(preview.target1ProfitInr)}</div>
            </div>
          </div>

          <div className="text-[10px] font-mono text-muted">
            Risk budget: ₹{fmt(preview.riskPerTradeInr, 0)}/idea · Available margin: ₹{fmt(preview.availableMargin, 0)}
          </div>

          <div className="text-[10px] font-mono text-gold bg-gold/8 border border-gold/20 rounded p-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            Exits fully at Target 1 or Stop-Loss — no partial scale-out to Target 2 in this version.
          </div>

          {!preview.riskGate.allowed && (
            <div className="text-[10.5px] font-mono text-danger bg-danger/8 border border-danger/20 rounded p-2">
              Blocked by risk engine: {preview.riskGate.reason}
            </div>
          )}
          {!preview.affordable && (
            <div className="text-[10.5px] font-mono text-danger bg-danger/8 border border-danger/20 rounded p-2">
              Insufficient available margin for this quantity.
            </div>
          )}
          {!preview.eligible && preview.ineligibleReason && (
            <div className="text-[10.5px] font-mono text-danger bg-danger/8 border border-danger/20 rounded p-2">
              {preview.ineligibleReason}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-[10.5px] font-mono text-danger bg-danger/8 border border-danger/20 rounded p-2 mt-3">
          {error}
        </div>
      )}

      <div className="flex gap-2 justify-end mt-5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          className="bg-sky hover:bg-sky/80 text-black font-semibold"
          disabled={loading || submitting || !preview || !preview.eligible || !preview.affordable || !preview.riskGate.allowed}
          onClick={confirm}
        >
          {submitting ? 'Placing…' : 'Confirm Buy (Paper)'}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, className = 'text-white' }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[9px] font-mono text-muted uppercase">{label}</div>
      <div className={`text-sm font-mono font-bold ${className}`}>{value}</div>
    </div>
  );
}
