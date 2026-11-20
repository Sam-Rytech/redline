import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawLoan, Snapshot } from "@redline/paryon-decoder";
import { createChainReader, type LoanState } from "../src/reader.js";

const raw = (id: string, debtPusd: number, collateralSats: number): RawLoan => ({
  id,
  status: "mature",
  debtPusd,
  collateralSats,
  interestRatePct: 1,
  nextInterestRatePct: 1,
  amountBeingRedeemedPusd: 0,
});
// price 200: loan "a" liq = 1000/10*1.1=110 (45% away); "b" liq=1800/10*1.1=198 (1% away)
const snap = (loans: RawLoan[], blockHeight = 100, priceUsd = 200): Snapshot => ({
  priceUsd,
  priceSequence: 1,
  blockHeight,
  loans,
  skipped: 0,
});
const A = raw("a", 1000, 10e8);
const B = raw("b", 1800, 10e8);
const S = raw("s", 0, 5e8); // stranded

const NOW = new Date("2026-11-20T12:00:00.000Z");
const mk = (fetch: () => Promise<Snapshot>, intervalMs = 1000, extra: { timeoutMs?: number; retryMs?: number; log?: (m: string) => void } = {}) =>
  createChainReader({ fetch, intervalMs, now: () => NOW, log: () => {}, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("chain reader", () => {
  it("is empty before the first refresh", () => {
    const r = mk(async () => snap([A]));
    expect(r.current()).toBeNull();
    expect(r.lastError()).toBeNull();
  });

  it("first refresh populates state", async () => {
    const r = mk(async () => snap([A], 321, 200));
    await r.refresh();
    const s = r.current()!;
    expect(s.blockHeight).toBe(321);
    expect(s.priceUsd).toBe(200);
    expect(s.updatedAt).toBe(NOW.toISOString());
    expect(s.loans).toHaveLength(1);
    expect(s.byId.get("a")).toBe(s.loans[0]);
    expect(r.lastError()).toBeNull();
  });

  it("sorts by distance ascending, stranded (null) last", async () => {
    const r = mk(async () => snap([S, A, B]));
    await r.refresh();
    expect(r.current()!.loans.map((l) => l.id)).toEqual(["b", "a", "s"]);
  });

  it("failure keeps old state and sets lastError; success clears it", async () => {
    let fail = false;
    const r = mk(async () => {
      if (fail) throw new Error("electrum down");
      return snap([A]);
    });
    await r.refresh();
    const before = r.current();
    fail = true;
    await expect(r.refresh()).resolves.toBeUndefined();
    expect(r.current()).toBe(before);
    expect(r.lastError()).toBe("electrum down");
    fail = false;
    await r.refresh();
    expect(r.lastError()).toBeNull();
    expect(r.current()).not.toBe(before);
  });

  it("failure before first success leaves state null", async () => {
    const r = mk(async () => {
      throw new Error("boom");
    });
    await r.refresh();
    expect(r.current()).toBeNull();
    expect(r.lastError()).toBe("boom");
  });

  it("0 loans after >0 loans is a failure, old state kept", async () => {
    let loans = [A, B];
    const r = mk(async () => snap(loans));
    await r.refresh();
    const before = r.current();
    loans = [];
    await r.refresh();
    expect(r.current()).toBe(before);
    expect(r.lastError()).toMatch(/0 loans/);
  });

  it("0 loans on the very first refresh is a failure too (never happens on mainnet); no update fires", async () => {
    const r = mk(async () => snap([]));
    const calls: unknown[] = [];
    r.onUpdate((p, n) => calls.push([p, n]));
    await r.refresh();
    expect(r.current()).toBeNull();
    expect(r.lastError()).toMatch(/0 loans/);
    expect(calls).toEqual([]);
  });

  it("skips overlapping refreshes", async () => {
    let release!: (s: Snapshot) => void;
    const fetch = vi.fn(() => new Promise<Snapshot>((res) => (release = res)));
    const r = mk(fetch);
    const p1 = r.refresh();
    const p2 = r.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(snap([A]));
    await Promise.all([p1, p2]);
    expect(r.current()).not.toBeNull();
    const p3 = r.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    release(snap([A]));
    await p3;
  });

  it("start() refreshes now and on the interval; stop() stops it", async () => {
    const fetch = vi.fn(async () => snap([A]));
    const r = mk(fetch, 1000);
    r.start();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(4);
    r.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("onUpdate gets prev and next after each success only", async () => {
    let n = 0;
    let fail = false;
    const r = mk(async () => {
      if (fail) throw new Error("x");
      return snap([A], 100 + n++);
    });
    const calls: Array<[LoanState | null, LoanState]> = [];
    r.onUpdate((p, nx) => calls.push([p, nx]));
    await r.refresh();
    fail = true;
    await r.refresh();
    fail = false;
    await r.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBeNull();
    expect(calls[0]![1].blockHeight).toBe(100);
    expect(calls[1]![0]).toBe(calls[0]![1]);
    expect(calls[1]![1].blockHeight).toBe(101);
  });

  it("a throwing listener does not break the refresh", async () => {
    const r = mk(async () => snap([A]));
    r.onUpdate(() => {
      throw new Error("listener");
    });
    await r.refresh();
    expect(r.current()).not.toBeNull();
    expect(r.lastError()).toBeNull();
  });

  it("start() twice creates a single interval", async () => {
    const fetch = vi.fn(async () => snap([A]));
    const r = mk(fetch, 1000);
    r.start();
    r.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    r.stop();
  });

  it("a stalled fetch times out, records lastError, and the next tick retries; late result ignored", async () => {
    const resolvers: Array<(s: Snapshot) => void> = [];
    let calls = 0;
    const fetch = vi.fn(() => {
      calls++;
      return new Promise<Snapshot>((res) => resolvers.push(res));
    });
    const r = mk(fetch, 1000, { timeoutMs: 5000 });
    await Promise.resolve();
    const p = r.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(r.current()).toBeNull();
    expect(r.lastError()).toBe("refresh timed out after 5s");
    // next refresh starts a fresh fetch
    const p2 = r.refresh();
    expect(calls).toBe(2);
    resolvers[1]!(snap([A], 200));
    await p2;
    expect(r.current()!.blockHeight).toBe(200);
    expect(r.lastError()).toBeNull();
    // late result from the timed-out first fetch must not overwrite newer state
    resolvers[0]!(snap([B], 50));
    await Promise.resolve();
    await Promise.resolve();
    expect(r.current()!.blockHeight).toBe(200);
  });

  it("clears the timeout timer when the fetch settles first", async () => {
    const r = mk(async () => snap([A]), 1000, { timeoutMs: 5000 });
    await r.refresh();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("async listener rejection is caught and logged", async () => {
    const logs: string[] = [];
    const r = mk(async () => snap([A]), 1000, { log: (m) => logs.push(m) });
    r.onUpdate(async () => {
      throw new Error("async listener");
    });
    await r.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(logs.some((l) => l.includes("async listener"))).toBe(true);
  });

  describe("quick retry after a failed refresh", () => {
    it("retries once after retryMs, then the normal interval continues", async () => {
      const fetch = vi.fn(async (): Promise<Snapshot> => {
        throw new Error("down");
      });
      const r = mk(fetch, 60_000, { retryMs: 10_000 });
      r.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(2); // the quick retry
      await vi.advanceTimersByTimeAsync(40_000); // t = 50 s: the failed retry does not schedule another
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000); // t = 60 s: normal tick
      expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10_000); // t = 70 s: retry after the tick's failure
      expect(fetch).toHaveBeenCalledTimes(4);
      r.stop();
    });

    it("defaults retryMs to 10 s", async () => {
      const fetch = vi.fn(async (): Promise<Snapshot> => {
        throw new Error("down");
      });
      const r = mk(fetch, 60_000);
      r.start();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      r.stop();
    });

    it("a successful retry restores state; no retry after success", async () => {
      let fail = true;
      const fetch = vi.fn(async () => {
        if (fail) throw new Error("down");
        return snap([A]);
      });
      const r = mk(fetch, 60_000, { retryMs: 10_000 });
      r.start();
      await vi.advanceTimersByTimeAsync(0);
      fail = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(r.current()).not.toBeNull();
      expect(r.lastError()).toBeNull();
      await vi.advanceTimersByTimeAsync(49_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      r.stop();
    });

    it("does not stack retries when several refreshes fail before the retry fires", async () => {
      const fetch = vi.fn(async (): Promise<Snapshot> => {
        throw new Error("down");
      });
      const r = mk(fetch, 60_000, { retryMs: 10_000 });
      r.start();
      await vi.advanceTimersByTimeAsync(0);
      await r.refresh(); // manual refresh also fails
      await r.refresh();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(2); // interval + one pending retry
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(4);
      r.stop();
    });

    it("stop() cancels a pending retry", async () => {
      const fetch = vi.fn(async (): Promise<Snapshot> => {
        throw new Error("down");
      });
      const r = mk(fetch, 60_000, { retryMs: 10_000 });
      r.start();
      await vi.advanceTimersByTimeAsync(0);
      r.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("no retry is scheduled when the reader was never started", async () => {
      const r = mk(async () => {
        throw new Error("down");
      }, 60_000, { retryMs: 10_000 });
      await r.refresh();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
