import { randomBytes } from "node:crypto";
import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { ApiError, MeResponse, TelegramLinkResponse, Watch } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { createApp, SESSION_COOKIE, type AppDeps } from "../src/app.js";
import { openDb, type Db } from "../src/db.js";
import type { Chain } from "../src/electrum.js";
import type { ChainReader, LoanState } from "../src/reader.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const L1 = "aa".repeat(32);
const L2 = "bb".repeat(32);
const L3 = "cc".repeat(32);
const views = computeLoanViews(
  [L1, L2, L3].map((id) => ({
    id, status: "mature" as const, debtPusd: 1000, collateralSats: 10e8, interestRatePct: 1, nextInterestRatePct: 1, amountBeingRedeemedPusd: 0,
  })),
  200,
);
const loanState: LoanState = { blockHeight: 1, priceUsd: 200, updatedAt: NOW.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])) };
const reader = (s: () => LoanState | null): ChainReader => ({ current: s, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} });
const noChain: Chain = { getSourceOutput: async () => null, isUnspentOrSpentBy: async () => false, getUtxos: async () => [] };
const hash = (t: string) => binToHex(sha256.hash(utf8ToBin(t)));

function setup(o: { state?: LoanState | null; botUsername?: string | null; config?: Partial<AppDeps["config"]> } = {}) {
  const db: Db = openDb(":memory:");
  let state = o.state === undefined ? loanState : o.state;
  const app = createApp({
    reader: reader(() => state),
    db,
    chain: noChain,
    config: { loginDomain: "redline.test", secureCookies: false, trustProxyHops: 0, logXff: false, publicOrigin: undefined, ...o.config },
    now: () => NOW,
    botUsername: () => (o.botUsername === undefined ? "RedlineBot" : (o.botUsername ?? undefined)),
  });
  /** a signed-in account (session row created directly) */
  const user = (accountId: string, proUntil: number | null = null) => {
    db.upsertAccount({ id: accountId, xpubReceive: `xr-${accountId}`, xpubChange: `xc-${accountId}`, now: NOW_S });
    db.setProUntil(accountId, proUntil);
    const token = randomBytes(32).toString("hex");
    db.createSession(hash(token), accountId, NOW_S + 3600);
    const cookie = `${SESSION_COOKIE}=${token}`;
    return async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
      const headers: Record<string, string> = { cookie, ...(init.json !== undefined && { "content-type": "application/json" }), ...init.headers };
      const res = await app.request(path, { method, headers, ...(init.json !== undefined && { body: JSON.stringify(init.json) }) });
      const text = await res.text();
      return { status: res.status, text, json: <T>() => JSON.parse(text) as T, code: () => (JSON.parse(text) as ApiError).error.code };
    };
  };
  return { app, db, user, setState: (s: LoanState | null) => (state = s) };
}

describe("watch routes", () => {
  it("401 unauthorized without a session on every route", async () => {
    const { app } = setup();
    const json = { "content-type": "application/json" };
    for (const [method, path] of [
      ["GET", "/api/watches"],
      ["POST", "/api/watches"],
      ["PATCH", "/api/watches/x"],
      ["DELETE", "/api/watches/x"],
      ["POST", "/api/telegram/link-token"],
      ["POST", "/api/telegram/unlink"],
    ] as const) {
      const res = await app.request(path, { method, headers: json, ...(method !== "GET" && method !== "DELETE" && { body: "{}" }) });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(((await res.json()) as ApiError).error.code).toBe("unauthorized");
    }
  });

  it("create with default rules, list, lastBand from the row", async () => {
    const { user, db } = setup();
    const call = user("acc1");
    expect((await call("/api/watches")).json<Watch[]>()).toEqual([]);
    const r = await call("/api/watches", { json: { loanId: L1 } });
    expect(r.status).toBe(201);
    const w = r.json<Watch>();
    expect(w).toEqual({ id: w.id, loanId: L1, rules: { liquidation: true, loanGone: true }, lastBand: null, createdAt: NOW.toISOString() });
    expect(w.id).toMatch(/^[0-9a-f]{16}$/);
    db.setWatchBand(w.id, "danger");
    expect((await call("/api/watches")).json<Watch[]>()).toEqual([{ ...w, lastBand: "danger" }]);
    db.setWatchBand(w.id, "gone");
    expect((await call("/api/watches")).json<Watch[]>()[0]!.lastBand).toBeNull();
  });

  it("partial rules are merged over the defaults", async () => {
    const call = setup().user("acc1");
    const w = (await call("/api/watches", { json: { loanId: L1, rules: { loanGone: false } } })).json<Watch>();
    expect(w.rules).toEqual({ liquidation: true, loanGone: false });
  });

  it("404 not_found for an unknown loan; 503 not_ready without state", async () => {
    const s = setup();
    const call = s.user("acc1");
    const r = await call("/api/watches", { json: { loanId: "dd".repeat(32) } });
    expect(r.status).toBe(404);
    expect(r.code()).toBe("not_found");
    s.setState(null);
    const r2 = await call("/api/watches", { json: { loanId: L1 } });
    expect(r2.status).toBe(503);
    expect(r2.code()).toBe("not_ready");
  });

  it("409 watch_exists for a duplicate", async () => {
    const call = setup().user("acc1", NOW_S + 86400);
    expect((await call("/api/watches", { json: { loanId: L1 } })).status).toBe(201);
    const r = await call("/api/watches", { json: { loanId: L1 } });
    expect(r.status).toBe(409);
    expect(r.code()).toBe("watch_exists");
  });

  it("403 watch_limit on the free plan; expired pro counts as free", async () => {
    const s = setup();
    for (const call of [s.user("free"), s.user("expired", NOW_S - 1)]) {
      expect((await call("/api/watches", { json: { loanId: L1 } })).status).toBe(201);
      const r = await call("/api/watches", { json: { loanId: L2 } });
      expect(r.status).toBe(403);
      expect(r.code()).toBe("watch_limit");
    }
  });

  it("Pro (pro_until in the future) is unlimited", async () => {
    const call = setup().user("pro", NOW_S + 86400);
    for (const id of [L1, L2, L3]) expect((await call("/api/watches", { json: { loanId: id } })).status).toBe(201);
    expect((await call("/api/watches")).json<Watch[]>()).toHaveLength(3);
  });

  it("two accounts can watch the same loan; each sees only their own", async () => {
    const s = setup();
    const a = s.user("a");
    const b = s.user("b");
    expect((await a("/api/watches", { json: { loanId: L1 } })).status).toBe(201);
    expect((await b("/api/watches", { json: { loanId: L1 } })).status).toBe(201);
    expect((await a("/api/watches")).json<Watch[]>()).toHaveLength(1);
    expect((await b("/api/watches")).json<Watch[]>()).toHaveLength(1);
  });

  it("400 bad_request on malformed bodies", async () => {
    const call = setup().user("pro", NOW_S + 86400);
    for (const json of [{}, { loanId: 5 }, { loanId: "" }, { loanId: "x".repeat(200) }, { loanId: L1, rules: "yes" }, { loanId: L1, rules: { liquidation: "no" } }, [L1]]) {
      const r = await call("/api/watches", { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.code()).toBe("bad_request");
    }
  });

  it("PATCH updates rules (partial merge); other user's watch is 404", async () => {
    const s = setup();
    const a = s.user("a");
    const b = s.user("b");
    const w = (await a("/api/watches", { json: { loanId: L1 } })).json<Watch>();
    const r = await a(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { loanGone: false } } });
    expect(r.status).toBe(200);
    expect(r.json<Watch>()).toEqual({ ...w, rules: { liquidation: true, loanGone: false } });
    const other = await b(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { liquidation: false } } });
    expect(other.status).toBe(404);
    expect(other.code()).toBe("not_found");
    expect(s.db.getWatch(w.id)!.rules.liquidation).toBe(true);
    expect((await a("/api/watches/nope", { method: "PATCH", json: { rules: {} } })).status).toBe(404);
    expect((await a(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: { liquidation: 1 } } })).status).toBe(400);
    // no rules = no-op, same as the mock
    const noop = await a(`/api/watches/${w.id}`, { method: "PATCH", json: {} });
    expect(noop.status).toBe(200);
    expect(noop.json<Watch>().rules).toEqual({ liquidation: true, loanGone: false });
  });

  it("DELETE own only; other user's watch is 404", async () => {
    const s = setup();
    const a = s.user("a");
    const b = s.user("b");
    const w = (await a("/api/watches", { json: { loanId: L1 } })).json<Watch>();
    const other = await b(`/api/watches/${w.id}`, { method: "DELETE" });
    expect(other.status).toBe(404);
    expect(other.code()).toBe("not_found");
    const r = await a(`/api/watches/${w.id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await a(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(404);
    // the free slot is available again
    expect((await a("/api/watches", { json: { loanId: L2 } })).status).toBe(201);
  });

  it("PATCH needs JSON content type; PATCH/DELETE need the Origin when PUBLIC_ORIGIN is set", async () => {
    const s = setup({ config: { publicOrigin: "https://redline.test" } });
    const call = s.user("a");
    const origin = { origin: "https://redline.test" };
    const w = (await call("/api/watches", { json: { loanId: L1 }, headers: origin })).json<Watch>();
    const badType = await call(`/api/watches/${w.id}`, { method: "PATCH", headers: { ...origin, "content-type": "text/plain" } });
    expect(badType.status).toBe(415);
    const noOrigin = await call(`/api/watches/${w.id}`, { method: "PATCH", json: { rules: {} } });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.code()).toBe("bad_origin");
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE", headers: origin })).status).toBe(200);
  });
});

describe("telegram routes", () => {
  it("link-token: 22-char base64url token, t.me url, 10-minute expiry, only the hash stored", async () => {
    const s = setup();
    const r = await s.user("acc1")("/api/telegram/link-token", { json: {} });
    expect(r.status).toBe(200);
    const body = r.json<TelegramLinkResponse>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`https://t.me/RedlineBot?start=${body.token}`);
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 600_000).toISOString());
    // stored hashed: consuming by hash works once, the raw token is not a key
    expect(s.db.consumeLinkToken(body.token, NOW_S)).toBeNull();
    expect(s.db.consumeLinkToken(hash(body.token), NOW_S + 599)).toBe("acc1");
    expect(s.db.consumeLinkToken(hash(body.token), NOW_S + 599)).toBeNull();
  });

  it("link-token: 503 telegram_unavailable when no bot is configured", async () => {
    const r = await setup({ botUsername: null }).user("acc1")("/api/telegram/link-token", { json: {} });
    expect(r.status).toBe(503);
    expect(r.code()).toBe("telegram_unavailable");
  });

  it("/me telegramLinked reflects telegram_chats; unlink removes it", async () => {
    const s = setup();
    const call = s.user("acc1");
    expect((await call("/api/me")).json<MeResponse>().telegramLinked).toBe(false);
    s.db.linkTelegramChat("acc1", "12345", NOW_S);
    expect((await call("/api/me")).json<MeResponse>().telegramLinked).toBe(true);
    const r = await call("/api/telegram/unlink", { json: {} });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await call("/api/me")).json<MeResponse>().telegramLinked).toBe(false);
    // idempotent
    expect((await call("/api/telegram/unlink", { json: {} })).status).toBe(200);
  });
});
