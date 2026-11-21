import type { LoanView } from "@redline/api-types";
import { computeLoanViews, type RawLoan, type Snapshot } from "@redline/paryon-decoder";

export interface LoanState {
  blockHeight: number;
  priceUsd: number;
  /** ISO time of the successful fetch */
  updatedAt: string;
  /** sorted by distanceToLiquidation ascending, stranded (null) last */
  loans: LoanView[];
  byId: Map<string, LoanView>;
  /** the decoded loans as read from chain (raw rates, exact amounts), for loan_snapshots */
  raw: RawLoan[];
  /** loan outputs with no matching sidecar in this read (reported on /api/health, never dropped silently) */
  missingSidecars: number;
}

/** A read that returns fewer than this share of the previous loans is discarded (docs/SECURITY.md). */
export const MIN_LOAN_RATIO = 0.8;

export interface ChainReader {
  /** last good state, null before the first success */
  current(): LoanState | null;
  /** message of the most recent failed refresh, cleared on success */
  lastError(): string | null;
  /** one fetch; never throws (records the error instead). Joins an in-flight refresh instead of starting another. */
  refresh(): Promise<void>;
  /** refresh now, then every intervalMs; after a failed refresh, one quick retry after retryMs */
  start(): void;
  stop(): void;
  onUpdate(fn: (prev: LoanState | null, next: LoanState) => void): void;
}

const byDistance = (a: LoanView, b: LoanView): number => {
  const x = a.distanceToLiquidation;
  const y = b.distanceToLiquidation;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
};

export function createChainReader(opts: {
  fetch: () => Promise<Snapshot>;
  intervalMs?: number;
  /** abort a stalled fetch after this long (default 30_000) */
  timeoutMs?: number;
  /** after a failed refresh (while started), retry once after this long (default 10_000) */
  retryMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}): ChainReader {
  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retryMs = opts.retryMs ?? 10_000;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));

  let state: LoanState | null = null;
  let error: string | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null; // interval handle
  let retryTimer: ReturnType<typeof setTimeout> | null = null; // at most one pending quick retry
  const listeners: Array<(prev: LoanState | null, next: LoanState) => void> = [];

  /** true when the refresh produced a new state */
  async function run(): Promise<boolean> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = opts.fetch();
      pending.catch(() => {}); // a late failure after a timeout must not be unhandled
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`refresh timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      });
      let snap: Snapshot;
      try {
        snap = await Promise.race([pending, timeout]);
      } finally {
        clearTimeout(timer);
      }
      // integrity: a partial or lagging read must never replace good data (it would look like loans vanished)
      if (snap.loans.length === 0) {
        throw new Error(`Refresh returned 0 loans${state ? ` (previous state had ${state.loans.length})` : ""}; discarded`);
      }
      if (state && snap.loans.length < state.loans.length * MIN_LOAN_RATIO) {
        throw new Error(`Refresh returned ${snap.loans.length} of ${state.loans.length} loans (under ${MIN_LOAN_RATIO * 100}%); discarded`);
      }
      if (state && snap.blockHeight < state.blockHeight) {
        throw new Error(`Refresh is from block ${snap.blockHeight}, behind block ${state.blockHeight}; discarded`);
      }
      const loans = computeLoanViews(snap.loans, snap.priceUsd).sort(byDistance);
      const next: LoanState = {
        blockHeight: snap.blockHeight,
        priceUsd: snap.priceUsd,
        updatedAt: now().toISOString(),
        loans,
        byId: new Map(loans.map((l) => [l.id, l])),
        raw: snap.loans,
        missingSidecars: snap.skipped,
      };
      const prev = state;
      state = next;
      error = null;
      for (const fn of listeners) {
        try {
          const r: unknown = fn(prev, next);
          if (r instanceof Promise) {
            r.catch((e: unknown) => log(`onUpdate listener failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        } catch (e) {
          log(`onUpdate listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`chain refresh failed: ${error}`);
      return false;
    }
  }

  function refresh(isRetry = false): Promise<void> {
    if (inflight) return inflight;
    inflight = run()
      .then((ok) => {
        if (ok) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
        } else if (timer && !retryTimer && !isRetry) {
          // one quick retry per failure; a failed retry waits for the normal interval
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void refresh(true);
          }, retryMs);
        }
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    current: () => state,
    lastError: () => error,
    refresh: () => refresh(),
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
    onUpdate(fn) {
      listeners.push(fn);
    },
  };
}
