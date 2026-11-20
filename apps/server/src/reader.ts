import type { LoanView } from "@redline/api-types";
import { computeLoanViews, type Snapshot } from "@redline/paryon-decoder";

export interface LoanState {
  blockHeight: number;
  priceUsd: number;
  /** ISO time of the successful fetch */
  updatedAt: string;
  /** sorted by distanceToLiquidation ascending, stranded (null) last */
  loans: LoanView[];
  byId: Map<string, LoanView>;
}

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
  /** after a failed refresh (while started), retry once after this long instead of waiting a full interval (default 10_000) */
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

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** true when the refresh succeeded */
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
      if (snap.loans.length === 0 && state !== null && state.loans.length > 0) {
        throw new Error(`Refresh returned 0 loans (previous state had ${state.loans.length}); keeping previous state`);
      }
      const loans = computeLoanViews(snap.loans, snap.priceUsd).sort(byDistance);
      const next: LoanState = {
        blockHeight: snap.blockHeight,
        priceUsd: snap.priceUsd,
        updatedAt: now().toISOString(),
        loans,
        byId: new Map(loans.map((l) => [l.id, l])),
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
        if (ok) clearRetry();
        // one quick retry per failure; a failed retry waits for the normal interval
        else if (timer && !retryTimer && !isRetry) {
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
      timer = null;
      clearRetry();
    },
    onUpdate(fn) {
      listeners.push(fn);
    },
  };
}
