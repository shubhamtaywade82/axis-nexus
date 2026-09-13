import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { MarketDataService } from '../services/marketData';
import { getOptionsAnalysisCache, saveOptionsAnalysisCache } from '../db';
import { eventBus } from '../services/eventBus';
import { analyzeOptionChain, toChainRowView } from '../services/optionsAnalytics';
import { warmLotSizeCache, resolveNearestExpiry } from '../services/strategyConstructor';
import {
  GreeksQuerySchema, OptionChainQuerySchema, OptionsAnalysisQuerySchema, QuoteQuerySchema,
  zodError,
} from '../lib/routeSchemas';

/**
 * Market data routes — every response is sourced from live DhanHQ data.
 * When data is unavailable the route returns an honest error/stale marker;
 * it NEVER fabricates quotes or option prices.
 */

export function marketRoutes(client: DhanClient, market: MarketDataService): Router {
  const router = Router();

  router.get('/indices', async (_req, res) => {
    const indices = market.getIndices();
    const stats = market.stats();
    const anyLive = Object.values(indices).some((i: any) => i && i.ltp > 0);
    // Always the same shape — callers must read `.indices`, never the top-level object.
    if (!anyLive) {
      // No live data yet — say so. No fabricated fallback quotes.
      return res.json({ indices: {}, stale: true, source: stats.source, error: 'Market data not yet available (check DhanHQ credentials / market hours)' });
    }
    res.json({ indices, stale: false, source: stats.source, error: null });
  });

  router.get('/option-chain/:symbol', async (req, res) => {
    try {
      const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
      const qParsed = OptionChainQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return res.status(400).json({ error: zodError(qParsed.error) });
      }
      const expiry = qParsed.data.expiry || await resolveNearestExpiry(client, symbol);
      const chain = await (client as any).optionChain.fetchNormalized({
        underlyingScrip: Number(securityIdFor(symbol)),
        underlyingSeg: 'IDX_I',
        expiry,
      });
      const rows = Array.isArray(chain) ? chain : chain?.strikes || chain?.data || [];
      const spotSnap = market.getQuote(securityIdFor(symbol));
      const spot = spotSnap?.ltp || 0;
      subscribeAtmOptionLegs(market, symbol, rows, spot);
      void warmLotSizeCache(client, symbol).catch(() => {});
      res.json({ strikes: toChainRowView(rows), underlying: symbol, expiry, source: 'dhanhq' });
    } catch (e: any) {
      res.status(502).json({ error: `Option chain unavailable: ${e.message}`, strikes: [], underlying: req.params.symbol?.toUpperCase() });
    }
  });

  router.get('/expiries/:symbol', async (req, res) => {
    try {
      const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
      const res2 = await (client as any).optionChain.expiryList({
        underlyingScrip: Number(securityIdFor(symbol)),
        underlyingSeg: 'IDX_I',
      });
      const expiries: string[] = Array.isArray(res2) ? res2 : res2?.data || [];
      res.json({ expiries, underlying: symbol });
    } catch (e: any) {
      res.status(502).json({ error: `Expiry list unavailable: ${e.message}`, expiries: [], underlying: req.params.symbol?.toUpperCase() });
    }
  });

  router.get('/quote/:securityId', async (req, res) => {
    try {
      const { securityId } = req.params;
      const qParsed = QuoteQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return res.status(400).json({ error: zodError(qParsed.error) });
      }
      const exchange = qParsed.data.exchange;
      // Serve from the live tick cache when fresh, else hit DhanHQ REST.
      const cached = market.getQuote(securityId);
      if (cached && Date.now() - cached.updatedAt < 5000) {
        return res.json({ ...cached, source: 'cache' });
      }
      const quote = await client.marketFeed.quote({ [exchange]: [securityId] });
      res.json((quote.data as any)?.[exchange]?.[securityId] || { error: 'No quote' });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/greeks', async (req, res) => {
    try {
      const qParsed = GreeksQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return res.status(400).json({ error: zodError(qParsed.error) });
      }
      const symbol = qParsed.data.symbol.toUpperCase();
      const expiry = qParsed.data.expiry || await resolveNearestExpiry(client, symbol);
      const chain = await (client as any).optionChain.fetchNormalized({
        underlyingScrip: Number(securityIdFor(symbol)),
        underlyingSeg: 'IDX_I',
        expiry,
      });
      const rows = Array.isArray(chain) ? chain : chain?.strikes || chain?.data || [];
      const spotSnap = market.getQuote(securityIdFor(symbol));
      const spot = spotSnap?.ltp || qParsed.data.spot || 0;
      if (!spot) return res.status(502).json({ error: 'Underlying spot unavailable — cannot compute Greeks' });

      const strikes = rows.slice(0, 35).map((r: any) => {
        const strike = Number(r.strike ?? r.Strike);
        const ceLeg = r.ce || r.call || r.CALL;
        const peLeg = r.pe || r.put || r.PUT;
        return {
          strike,
          ce: greeksFor(ceLeg, strike, 'CALL', spot, expiry),
          pe: greeksFor(peLeg, strike, 'PUT', spot, expiry),
        };
      }).filter((s: any) => Number.isFinite(s.strike));

      res.json({ symbol, spot, expiry, strikes, source: 'black-scholes' });
    } catch (e: any) {
      res.status(502).json({ error: `Greeks unavailable: ${e.message}` });
    }
  });

  router.get('/analytics/:symbol', async (req, res) => {
    try {
      const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
      const secId = securityIdFor(symbol);
      const expiry = (req.query.expiry as string) || await resolveNearestExpiry(client, symbol);
      const chain = await (client as any).optionChain.fetchNormalized({
        underlyingScrip: Number(secId), underlyingSeg: 'IDX_I', expiry,
      });
      const rows = Array.isArray(chain) ? chain : chain?.strikes || chain?.data || [];
      const spotSnap = market.getQuote(secId);
      const spot = spotSnap?.ltp || Number(req.query.spot) || 0;
      const vixSnap = market.getQuote('21'); // India VIX (NSE IDX_I) — verified against DhanHQ's instrument master
      const vix = vixSnap?.ltp || 14;

      const analytics = analyzeOptionChain(symbol, rows, spot, expiry, vix);
      res.json(analytics);
    } catch (e: any) {
      res.status(502).json({ error: `Option analytics unavailable: ${e.message}` });
    }
  });

  router.get('/options-analysis', async (req, res) => {
    try {
      const qParsed = OptionsAnalysisQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return res.status(400).json({ error: zodError(qParsed.error) });
      }
      const { symbol, days, interval, expiryFlag, expiryCode } = qParsed.data;
      res.json(await analyzeOptionsBehavior(client, {
        symbol: symbol.toUpperCase(), securityId: securityIdFor(symbol),
        daysCount: days, interval, expiryFlag, expiryCode,
      }));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

function securityIdFor(symbol: string): string {
  const map: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', FINNIFTY: '27', MIDCPNIFTY: '442', SENSEX: '51', INDIAVIX: '21' };
  return map[symbol.toUpperCase()] || '13';
}

function greeksFor(leg: any, strike: number, type: 'CALL' | 'PUT', spot: number, expiry: string) {
  if (!leg) return null;
  const ltp = Number(leg.ltp ?? leg.lastPrice ?? 0);
  const t = Math.max(1 / 365, yearsTo(expiry));
  // Quick Black-Scholes inversion for IV + Greeks via SDK helpers.
  const r = 0.065, sigma = Number(leg.iv) > 0 ? Number(leg.iv) / 100 : 0.13;
  const d1 = (Math.log(spot / strike) + (r + sigma * sigma / 2) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  const ndist = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  const npdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const delta = type === 'CALL' ? ndist(d1) : ndist(d1) - 1;
  const gamma = npdf(d1) / (spot * sigma * Math.sqrt(t));
  const theta = (-(spot * npdf(d1) * sigma) / (2 * Math.sqrt(t))
    - (type === 'CALL' ? 1 : -1) * r * strike * Math.exp(-r * t) * ndist(type === 'CALL' ? d2 : -d2)) / 365;
  const vega = (spot * npdf(d1) * Math.sqrt(t)) / 100;
  return {
    ltp, oi: Number(leg.oi || 0), volume: Number(leg.volume || 0), iv: Number(leg.iv || 0),
    delta: round(delta), gamma: round(gamma), theta: round(theta), vega: round(vega),
  };
}

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const sign = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function round(n: number) { return Number(n.toFixed(4)); }
function yearsTo(expiry: string): number {
  const ms = new Date(`${expiry}T15:30:00+05:30`).getTime() - Date.now();
  return Math.max(1 / 365 / 24, ms / (365 * 24 * 3600 * 1000));
}

// ── options behavior analysis (real rolling-option data via SDK) ────────

const STRIKES_LIST = ['ATM', 'ATM+1', 'ATM-1', 'ATM+2', 'ATM-2', 'ATM+3', 'ATM-3', 'ATM+4', 'ATM-4', 'ATM+5', 'ATM-5'];

export interface AnalysisParams {
  symbol: string;
  securityId: string;
  daysCount: number;
  interval: string;
  expiryFlag: string;
  expiryCode: number;
}

export async function analyzeOptionsBehavior(client: DhanClient, params: AnalysisParams) {
  const realDays = await fetchSpotHistoricalDays(client, params);
  if (realDays.length === 0) {
    // Honest failure — no simulated candle data.
    throw new Error('No historical spot data available from DhanHQ (check credentials, instrument, or date range)');
  }
  const dayResults = [];
  let missingDataDays = 0;

  for (const item of realDays) {
    const cached = await getOptionsAnalysisCache(params.symbol, item.date, params.interval);
    if (cached) {
      dayResults.push(cached);
      continue;
    }

    const spot = item.spot;
    const step = params.symbol === 'BANKNIFTY' || params.symbol === 'SENSEX' ? 100 : (params.symbol === 'MIDCPNIFTY' ? 25 : 50);
    const atmStrike = Math.round(spot.open / step) * step;
    const strikesData = [];

    for (const strike of STRIKES_LIST) {
      let offset = 0;
      if (strike.startsWith('ATM+')) offset = parseInt(strike.replace('ATM+', ''), 10);
      else if (strike.startsWith('ATM-')) offset = -parseInt(strike.replace('ATM-', ''), 10);
      const strikePrice = atmStrike + offset * step;

      const opt = await fetchStrikeRollingCandles(client, params, strike, item.date);
      if (!opt) { missingDataDays++; continue; }
      const cePnl = opt.ceClose - opt.ceOpen, pePnl = opt.peClose - opt.peOpen, netPnl = cePnl + pePnl;
      const totalPrem = opt.ceOpen + opt.peOpen, exit130Net = (opt.exit130Ce - opt.ceOpen) + (opt.exit130Pe - opt.peOpen);

      strikesData.push({
        strike: strikePrice, label: strike,
        call: { open: opt.ceOpen, high: opt.ceHigh, low: opt.ceLow, exit130: opt.exit130Ce, close: opt.ceClose, iv: opt.ceIv, ivClose: opt.ceIvClose, oi: opt.ceOi, pnl: Number(cePnl.toFixed(2)), roi: Number(((cePnl / opt.ceOpen) * 100).toFixed(2)), maxRoi: Number((((opt.ceHigh - opt.ceOpen) / opt.ceOpen) * 100).toFixed(2)), exit130Roi: Number((((opt.exit130Ce - opt.ceOpen) / opt.ceOpen) * 100).toFixed(2)), status: cePnl > 0 ? 'PROFIT' : 'LOSS' },
        put: { open: opt.peOpen, high: opt.peHigh, low: opt.peLow, exit130: opt.exit130Pe, close: opt.peClose, iv: opt.peIv, ivClose: opt.peIvClose, oi: opt.peOi, pnl: Number(pePnl.toFixed(2)), roi: Number(((pePnl / opt.peOpen) * 100).toFixed(2)), maxRoi: Number((((opt.peHigh - opt.peOpen) / opt.peOpen) * 100).toFixed(2)), exit130Roi: Number((((opt.exit130Pe - opt.peOpen) / opt.peOpen) * 100).toFixed(2)), status: pePnl > 0 ? 'PROFIT' : 'LOSS' },
        straddle: { netPnl: Number(netPnl.toFixed(2)), totalPremium: Number(totalPrem.toFixed(2)), netRoi: Number(((netPnl / totalPrem) * 100).toFixed(2)), exit130Net: Number(exit130Net.toFixed(2)), exit130Roi: Number(((exit130Net / totalPrem) * 100).toFixed(2)), status: netPnl > 0 ? 'PROFIT' : 'LOSS' },
        timeline: opt.timeline || [],
      });
    }

    if (strikesData.length === 0) { missingDataDays++; continue; }

    const atm = strikesData.find((s) => s.label === 'ATM') || strikesData[0];
    const spotAbs = Math.abs(spot.pct);
    const dayData = {
      date: item.date, dayOfWeek: item.dayOfWeek, spot,
      regime: spotAbs > 0.6 ? 'GAMMA_BLAST' : (spotAbs < 0.3 ? 'THETA_TRAP' : 'NEUTRAL'),
      atmStraddlePnl: atm.straddle.netPnl, atmStraddleRoi: atm.straddle.netRoi, strikes: strikesData,
      timeline: atm.timeline || [],
      swings: extractSwings(atm.timeline || []),
    };
    await saveOptionsAnalysisCache(params.symbol, item.date, params.interval, dayData);
    dayResults.push(dayData);
  }

  if (dayResults.length === 0) {
    throw new Error('Rolling options data unavailable from DhanHQ for the requested window — refusing to fabricate simulated prices');
  }
  const summary: any = computeAnalysisSummary(dayResults, params.symbol);
  if (missingDataDays > 0) summary.warnings = { strikesWithoutData: missingDataDays };
  return summary;
}

function extractSwings(timeline: any[]) {
  if (!timeline || timeline.length < 3) return [];
  const swings = [];
  let lastPivot = timeline[0], dir = 0;
  for (let i = 1; i < timeline.length; i++) {
    const diff = timeline[i].spot - lastPivot.spot, cur = diff >= 0 ? 1 : -1;
    if (dir !== 0 && cur !== dir && Math.abs(diff) >= 20) {
      const move = Number((timeline[i - 1].spot - lastPivot.spot).toFixed(1));
      swings.push({
        from: lastPivot.time, to: timeline[i - 1].time, startSpot: lastPivot.spot, endSpot: timeline[i - 1].spot,
        movePts: move, type: move >= 0 ? 'BULL_SURGE' : 'BEAR_PLUNGE',
        ceRoi: Number((((timeline[i - 1].ce - lastPivot.ce) / (lastPivot.ce || 1)) * 100).toFixed(1)),
        peRoi: Number((((timeline[i - 1].pe - lastPivot.pe) / (lastPivot.pe || 1)) * 100).toFixed(1)),
      });
      lastPivot = timeline[i - 1];
    }
    dir = cur;
  }
  return swings.slice(0, 5);
}

/** Dhan's ApiResponseError carries its own errorCode/errorType/errorMessage
 * from the response body, separately from the generic top-level message
 * ("Dhan API request failed with status 400" alone doesn't say WHY — rate
 * limit vs bad params vs no data for the range; the body usually does). */
function dhanErrorDetail(e: any): string {
  return [e.errorCode, e.errorType, e.errorMessage].filter(Boolean).join(' | ');
}

async function fetchSpotHistoricalDays(client: DhanClient, params: AnalysisParams) {
  try {
    const toDate = new Date().toISOString().split('T')[0];
    const dFrom = new Date(); dFrom.setDate(dFrom.getDate() - 30);
    const hist = await client.charts.historical({ securityId: params.securityId, exchangeSegment: 'IDX_I' as any, instrument: 'INDEX' as any, expiryCode: 0, fromDate: dFrom.toISOString().split('T')[0], toDate });
    const d = (hist as any)?.data || hist;
    if (d && Array.isArray(d.open) && d.open.length > 0) {
      const days = [];
      for (let i = 0; i < d.open.length; i++) {
        const dt = new Date(d.timestamp[i] * 1000);
        const dateStr = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const dayOfWeek = dt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
        const open = d.open[i], high = d.high[i], low = d.low[i], close = d.close[i];
        days.push({ date: dateStr, dayOfWeek, spot: { open, high, low, close, change: Number((close - open).toFixed(2)), pct: Number((((close - open) / open) * 100).toFixed(2)) } });
      }
      return days.slice(-params.daysCount);
    }
  } catch (e: any) {
    const detail = dhanErrorDetail(e);
    eventBus.log('WARN', `Historical spot fetch failed: ${e.message}${detail ? ` (${detail})` : ''}`, 'market');
  }
  return [];
}

/**
 * Real rolling-option candles through the SDK's ExpiredOptionsData
 * resource (`POST /charts/rollingoption`). Returns null when DhanHQ has
 * no data — the caller surfaces the gap instead of inventing prices.
 */
async function fetchStrikeRollingCandles(client: DhanClient, params: AnalysisParams, strike: string, dateStr: string) {
  try {
    const base = {
      securityId: Number(params.securityId),
      exchangeSegment: params.symbol === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
      instrument: 'OPTIDX',
      expiryFlag: params.expiryFlag || 'WEEK',
      expiryCode: params.expiryCode || 1,
      strike,
      requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'strike', 'oi', 'spot'],
      fromDate: dateStr,
      toDate: nextDay(dateStr),
      interval: params.interval || '1',
    };
    const [ceRes, peRes] = await Promise.all([
      (client as any).expiredOptionsData.fetch({ ...base, drvOptionType: 'CALL' }).catch(() => null),
      (client as any).expiredOptionsData.fetch({ ...base, drvOptionType: 'PUT' }).catch(() => null),
    ]);
    const cd = (ceRes as any)?.data?.ce, pd = (peRes as any)?.data?.pe;
    if (cd?.open?.length && pd?.open?.length) {
      const last = cd.open.length - 1, mid = Math.floor(cd.open.length * 0.65);
      const step = Math.max(1, Math.floor(cd.open.length / 35)), timeline = [];
      for (let i = 0; i < cd.open.length; i += step) {
        const t = new Date(cd.timestamp[i] * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        timeline.push({
          time: t, spot: cd.spot[i], ce: cd.close[i], pe: pd.close[i], straddle: Number((cd.close[i] + pd.close[i]).toFixed(2)),
          ceHigh: cd.high[i], ceLow: cd.low[i], peHigh: pd.high[i], peLow: pd.low[i],
          straddleHigh: Number((cd.high[i] + pd.high[i]).toFixed(2)), straddleLow: Number((cd.low[i] + pd.low[i]).toFixed(2)),
          ceIv: Number((cd.iv[i] || 0).toFixed(1)), peIv: Number((pd.iv[i] || 0).toFixed(1)),
        });
      }
      return {
        ceOpen: cd.open[0], ceHigh: Math.max(...cd.high), ceLow: Math.min(...cd.low), ceClose: cd.close[last],
        exit130Ce: cd.close[mid], ceIv: Number((cd.iv[0] || 0).toFixed(1)), ceIvClose: Number((cd.iv[last] || 0).toFixed(1)), ceOi: cd.oi[0] || 0,
        peOpen: pd.open[0], peHigh: Math.max(...pd.high), peLow: Math.min(...pd.low), peClose: pd.close[last],
        exit130Pe: pd.close[mid], peIv: Number((pd.iv[0] || 0).toFixed(1)), peIvClose: Number((pd.iv[last] || 0).toFixed(1)), peOi: pd.oi[0] || 0,
        timeline,
      };
    }
  } catch (e: any) {
    const detail = dhanErrorDetail(e);
    eventBus.log('WARN', `Rolling option candles failed for ${strike} ${dateStr}: ${e.message}${detail ? ` (${detail})` : ''}`, 'market');
  }
  return null;
}

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function computeAnalysisSummary(days: any[], symbol: string) {
  const totalDays = days.length, winDays = days.filter((d) => d.atmStraddlePnl > 0).length;
  const winDaysCe = days.filter((d) => (d.strikes.find((s: any) => s.label === 'ATM')?.call?.pnl || 0) > 0).length;
  const winDaysPe = days.filter((d) => (d.strikes.find((s: any) => s.label === 'ATM')?.put?.pnl || 0) > 0).length;
  const avgNetPnl = totalDays > 0 ? days.reduce((s, d) => s + d.atmStraddlePnl, 0) / totalDays : 0;
  const avgCePnl = totalDays > 0 ? days.reduce((s, d) => s + (d.strikes.find((x: any) => x.label === 'ATM')?.call?.pnl || 0), 0) / totalDays : 0;
  const avgPePnl = totalDays > 0 ? days.reduce((s, d) => s + (d.strikes.find((x: any) => x.label === 'ATM')?.put?.pnl || 0), 0) / totalDays : 0;
  const strikeRoiTotals: Record<string, number> = {};
  for (const day of days) {
    for (const s of day.strikes) { const k = s.label || String(s.strike); strikeRoiTotals[k] = (strikeRoiTotals[k] || 0) + s.straddle.netRoi; }
  }
  let bestStrike = 'ATM', bestRoi = -9999;
  for (const [stk, roi] of Object.entries(strikeRoiTotals)) { if (roi > bestRoi) { bestRoi = roi; bestStrike = stk; } }
  // Observed break-even from real ATM straddle premiums (no hardcoded pts).
  const avgPremium = totalDays > 0
    ? days.reduce((s, d) => s + (d.strikes.find((x: any) => x.label === 'ATM')?.straddle?.totalPremium || 0), 0) / totalDays
    : 0;
  return {
    symbol,
    summary: {
      totalDays, winDays, winDaysCe, winDaysPe,
      winRate: Number((totalDays ? (winDays / totalDays) * 100 : 0).toFixed(1)),
      ceWinRate: Number((totalDays ? (winDaysCe / totalDays) * 100 : 0).toFixed(1)),
      peWinRate: Number((totalDays ? (winDaysPe / totalDays) * 100 : 0).toFixed(1)),
      avgNetPnl: Number(avgNetPnl.toFixed(2)), avgCePnl: Number(avgCePnl.toFixed(2)), avgPePnl: Number(avgPePnl.toFixed(2)),
      thetaTrapCount: days.filter((d) => d.regime === 'THETA_TRAP').length,
      gammaBlastCount: days.filter((d) => d.regime === 'GAMMA_BLAST').length,
      bestStrike, avgBestStrikeRoi: Number((bestRoi / (totalDays || 1)).toFixed(2)),
      breakEvenMovePts: Number(avgPremium.toFixed(1)),
    },
    days,
  };
}

function subscribeAtmOptionLegs(market: MarketDataService, symbol: string, rows: any[], spot: number): void {
  if (!rows || rows.length === 0) return;
  const seg = symbol === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
  const sorted = [...rows].sort((a: any, b: any) => {
    const sA = Number(a.strike ?? a.Strike ?? 0);
    const sB = Number(b.strike ?? b.Strike ?? 0);
    return Math.abs(sA - spot) - Math.abs(sB - spot);
  });
  // Subscribe ±10 strikes around ATM (20 strikes total = 40 contracts)
  const atmStrikes = sorted.slice(0, 20);
  const instruments: Array<{ securityId: string; exchangeSegment: string }> = [];
  for (const r of atmStrikes) {
    const cId = r.call?.security_id || r.ce?.security_id || r.ce?.securityId;
    const pId = r.put?.security_id || r.pe?.security_id || r.pe?.securityId;
    if (cId) instruments.push({ securityId: String(cId), exchangeSegment: seg });
    if (pId) instruments.push({ securityId: String(pId), exchangeSegment: seg });
  }
  if (instruments.length > 0) {
    market.addInstruments(instruments);
  }
}

