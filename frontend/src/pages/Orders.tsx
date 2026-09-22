import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { fmt, sideClass } from '../utils/formatters';
import { CircleX, Plus, RotateCcw } from 'lucide-react';
import { api } from '../services/api';

export function Orders() {
  const { state, showToast, openModal, closeModal, addSystemLog, refreshPortfolio } = useApp();
  const [filter, setFilter] = useState('ALL');
  const [mode, setMode] = useState('paper');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);

  useEffect(() => {
    api.health().then((h) => setMode(h.mode || 'paper')).catch(() => {});
  }, []);

  const isPaper = mode === 'paper';
  const isCancellable = (status: string) => ['PENDING', 'TRANSIT', 'OPEN'].includes((status || '').toUpperCase());
  const pendingCount = state.orders.filter((o) => isCancellable(o.status)).length;

  const handleCancelOrder = async (order: any) => {
    const id = order.id || order.corr;
    if (!id) return;
    setCancellingId(id);
    try {
      await api.cancelOrder(id, order.corr);
      showToast(`Order ${id} cancelled`, 'success');
      addSystemLog('INFO', `Order ${id} (${order.instrument} ${order.side} ${order.qty}) cancelled`, isPaper ? 'paper_execution' : 'broker_execution');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to cancel order: ${e.message}`, 'error');
    } finally {
      setCancellingId(null);
    }
  };

  const handleCancelAllPending = async () => {
    setCancellingAll(true);
    try {
      const res = await api.cancelAllOrders();
      showToast(`Cancelled ${res.cancelledCount || 0} pending order(s)`, 'success');
      addSystemLog('WARN', `Cancelled ${res.cancelledCount || 0} pending order(s) via control plane`, isPaper ? 'paper_execution' : 'broker_execution');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to cancel all orders: ${e.message}`, 'error');
    } finally {
      setCancellingAll(false);
    }
  };

  const filtered = filter === 'ALL'
    ? state.orders
    : state.orders.filter(o => o.status === filter);

  const openPlaceOrderModal = () => {
    let sym = 'NIFTY24JAN24250CE';
    let side: 'BUY' | 'SELL' = 'BUY';
    let qty = 50;
    let px = 185.5;
    let prod = 'INTRADAY';

    openModal(
      <div className="space-y-3">
        <div className="text-sm font-bold text-white mb-2">Place Paper Order (Instant Fill Simulation)</div>
        <div>
          <label className="text-[10px] font-mono text-muted uppercase block mb-1">Symbol / Instrument</label>
          <Input defaultValue={sym} onChange={(e) => { sym = e.target.value; }} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Side</label>
            <Select defaultValue="BUY" onChange={(e) => { side = e.target.value as 'BUY' | 'SELL'; }}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </Select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Quantity</label>
            <Input type="number" defaultValue={qty} onChange={(e) => { qty = Number(e.target.value); }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Simulated Price (₹)</label>
            <Input type="number" defaultValue={px} onChange={(e) => { px = Number(e.target.value); }} />
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Product</label>
            <Select defaultValue="INTRADAY" onChange={(e) => { prod = e.target.value; }}>
              <option value="INTRADAY">INTRADAY</option>
              <option value="MARGIN">MARGIN</option>
            </Select>
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button onClick={async () => {
            try {
              closeModal();
              const res = await api.placePaperOrder({
                symbol: sym,
                quantity: qty,
                transactionType: side,
                price: px,
                productType: prod,
              });
              showToast(`Paper Order Filled: ${side} ${qty}x ${sym} @ ₹${res.fillPrice || px}`, 'success');
              addSystemLog('INFO', `Paper Order ${res.orderId} executed for ${sym}`, 'paper_execution');
              await refreshPortfolio();
            } catch (e: any) {
              showToast(`Order failed: ${e.message}`, 'error');
            }
          }}>Execute Order</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Order Book & Audit Trail</div>
          <div className="text-xs text-muted mt-0.5">
            {isPaper
              ? 'PostgreSQL persisted audit log of paper trading executions'
              : `${mode === 'sandbox' ? 'DhanHQ Sandbox' : 'Live broker'} order book — today\u2019s orders from the ${mode} account`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <Button variant="danger" onClick={handleCancelAllPending} disabled={cancellingAll}>
              <CircleX size={12} className="mr-1" />
              {cancellingAll ? 'Cancelling...' : `Cancel All (${pendingCount})`}
            </Button>
          )}
          <Button variant="ghost" onClick={async () => { await refreshPortfolio(); showToast('Orders refreshed', 'success'); }}>
            <RotateCcw size={12} className="mr-1" /> Refresh
          </Button>
          {isPaper && (
            <Button onClick={openPlaceOrderModal}>
              <Plus size={14} className="mr-1" /> Place Paper Order
            </Button>
          )}
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="text-xs">
            <option value="ALL">All Statuses</option>
            <option value="TRADED">TRADED / FILLED</option>
            <option value="PENDING">PENDING / OPEN</option>
            <option value="REJECTED">REJECTED</option>
            <option value="CANCELLED">CANCELLED</option>
          </Select>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              {['Order ID', 'Correlation ID', 'Time', 'Instrument', 'Type', 'Side', 'Qty', 'Price', 'Filled', 'Avg Price', 'Status', 'Latency', 'Action'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={13} className="text-center py-8 text-muted text-xs">
                  {isPaper
                    ? 'No orders recorded. Click "Place Paper Order" to execute your first paper trade!'
                    : `No ${mode} orders today yet — bot trades will appear here once the scanner or agent places them.`}
                </td>
              </tr>
            ) : (
              filtered.map((o, i) => (
                <tr key={i} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">{o.id}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-sky text-[9.5px] font-mono">{o.corr}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.time}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.instrument}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.type}</td>
                  <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${sideClass(o.side)}`}>{o.side}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.qty}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{fmt(o.price)}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.filled}/{o.qty}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.avg ? fmt(o.avg) : '-'}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60">
                    <Badge status={o.status} />
                    {(o as any).reason && o.status === 'REJECTED' && (
                      <div className="text-[9px] text-danger mt-0.5 max-w-[140px] truncate" title={(o as any).reason}>{(o as any).reason}</div>
                    )}
                  </td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.latency}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60">
                    {isCancellable(o.status) ? (
                      <Button
                        variant="danger"
                        className="text-[9px] px-2 py-0.5"
                        disabled={cancellingId === (o.id || o.corr)}
                        onClick={() => handleCancelOrder(o)}
                      >
                        {cancellingId === (o.id || o.corr) ? 'Cancelling...' : 'Cancel'}
                      </Button>
                    ) : (
                      <span className="text-muted text-[10px]">—</span>
                    )}
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
