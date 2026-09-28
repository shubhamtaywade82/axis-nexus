import { useRef, useEffect, useCallback } from 'react';
import { fmt } from '../utils/formatters';

export interface PnlPoint { t: number; v: number }

const MIN_AXIS_SPAN_INR = 100;

export function usePnlChart(data: PnlPoint[]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.offsetParent === null) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    // Guard against malformed points (e.g. stale entries from a hot-reload
    // that changed the point shape mid-session) — never let a bad t/v
    // propagate into NaN gridlines or "Invalid Date" axis labels.
    const clean = data.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v));
    if (clean.length === 0) return;
    data = clean;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = (rect.width - 32) * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width - 32}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width - 32;
    const h = rect.height;
    const pad = { top: 15, right: 60, bottom: 25, left: 10 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const values = data.map((p) => p.v);
    let min = Math.min(...values, 0);
    let max = Math.max(...values, 0);
    // A flat or near-flat session (e.g. no trades yet) otherwise yields a
    // sub-rupee axis whose rounded labels read "0, -0, -1, -1, -1".
    if (max - min < MIN_AXIS_SPAN_INR) {
      const mid = (max + min) / 2;
      min = mid - MIN_AXIS_SPAN_INR / 2;
      max = mid + MIN_AXIS_SPAN_INR / 2;
    }
    const range = max - min;

    ctx.strokeStyle = 'rgba(28, 40, 63, 0.7)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    const zeroY = pad.top + ch * (1 - (0 - min) / range);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(w - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    const isPos = values[values.length - 1] >= 0;
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    if (isPos) {
      grad.addColorStop(0, 'rgba(0, 229, 160, 0.16)');
      grad.addColorStop(1, 'rgba(0, 229, 160, 0.0)');
    } else {
      grad.addColorStop(0, 'rgba(255, 59, 92, 0.0)');
      grad.addColorStop(1, 'rgba(255, 59, 92, 0.16)');
    }

    const xFor = (i: number) => pad.left + (data.length > 1 ? (i / (data.length - 1)) * cw : cw / 2);
    const yFor = (v: number) => pad.top + ch * (1 - (v - min) / range);

    ctx.beginPath();
    data.forEach((p, i) => {
      const x = xFor(i), y = yFor(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + cw, h - pad.bottom);
    ctx.lineTo(pad.left, h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    data.forEach((p, i) => {
      const x = xFor(i), y = yFor(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isPos ? '#00e5a0' : '#ff3b5c';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastX = pad.left + cw;
    const lastY = yFor(values[values.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = isPos ? '#00e5a0' : '#ff3b5c';
    ctx.fill();

    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = max - (range / 4) * i;
      ctx.fillText(fmt(Math.round(v) || 0, 0), w - 6, pad.top + (ch / 4) * i + 3);
    }

    // Real clock labels spanning the actual data range — not a fixed guess.
    ctx.textAlign = 'center';
    const labelCount = Math.min(5, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = labelCount > 1 ? Math.round((i / (labelCount - 1)) * (data.length - 1)) : 0;
      const label = new Date(data[idx].t).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
      });
      // Edge labels anchor inward so they are not clipped by the canvas edge.
      ctx.textAlign = i === 0 ? 'left' : i === labelCount - 1 ? 'right' : 'center';
      ctx.fillText(label, xFor(idx), h - 6);
    }
  }, [data]);

  useEffect(() => {
    draw();
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  return canvasRef;
}
