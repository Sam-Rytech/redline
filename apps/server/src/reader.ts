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
  /** refresh now, then every intervalMs */
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
  now?: () => Date;
  log?: (msg: string) => void;
}): ChainReader {
  const intervalMs = opts.intervalMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));

  let state: LoanState | null = null;
  let error: string | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners: Array<(prev: LoanState | null, next: LoanState) => void> = [];

  async function run(): Promise<void> {
    try {
      const snap = await opts.fetch();
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
          fn(prev, next);
        } catch (e) {
          log(`onUpdate listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`chain refresh failed: ${error}`);
    }
  }

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    current: () => state,
    lastError: () => error,
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onUpdate(fn) {
      listeners.push(fn);
    },
  };
}
