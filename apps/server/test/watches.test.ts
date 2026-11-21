import { describe, expect, it } from "vitest";
import type { ApiError, Watch } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { randomHex, sha256Hex } from "../src/crypto.js";
import { insertSession, upsertAccount } from "../src/db/auth.js";
import type { ChainReader, LoanState } from "../src/reader.js";
import { TEST_ORIGIN, testApp } from "./support.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const views = computeLoanViews(
  ["aa", "bb", "cc"].map((id) => ({
    id: id.repeat(32), status: "mature" as const, debtPusd: 1000, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0,
  })),
  200,
);
const LOAN = (n: number) => views[n]!.id;
const state: LoanState = {
  blockHeight: 1, priceUsd: 200, updatedAt: NOW.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])), raw: [], missingSidecars: 0,
};
const reader = (s: LoanState | null): ChainReader => ({ current: () => s, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} });

function setup(o: { state?: LoanState | null } = {}) {
  const { app, db, secrets } = testApp({ reader: reader(o.state === undefined ? state : o.state), now: () => NOW });
  /** a signed-in account (sessions are created directly; sign-in itself is tested in auth.test.ts) */
  const account = (id: string, proUntil: number | null = null) => {
    upsertAccount(db, id, nowSec);
    if (proUntil !== null) db.prepare("UPDATE accounts SET pro_until = ? WHERE id = ?").run(proUntil, id);
    const token = randomHex(32);
    const sid = sha256Hex(token);
    insertSession(db, { id: sid, accountId: id, keysEnc: secrets.seal("{}", sid), createdAt: nowSec, expiresAt: nowSec + 3600 });
    return `rl_session=${token}`;
  };
  const req = async (path: string, init: { method?: string; json?: unknown; cookie?: string } = {}) => {
    const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = {};
    if (init.cookie) headers.cookie = init.cookie;
    if (method !== "GET") headers.origin = TEST_ORIGIN;
    if (method === "POST" || method === "PATCH") headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, ...(init.json !== undefined && { body: JSON.stringify(init.json) }) });
    const text = await res.text();
    return { status: res.status, text, json: <T>() => JSON.parse(text) as T, code: () => (JSON.parse(text) as ApiError).error.code };
  };
  return { db, account, req };
}

describe("watches (docs/API.md)", () => {
  it("401 without a session", async () => {
    const s = setup();
    expect((await s.req("/api/watches")).status).toBe(401);
    expect((await s.req("/api/watches", { json: { loanId: LOAN(0) } })).status).toBe(401);
  });

  it("creates a watch with default rules, lists it, and the free plan allows one (403 watch_limit)", async () => {
    const s = setup();
    const me = s.account("acc1");
    const r = await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me });
    expect(r.status).toBe(201);
    const w = r.json<Watch>();
    expect(w).toMatchObject({ loanId: LOAN(0), rules: { liquidation: true, loanGone: true }, lastBand: null, createdAt: NOW.toISOString() });
    expect(w.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await s.req("/api/watches", { cookie: me })).json<Watch[]>()).toEqual([w]);
    const second = await s.req("/api/watches", { json: { loanId: LOAN(1) }, cookie: me });
    expect(second.status).toBe(403);
    expect(second.code()).toBe("watch_limit");
  });

  it("409 watch_exists for the same loan, checked before the limit", async () => {
    const s = setup();
    const me = s.account("acc1");
    await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me });
    const dup = await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me });
    expect(dup.status).toBe(409);
    expect(dup.code()).toBe("watch_exists");
  });

  it("Pro (pro_until in the future) has no watch limit; an expired pass does", async () => {
    const s = setup();
    const pro = s.account("pro", nowSec + 86_400);
    for (const n of [0, 1, 2]) expect((await s.req("/api/watches", { json: { loanId: LOAN(n) }, cookie: pro })).status).toBe(201);
    const lapsed = s.account("lapsed", nowSec - 1);
    await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: lapsed });
    expect((await s.req("/api/watches", { json: { loanId: LOAN(1) }, cookie: lapsed })).code()).toBe("watch_limit");
  });

  it("404 for an unknown loan, 503 before chain data, 400 for bad input", async () => {
    const s = setup();
    const me = s.account("acc1");
    const unknown = await s.req("/api/watches", { json: { loanId: "ff".repeat(32) }, cookie: me });
    expect(unknown.status).toBe(404);
    expect(unknown.code()).toBe("not_found");
    for (const body of [{}, { loanId: 5 }, { loanId: LOAN(0), rules: { liquidation: "yes" } }, { loanId: LOAN(0), rules: [] }]) {
      expect((await s.req("/api/watches", { json: body, cookie: me })).status).toBe(400);
    }
    const cold = setup({ state: null });
    const r = await cold.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: cold.account("acc1") });
    expect(r.status).toBe(503);
  });

  it("PATCH changes only the given rules; {} leaves the watch unchanged", async () => {
    const s = setup();
    const me = s.account("acc1");
    const w = (await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me })).json<Watch>();
    const p = await s.req(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { loanGone: false } }, cookie: me });
    expect(p.status).toBe(200);
    expect(p.json<Watch>().rules).toEqual({ liquidation: true, loanGone: false });
    const same = await s.req(`/api/watches/${w.id}`, { method: "PATCH", json: {}, cookie: me });
    expect(same.json<Watch>().rules).toEqual({ liquidation: true, loanGone: false });
    expect((await s.req(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { liquidation: 1 } }, cookie: me })).status).toBe(400);
  });

  it("another account's watch is 404 on PATCH and DELETE, and is not listed", async () => {
    const s = setup();
    const owner = s.account("owner");
    const other = s.account("other");
    const w = (await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: owner })).json<Watch>();
    expect((await s.req(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { loanGone: false } }, cookie: other })).status).toBe(404);
    expect((await s.req(`/api/watches/${w.id}`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect((await s.req("/api/watches", { cookie: other })).json<Watch[]>()).toEqual([]);
    expect((await s.req("/api/watches", { cookie: owner })).json<Watch[]>()).toHaveLength(1);
  });

  it("DELETE removes the watch and frees the free-plan slot", async () => {
    const s = setup();
    const me = s.account("acc1");
    const w = (await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me })).json<Watch>();
    const del = await s.req(`/api/watches/${w.id}`, { method: "DELETE", cookie: me });
    expect(del.status).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect((await s.req("/api/watches", { json: { loanId: LOAN(1) }, cookie: me })).status).toBe(201);
  });

  it("a gone loan's watch shows lastBand null", async () => {
    const s = setup();
    const me = s.account("acc1");
    const w = (await s.req("/api/watches", { json: { loanId: LOAN(0) }, cookie: me })).json<Watch>();
    s.db.prepare("UPDATE watches SET last_band = 'gone' WHERE id = ?").run(w.id);
    expect((await s.req("/api/watches", { cookie: me })).json<Watch[]>()[0]!.lastBand).toBeNull();
  });
});
