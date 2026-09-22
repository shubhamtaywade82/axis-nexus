import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { candlesFromSeries, supertrend, adx } from '@nemesis-oss/dhanhq-sdk';
import { istParts } from '../marketHours';
import type { InstrumentRef } from '../research/types';

export interface IntradayConfirmation {
  /** false only means "60m structure contradicts the daily setup" — missing
   * or unavailable data is always treated as aligned (see below). */
  aligned: boolean;
  direction: 1 | -1 | null;
  adx14: number | null;
  reason: string;
}

const CONFIRMATION_INTERVAL = '60'; // 1-hour bars — the "structural" timeframe from the architecture brief
const LOOKBACK_DAYS = 15; // enough 60m bars to seed a 14-period ATR/ADX

/**
 * One extra confirmation timeframe (60-minute Supertrend + ADX) checked
 * ONLY for a symbol that already passed daily setup detection — this is
 * deliberately not the full 1D/4H/1H/15m/5m cascade the architecture brief
 * describes, and not applied to the whole screened universe. Fetching
 * intraday history for every candidate (hundreds of symbols per scan) is
 * exactly the affordability problem the daily-only feature engine
 * (features.ts) was scoped around; gating this to the handful of setups a
 * scan actually detects (typically single digits to a few dozen) keeps the
 * extra cost proportional to opportunities found, not universe size.
 *
 * A LONG setup is contradicted when the 60m Supertrend has flipped bearish
 * — i.e. the daily breakout/pullback/continuation thesis is already
 * reversing on the tape within the day. This never blocks publication; it
 * only docks the score and adds an explicit note, because a fetch failure
 * or thin intraday history must not silently kill an otherwise-valid daily
 * setup (see the two "aligned: true" fallback paths below).
 */
export async function confirmIntradayTrend(client: DhanClient, ref: InstrumentRef): Promise<IntradayConfirmation> {
  const { dateStr } = istParts();
  const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const series = await client.charts.intraday({
      securityId: ref.securityId,
      exchangeSegment: ref.exchangeSegment,
      instrument: 'EQUITY',
      interval: CONFIRMATION_INTERVAL,
      fromDate,
      toDate: dateStr,
    });
    const bars = candlesFromSeries(series);
    if (bars.length < 20) {
      return { aligned: true, direction: null, adx14: null, reason: 'Insufficient 60m history — confirmation skipped, not failed' };
    }

    const st = supertrend(bars, { period: 10, multiplier: 3 });
    const adxResult = adx(bars, 14);
    const direction = lastDefined(st.direction);
    const adx14 = lastDefined(adxResult.adx);
    const aligned = direction !== -1;

    return {
      aligned,
      direction,
      adx14,
      reason: aligned
        ? `60m Supertrend ${direction === 1 ? 'bullish — confirms the daily setup' : 'inconclusive'}`
        : '60m Supertrend bearish — daily setup not yet confirmed intraday',
    };
  } catch (e: any) {
    return { aligned: true, direction: null, adx14: null, reason: `60m confirmation unavailable: ${e.message}` };
  }
}

function lastDefined<T>(arr: Array<T | null>): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i] as T;
  }
  return null;
}
