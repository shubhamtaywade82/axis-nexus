import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { isDhanRateLimited, isRateLimitError, noteDhanRateLimit } from '../lib/dhanRateLimit';

export type SandboxLegInput = {
  securityId: string | number;
  exchangeSegment: string;
};

export type SandboxLeg = {
  securityId: string;
  quantity: number;
  exchangeSegment: string;
  tickSize: number;
  displayName?: string;
};

/**
 * Resolves instrument metadata (lot size, tick size) by exact
 * exchangeSegment + securityId lookup. Uses the production scrip master so
 * BSE_FNO (SENSEX), NSE_FNO, and every other segment are all available.
 */
export async function resolveSandboxOptionLeg(
  client: DhanClient,
  input: SandboxLegInput,
): Promise<SandboxLeg | null> {
  if (isDhanRateLimited()) return null;
  const instrument = await client.instruments.findBySecurityId(
    input.exchangeSegment,
    input.securityId,
  ).catch((e: any) => {
    if (isRateLimitError(String(e?.message || e))) {
      noteDhanRateLimit({ message: String(e?.message || e), retryAfterMs: e?.retryAfterMs });
    }
    return null;
  });
  if (!instrument) return null;
  const lot = Number(instrument.lotSize);
  if (!(lot > 0)) return null;
  return {
    securityId: String(instrument.securityId),
    quantity: lot,
    exchangeSegment: input.exchangeSegment,
    tickSize: tickSizeInRupees(Number(instrument.tickSize)),
    displayName: instrument.displayName,
  };
}

/** Dhan's scrip master reports TICK_SIZE in paise (5 = ₹0.05); treating it
 * as rupees rounded every sandbox limit price to a ₹5 multiple. Values < 1
 * are assumed to already be rupees. */
export function tickSizeInRupees(rawTick: number): number {
  if (!(rawTick > 0)) return 0.05;
  return rawTick >= 1 ? rawTick / 100 : rawTick;
}

export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  // toFixed strips float noise (123.45 / 0.05 * 0.05 → 123.45000000000002).
  return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
}

/** POST /v2/orders body for sandbox — MARKET is rejected, route as LIMIT. */
export function buildSandboxPlaceRequest(input: {
  correlationId: string;
  securityId: string;
  exchangeSegment: string;
  transactionType: string;
  orderType: string;
  quantity: number;
  price: number;
  productType: string;
  dhanClientId?: string;
}) {
  const asLimit = input.orderType === 'MARKET';
  if (asLimit && !(input.price > 0)) {
    throw new Error('Sandbox needs price > 0 to place LIMIT (MARKET not supported)');
  }
  const orderType = asLimit ? 'LIMIT' : input.orderType;
  const price = orderType === 'MARKET' ? 0 : input.price;
  const correlationId = input.correlationId ? String(input.correlationId).slice(0, 25) : undefined;
  return {
    dhanClientId: input.dhanClientId || process.env.DHAN_SANDBOX_CLIENT_ID,
    correlationId,
    securityId: String(input.securityId),
    exchangeSegment: input.exchangeSegment as any,
    transactionType: input.transactionType as any,
    productType: input.productType as any,
    orderType: orderType as any,
    validity: 'DAY' as const,
    quantity: input.quantity,
    disclosedQuantity: 0,
    price,
    triggerPrice: 0,
    afterMarketOrder: false,
  };
}
