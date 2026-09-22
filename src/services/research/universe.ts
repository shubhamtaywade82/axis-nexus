import { type InstrumentRef } from './types';

/**
 * Stock universes resolved from the live DhanHQ scrip master.
 *
 * Security IDs and exchange segments are looked up at runtime, never
 * hardcoded. The previous hand-typed table had drifted from reality:
 * BHARTIARTL carried 317 (which is Bajaj Finance, so every Airtel screen
 * silently priced Bajaj Finance) and TATAMOTORS carried 3456 (now TMPV
 * post-demerger). Only symbol *groupings* stay curated here — those are
 * editorial, the identifiers are not.
 */

export type ExchangePreference = 'NSE' | 'BSE';

/** The scrip master carries no sector field, so this is display-only
 * metadata for well-known names; it never feeds screening or scoring. */
const SECTOR_HINTS: Record<string, string> = {
  RELIANCE: 'Energy & Retail', TCS: 'Information Technology', INFY: 'Information Technology',
  HDFCBANK: 'Banking & Financials', ICICIBANK: 'Banking & Financials', KOTAKBANK: 'Banking & Financials',
  AXISBANK: 'Banking & Financials', SBIN: 'Banking & Financials', BHARTIARTL: 'Telecommunications',
  LT: 'Infrastructure', MARUTI: 'Automobile', ITC: 'FMCG', HINDUNILVR: 'FMCG',
  TITAN: 'Consumer Discretionary', ASIANPAINT: 'Consumer Goods', BAJFINANCE: 'Financial Services',
  BAJAJFINSV: 'Financial Services', SUNPHARMA: 'Pharmaceuticals', DRREDDY: 'Pharmaceuticals',
  WIPRO: 'Information Technology', HCLTECH: 'Information Technology', TECHM: 'Information Technology',
  ULTRACEMCO: 'Materials', TATASTEEL: 'Metals & Mining', JSWSTEEL: 'Metals & Mining',
  NTPC: 'Utilities', POWERGRID: 'Utilities', ONGC: 'Energy', COALINDIA: 'Energy & Mining',
};

/** Dhan ships dummy contracts (011NSETEST … 181NSETEST) in the F&O master. */
const TEST_SYMBOL = /NSETEST/i;

export const FNO_UNIVERSE_ID = 'FNO_UNDERLYINGS';

/** Every NSE_EQ 'EQ'-series listing in the scrip master — the full cash
 * universe, not a curated subset. Intentionally not filtered by liquidity
 * here (that stays a screening concern); callers that fan this out into
 * per-symbol historical fetches (the Expert Trade engine) should bound how
 * much of it they actually process in one pass. */
export const NSE_ALL_EQUITIES_ID = 'NSE_ALL_EQUITIES';

interface ThematicDef { id: string; name: string; description: string; symbols: string[] }

const THEMATIC: Record<string, ThematicDef> = {
  FNO_HEAVYWEIGHTS: {
    id: 'FNO_HEAVYWEIGHTS',
    name: 'F&O High Liquidity Basket',
    description: 'Top liquid derivatives underlyings for multi-leg option execution',
    symbols: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'TATAMOTORS', 'SBIN', 'LT', 'ITC', 'MARUTI'],
  },
  BANKING_FINANCE: {
    id: 'BANKING_FINANCE',
    name: 'Banking & Financials',
    description: 'Tier-1 private, public lenders, and non-banking financial companies',
    symbols: ['HDFCBANK', 'ICICIBANK', 'KOTAKBANK', 'AXISBANK', 'SBIN', 'BAJFINANCE', 'BAJAJFINSV'],
  },
  IT_TECH: {
    id: 'IT_TECH',
    name: 'IT & Technology Services',
    description: 'Export-oriented Indian IT software services and digital leaders',
    symbols: ['TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM'],
  },
};

const equitySegment = (exchange: ExchangePreference) => (exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ');

/** symbol -> scrip-master row, for the cash segment of one exchange. The SDK
 * caches bySegment(), so repeated calls cost nothing after the first. */
/** The two exchanges label series differently — NSE uses 'EQ', BSE uses group
 * codes ('A', 'B', …). Filtering both on 'EQ' silently emptied the entire BSE
 * universe, so each gets its own rule. */
function isNormalEquity(row: any, exchange: ExchangePreference): boolean {
  if (row?.instrument && row.instrument !== 'EQUITY') return false;
  const series = String(row?.series || '').toUpperCase();
  if (!series) return true;
  // BSE 'T' is trade-to-trade and 'Z' is the penalty group; neither belongs in
  // a screener that implies you can take a position normally.
  return exchange === 'BSE' ? !['T', 'Z'].includes(series) : series === 'EQ';
}

async function equityRows(client: any, exchange: ExchangePreference): Promise<Map<string, any>> {
  const rows: any[] = (await client?.instruments?.bySegment?.(equitySegment(exchange))) || [];
  const bySymbol = new Map<string, any>();
  for (const row of rows) {
    const symbol = String(row?.underlyingSymbol || '').toUpperCase();
    if (!symbol || TEST_SYMBOL.test(symbol) || !isNormalEquity(row, exchange)) continue;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, row);
  }
  return bySymbol;
}

/** Every underlying with listed F&O contracts — the genuinely liquid, and for
 * this bot genuinely tradable, universe. Derived, so it tracks exchange
 * additions and removals on its own. */
async function fnoUnderlyingSymbols(client: any): Promise<string[]> {
  const rows: any[] = (await client?.instruments?.bySegment?.('NSE_FNO')) || [];
  const symbols = new Set<string>();
  for (const row of rows) {
    const symbol = String(row?.underlyingSymbol || '').toUpperCase();
    if (symbol && row?.instrument !== 'INDEX' && !TEST_SYMBOL.test(symbol)) symbols.add(symbol);
  }
  return [...symbols].sort();
}

function toRef(symbol: string, row: any, exchange: ExchangePreference): InstrumentRef {
  return {
    symbol,
    securityId: String(row.securityId),
    exchangeSegment: equitySegment(exchange) as InstrumentRef['exchangeSegment'],
    name: row.displayName || row.symbolName || symbol,
    sector: SECTOR_HINTS[symbol] || 'Unclassified',
  };
}

/**
 * Resolves a universe to live instrument references. Symbols with no cash
 * listing on the requested exchange are dropped rather than guessed at.
 */
export async function resolveUniverse(
  client: any,
  universeId: string,
  exchange: ExchangePreference = 'NSE',
): Promise<InstrumentRef[]> {
  const id = universeId.toUpperCase();
  const equities = await equityRows(client, exchange);
  const symbols = id === FNO_UNIVERSE_ID
    ? await fnoUnderlyingSymbols(client)
    : id === NSE_ALL_EQUITIES_ID
      ? [...equities.keys()].sort()
      : (THEMATIC[id] || THEMATIC.FNO_HEAVYWEIGHTS).symbols;

  const refs: InstrumentRef[] = [];
  for (const symbol of symbols) {
    const row = equities.get(symbol);
    if (row) refs.push(toRef(symbol, row, exchange));
  }
  return refs;
}

/** Resolves a single symbol against the scrip master, either exchange. */
export async function resolveSymbol(
  client: any,
  symbol: string,
  exchange: ExchangePreference = 'NSE',
): Promise<InstrumentRef | null> {
  const upper = symbol.toUpperCase().trim();
  const row = (await equityRows(client, exchange)).get(upper);
  return row ? toRef(upper, row, exchange) : null;
}

export async function listUniverses(client: any, exchange: ExchangePreference = 'NSE') {
  // Counts are what would actually be screened on this exchange, not raw
  // symbol-list lengths — some F&O underlyings have no cash listing to fetch
  // candles for, and a thematic name may not be listed on both exchanges.
  const equities = await equityRows(client, exchange).catch(() => new Map<string, any>());
  const countResolvable = (symbols: string[]) => symbols.filter((s) => equities.has(s)).length;
  const fnoSymbols = await fnoUnderlyingSymbols(client).catch(() => [] as string[]);

  return [
    {
      id: FNO_UNIVERSE_ID,
      name: 'F&O Underlyings (live)',
      description: `Every stock with listed derivatives, resolved from the ${exchange} scrip master`,
      count: countResolvable(fnoSymbols),
    },
    {
      id: NSE_ALL_EQUITIES_ID,
      name: 'All NSE Equities (live)',
      description: `Every 'EQ'-series cash listing on the ${exchange} scrip master`,
      count: equities.size,
    },
    ...Object.values(THEMATIC).map((u) => ({
      id: u.id, name: u.name, description: u.description, count: countResolvable(u.symbols),
    })),
  ];
}
