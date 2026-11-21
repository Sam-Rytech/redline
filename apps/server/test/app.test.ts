import { describe, expect, it } from "vitest";
import type { ApiError, LoansResponse, LoanView } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { testApp } from "./support.js";
import type { ChainReader, LoanState } from "../src/reader.js";

const views = computeLoanViews(
  [
    { id: "b", status: "mature", debtPusd: 1800, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0 },
    { id: "a", status: "new", debtPusd: 1000, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0 },
    { id: "s", status: "mature", debtPusd: 0, collateralSats: 5e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0 },
  ],
  200,
);
const state = (updatedAt: string): LoanState => ({
  blockHeight: 950000,
  priceUsd: 200,
  updatedAt,
  loans: views,
  byId: new Map(views.map((v) => [v.id, v])),
  raw: [],
  missingSidecars: 0,
});
const fakeReader = (s: LoanState | null, error: string | null = null): ChainReader => ({
  current: () => s,
  lastError: () => error,
  refresh: async () => {},
  start() {},
  stop() {},
  onUpdate() {},
});
const NOW = new Date("2026-11-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const appFor = (r: ChainReader) => testApp({ reader: r, now: () => NOW }).app;

describe("server app", () => {
  it("503 not_ready before first refresh", async () => {
    const app = appFor(fakeReader(null));
    for (const path of ["/api/loans", "/api/loans/a"]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(((await res.json()) as ApiError).error).toEqual({
        code: "not_ready",
        message: "Loading chain data, try again in a few seconds",
      });
    }
  });

  it("GET /api/loans matches LoansResponse", async () => {
    const res = await appFor(fakeReader(state(ago(1000)))).request("/api/loans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as LoansResponse;
    expect(body.blockHeight).toBe(950000);
    expect(body.priceUsd).toBe(200);
    expect(body.updatedAt).toBe(ago(1000));
    expect(body.stale).toBe(false);
    expect(body.dataAgeSeconds).toBe(1);
    expect(body.loans.map((l) => l.id)).toEqual(["b", "a", "s"]);
    expect(body.summary).toMatchObject({
      total: 3,
      activeCount: 2,
      activeCollateralBch: 20,
      within20pct: 1,
      totalDebtPusd: 2800,
      totalCollateralBch: 25,
      strandedCount: 1,
      strandedBch: 5,
    });
  });

  it("GET /api/loans says when the data is older than 5 minutes (PRD R3)", async () => {
    const body = (await (await appFor(fakeReader(state(ago(6 * 60_000)))).request("/api/loans")).json()) as LoansResponse;
    expect(body.stale).toBe(true);
    expect(body.dataAgeSeconds).toBe(360);
  });

  it("GET /api/loans/:id hit and miss", async () => {
    const app = appFor(fakeReader(state(ago(0))));
    const hit = await app.request("/api/loans/a");
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as LoanView).id).toBe("a");
    const miss = await app.request("/api/loans/zzz");
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as ApiError).error.code).toBe("not_found");
  });

  it("sets Cache-Control on loan routes", async () => {
    const app = appFor(fakeReader(state(ago(0))));
    expect((await app.request("/api/loans")).headers.get("cache-control")).toBe("public, max-age=15");
    expect((await app.request("/api/loans/a")).headers.get("cache-control")).toBe("public, max-age=15");
  });

  it("health: fresh", async () => {
    const res = await appFor(fakeReader(state(ago(60_000)))).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      blockHeight: 950000,
      updatedAt: ago(60_000),
      stale: false,
      lastError: null,
      missingSidecars: 0,
    });
  });

  it("health: stale when older than 5 minutes, with lastError", async () => {
    const res = await appFor(fakeReader(state(ago(6 * 60_000)), "electrum down")).request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stale: boolean; lastError: string };
    expect(body.stale).toBe(true);
    expect(body.lastError).toBe("electrum down");
  });

  it("health reports loans that had no sidecar instead of dropping them silently", async () => {
    const res = await appFor(fakeReader({ ...state(ago(0)), missingSidecars: 3 })).request("/api/health");
    expect(((await res.json()) as { missingSidecars: number }).missingSidecars).toBe(3);
  });

  it("health: stale with no state, still 200", async () => {
    const res = await appFor(fakeReader(null)).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, blockHeight: null, updatedAt: null, stale: true, lastError: null, missingSidecars: null });
  });

  it("unknown /api path is 404 not_found", async () => {
    const res = await appFor(fakeReader(state(ago(0)))).request("/api/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("not_found");
  });
});
