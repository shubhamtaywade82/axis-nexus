import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { moduleLogger } from '../lib/logger';
import { marketClock } from './marketHours';

const log = moduleLogger('journal');

/**
 * Append-only durable record of the decisions this system makes — the
 * thing to read after a crash or an unexpected outcome, distinct from
 * Postgres (current position/wallet state) and from stdout logs (verbose,
 * not queryable by kind, rotated away by the host).
 *
 * Scope: a durable, queryable AUDIT TRAIL — order intents and their
 * results, risk decisions (breaker trips, kill/disarm), EOD/square-off
 * events, and every control-plane command an operator issues. NOT tick
 * data (a separate, much higher-volume concern with its own tradeoffs).
 *
 * summarizeDay() (below) reads today's entries back on boot for a
 * CROSS-CHECK against Postgres/mem (core.ts) — verifying every journaled
 * trade has a matching durable order record, and that the journal's last
 * kill-switch action agrees with the risk engine's current state — not a
 * full event-sourced reconstruction. The journal never writes state back;
 * a mismatch is surfaced loudly (log + alert), never silently "fixed" from
 * the journal, because the journal only covers what happened THIS trading
 * day and can't tell a legitimate multi-day carry-over position from
 * actual drift.
 *
 * One file per IST trading day (JOURNAL_DIR/YYYY-MM-DD.ndjson), so a day's
 * journal is a bounded, easy-to-ship artifact and old days can be archived
 * or deleted independently. A monotonic per-process `seq` orders entries
 * unambiguously even when two land in the same millisecond.
 */

export type JournalKind =
  | 'order_intent'      // an order about to be placed (paper or live)
  | 'order_result'      // its outcome: TRADED / REJECTED / error
  | 'risk_decision'      // a circuit breaker's state transition
  | 'kill'               // kill switch armed/disarmed
  | 'eod'                // EOD/manual square-off
  | 'control_command'    // an operator action via the control-plane API
  | 'scalp_entry'        // a scalp position was opened
  | 'scalp_exit';        // a scalp position was closed (with PnL)

export interface JournalEntry<T = any> {
  seq: number;
  ts: number;
  kind: JournalKind;
  payload: T;
}

// A function, not a module-load-time constant — resolved fresh on every
// open() call so JOURNAL_DIR can be set per-test (or genuinely change
// between an open() call and the next) without needing the module
// reloaded, which a cached `const DIR = process.env.JOURNAL_DIR ...`
// evaluated once at import time would silently ignore.
function journalDir(): string {
  if (process.env.JOURNAL_DIR) return process.env.JOURNAL_DIR;
  // Prevent tests from accidentally appending to the runtime journal when JOURNAL_DIR is unset.
  if (process.env.NODE_ENV === 'test') {
    return join(tmpdir(), 'axis-nexus-test-journal');
  }
  return join(process.cwd(), '.journal');
}

export class Journal {
  private seq = 0;
  private stream: WriteStream | null = null;
  private sessionDate = '';

  /**
   * Opens today's journal file, returning whatever it already contains
   * (e.g. from an earlier boot the same trading day) for diagnostics. Any
   * previously-open file is closed first — callers only need to call this
   * once at boot; the autonomy loop's day-rollover is handled by calling
   * this again when the IST date changes.
   */
  open(sessionDate: string = marketClock().istDate): JournalEntry[] {
    // Not awaited: the previous stream (if any) points at a DIFFERENT file
    // (a different day), so it flushes independently on its own — nothing
    // here is about to exit the process. Only a caller about to exit needs
    // to await close() directly (see server.ts's shutdown handler).
    void this.close();
    this.sessionDate = sessionDate;
    // seq is scoped to the file being opened, not to the process — without
    // resetting here, switching from one trading day to the next inside a
    // still-running process (a boot that spans midnight, or the autonomy
    // loop's day rollover) would carry the previous day's counter into a
    // brand new, otherwise-empty file instead of starting it at 1.
    this.seq = 0;
    const dir = journalDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionDate}.ndjson`);

    const prior: JournalEntry[] = [];
    if (existsSync(file)) {
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch (e: any) {
        log.warn({ err: { message: e.message }, file }, 'Failed to read existing journal — starting fresh append');
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          prior.push(entry);
          if (entry.seq > this.seq) this.seq = entry.seq;
        } catch {
          // A torn final line from an unclean shutdown — everything before
          // it parsed fine and is intact; this is expected, not corruption.
        }
      }
    }

    this.stream = createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (e) => log.error({ err: { message: e.message }, file }, 'Journal write stream error'));
    log.info({ file, priorEntries: prior.length }, 'Journal opened');
    return prior;
  }

  /** Records one entry and flushes it immediately — a decision worth
   * journaling is worth journaling durably before this function returns,
   * not batched and lost if the process dies in the next few seconds. */
  append<T>(kind: JournalKind, payload: T): JournalEntry<T> {
    if (!this.stream) {
      // Never silently drop a decision because open() wasn't called yet —
      // that would defeat the entire point during exactly the boot window
      // most likely to have surprises. Must happen BEFORE seq is read below:
      // open() resets seq to 0 and re-derives it from the existing file, so
      // computing seq first would build the entry with a stale number that
      // open() then clobbers the counter behind — writing a duplicate,
      // out-of-order seq into the file instead of the next real one.
      this.open();
    }
    const entry: JournalEntry<T> = { seq: ++this.seq, ts: Date.now(), kind, payload };
    try {
      this.stream!.write(JSON.stringify(entry) + '\n');
    } catch (e: any) {
      log.error({ err: { message: e.message }, kind }, 'Journal append failed');
    }
    return entry;
  }

  currentSessionDate(): string {
    return this.sessionDate;
  }

  /** Re-reads today's journal file from disk — used by boot reconcile
   * without disturbing the open append stream. */
  readTodayEntries(sessionDate: string = marketClock().istDate): JournalEntry[] {
    const file = join(journalDir(), `${sessionDate}.ndjson`);
    if (!existsSync(file)) return [];
    const entries: JournalEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch { /* torn final line */ }
    }
    return entries;
  }

  /** Resolves once the stream has actually finished flushing to disk —
   * WriteStream.end() only SCHEDULES the flush. A caller that exits the
   * process right after calling close() (server.ts's shutdown handler)
   * would otherwise race the flush and could lose the last few entries
   * written in that same shutdown, which is exactly when a decision is
   * most worth having durably recorded. */
  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }
}

/** Process-wide singleton, matching eventBus's pattern — every service
 * that needs to journal a decision imports this directly rather than
 * threading a Journal instance through every constructor. */
export const journal = new Journal();

export interface DayReplaySummary {
  /** correlation_id of every TRADED order_result seen today. For an ENTRY
   * this is the caller's own correlation id (paper_orders.correlation_id);
   * for an EXIT (db.ts's closePaperPosition) it's the generated order id
   * (paper_orders.id) — closePaperPosition reuses the `correlation_id`
   * field name for that value. findMissingOrders() (db.ts) checks a
   * candidate against both columns, so this list doesn't need to
   * distinguish which kind it is. */
  tradedCorrelationIds: string[];
  /** correlation_id of every order_intent seen today with NO matching
   * order_result (any status) later in the journal — an order this process
   * placed but died before learning the outcome of. Needs resolving on
   * boot: against paper_orders for paper mode, or the broker's own order
   * book (GET /orders/external/{id}) for live/sandbox. */
  unresolvedIntents: string[];
  /** The last kill-switch action recorded today, or null if none. */
  lastKillAction: 'arm' | 'disarm' | null;
}

/**
 * Pure summary of one day's entries — no I/O, easy to test in isolation
 * from real files. Deliberately narrow: this does NOT attempt to derive
 * net position quantities, because a position carried over from a PRIOR
 * trading day has no fills in TODAY's journal at all (each day is its own
 * file — see Journal.open()), so "journal-implied qty" and "actual qty"
 * would disagree for a structural reason that has nothing to do with
 * drift. Order-existence and kill-state are the two things a single day's
 * journal can check without that ambiguity.
 */
function matchesMode(e: JournalEntry, mode?: string): boolean {
  if (!mode) return true;
  const entryMode = e.payload?.mode;
  if (entryMode) return entryMode === mode;
  // Legacy rows written before every engine stamped `mode` on results.
  if (mode === 'paper') return e.payload?.is_paper !== false;
  return e.payload?.is_paper === false;
}

export function summarizeDay(entries: JournalEntry[], mode?: string): DayReplaySummary {
  const tradedCorrelationIds: string[] = [];
  const intentIds = new Set<string>();
  const resolvedIds = new Set<string>();
  let lastKillAction: 'arm' | 'disarm' | null = null;
  for (const e of entries) {
    if (e.kind === 'order_intent' && e.payload?.correlation_id) {
      if (matchesMode(e, mode)) intentIds.add(String(e.payload.correlation_id));
    }
    if (e.kind === 'order_result' && e.payload?.correlation_id) {
      if (matchesMode(e, mode)) {
        resolvedIds.add(String(e.payload.correlation_id));
        if (e.payload?.status === 'TRADED') tradedCorrelationIds.push(String(e.payload.correlation_id));
      }
    }
    if (e.kind === 'kill' && (e.payload?.action === 'arm' || e.payload?.action === 'disarm')) {
      lastKillAction = e.payload.action;
    }
  }
  const unresolvedIntents = [...intentIds].filter((id) => !resolvedIds.has(id));
  return { tradedCorrelationIds, unresolvedIntents, lastKillAction };
}
