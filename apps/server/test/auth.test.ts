import { binToHex, decodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { ApiError, ChallengeResponse, LoanView, MeResponse, Utxo } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { FUNDING_TXID, makeLoginTx, makeWallet } from "@redline/wizard-login/testing";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Chain } from "../src/electrum.js";
import type { ChainReader, LoanState } from "../src/reader.js";

const DOMAIN = "redline.test";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const wallet = makeWallet(3);
const OUTPOINT = { txid: FUNDING_TXID, vout: 1 };
const addr = (b: Uint8Array) => {
  const r = lockingBytecodeToCashAddress({ bytecode: b, prefix: "bitcoincash" });
  if (typeof r === "string") throw new Error(r);
  return r.address;
};
const RECEIVE0 = addr(wallet.lockingBytecode("receive", 0));
const CHANGE5 = addr(wallet.lockingBytecode("change", 5));

const views = computeLoanViews(
  ["aa", "bb", "cc"].map((id) => ({
    id: id.repeat(32), status: "mature" as const, debtPusd: 1000, collateralSats: 10e8, interestRatePct: 1, nextInterestRatePct: 1, amountBeingRedeemedPusd: 0,
  })),
  200,
);
const loanState: LoanState = { blockHeight: 1, priceUsd: 200, updatedAt: NOW.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])) };
const reader = (s: LoanState | null): ChainReader => ({ current: () => s, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} });

const utxo = (address: string, vout: number, token: Utxo["token"] = null): Utxo => ({ txid: "dd".repeat(32), vout, address, satoshis: 1000, height: 5, token });
const nft = (category: string, capability: "none" | "mutable" | "minting") => ({ category, amount: "0", nft: { capability, commitment: "" } });

function fakeChain(o: { spentElsewhere?: boolean } = {}) {
  const calls = { getUtxos: [] as string[][] };
  const walletUtxos: Utxo[] = [
    utxo(RECEIVE0, 0, nft("aa".repeat(32), "minting")),
    utxo(CHANGE5, 1, nft("bb".repeat(32), "none")), // not minting → not mine
    utxo(CHANGE5, 2, nft("ee".repeat(32), "minting")), // minting but no such loan
    utxo("bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", 3, nft("cc".repeat(32), "minting")), // someone else
  ];
  const chain: Chain = {
    async getSourceOutput(op) {
      return op.txid === OUTPOINT.txid && op.vout === OUTPOINT.vout
        ? { lockingBytecode: wallet.lockingBytecode("receive", 0), valueSatoshis: 10_000n }
        : null;
    },
    async isUnspentOrSpentBy() {
      return !o.spentElsewhere;
    },
    async getUtxos(addresses) {
      calls.getUtxos.push(addresses);
      return walletUtxos.filter((u) => addresses.includes(u.address));
    },
  };
  return { chain, calls };
}

function setup(o: { secureCookies?: boolean; state?: LoanState | null; spentElsewhere?: boolean } = {}) {
  const db = openDb(":memory:");
  const { chain, calls } = fakeChain(o);
  let now = NOW;
  const app = createApp({
    reader: reader(o.state === undefined ? loanState : o.state),
    db,
    chain,
    config: { loginDomain: DOMAIN, secureCookies: o.secureCookies ?? false },
    now: () => now,
  });
  const bodies: string[] = [];
  const req = async (path: string, init: RequestInit & { json?: unknown; cookie?: string; ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.ip) headers.set("x-forwarded-for", `${init.ip}, 10.0.0.1`);
    const res = await app.request(path, {
      ...init,
      headers,
      ...(init.json !== undefined && { method: init.method ?? "POST", body: JSON.stringify(init.json) }),
    });
    const text = await res.text();
    bodies.push(text);
    return { res, text, json: <T>() => JSON.parse(text) as T };
  };
  const challenge = async (path: ["receive" | "change", number] = ["receive", 0]) => {
    const r = await req("/api/auth/challenge", { json: { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path } });
    expect(r.res.status).toBe(200);
    return r.json<ChallengeResponse>();
  };
  const signIn = async () => {
    const ch = await challenge();
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const r = await req("/api/auth/verify", { json: { signedTxHex: t.hex } });
    const setCookie = r.res.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]!;
    return { ...r, setCookie, cookie, tx: t };
  };
  return { app, db, req, challenge, signIn, bodies, calls, setNow: (d: Date) => (now = d) };
}

const accountId = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));
const code = (text: string) => (JSON.parse(text) as ApiError).error.code;

describe("auth flow", () => {
  it("challenge → sign → verify → cookie → /me → logout → 401", async () => {
    const s = setup();
    const ch = await s.challenge();
    expect(ch.domain).toBe(DOMAIN);
    expect(ch.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.expiry).toBe(NOW.getTime() / 1000 + 300);

    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const v = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex } });
    expect(v.res.status).toBe(200);
    expect(v.json<MeResponse>()).toEqual({ accountId, pro: false, proUntil: null, telegramLinked: false, watchLimit: 1 });
    const setCookie = v.res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^rl_session=[0-9a-f]{64};/);
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(setCookie).toContain(part);
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0]!;

    const me = await s.req("/api/me", { cookie });
    expect(me.res.status).toBe(200);
    expect(me.json<MeResponse>().accountId).toBe(accountId);

    const out = await s.req("/api/auth/logout", { method: "POST", cookie });
    expect(out.res.status).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(out.res.headers.get("set-cookie")).toMatch(/rl_session=;.*Max-Age=0/);

    const after = await s.req("/api/me", { cookie });
    expect(after.res.status).toBe(401);
    expect(code(after.text)).toBe("unauthorized");
  });

  it("Secure cookie when configured", async () => {
    const s = setup({ secureCookies: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(200);
    expect(r.setCookie).toContain("Secure");
  });

  it("reused tx → 401 nonce_used", async () => {
    const s = setup();
    const first = await s.signIn();
    expect(first.res.status).toBe(200);
    const again = await s.req("/api/auth/verify", { json: { signedTxHex: first.tx.hex } });
    expect(again.res.status).toBe(401);
    expect(code(again.text)).toBe("nonce_used");
  });

  it("verify failure codes are passed through as 401", async () => {
    const s = setup({ spentElsewhere: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(401);
    expect(code(r.text)).toBe("spent");
    expect(r.res.headers.get("set-cookie")).toBeNull();
    const garbage = await s.req("/api/auth/verify", { json: { signedTxHex: "00" } });
    expect(garbage.res.status).toBe(401);
    expect(code(garbage.text)).toBe("bad_tx");
  });

  it("400 on malformed requests", async () => {
    const s = setup();
    const bad = await s.req("/api/auth/verify", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
    expect(bad.res.status).toBe(400);
    expect(code(bad.text)).toBe("bad_request");
    expect(code((await s.req("/api/auth/verify", { json: {} })).text)).toBe("bad_request");
    const ch = await s.req("/api/auth/challenge", { json: { xpubReceive: "nope", xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] } });
    expect(ch.res.status).toBe(400);
    expect(code(ch.text)).toBe("bad_xpub");
    const ch2 = await s.req("/api/auth/challenge", { json: { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["defi", 0] } });
    expect(ch2.res.status).toBe(400);
    expect(code(ch2.text)).toBe("bad_request");
  });

  it("expired session → 401", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    s.setNow(new Date(NOW.getTime() + 604_801_000));
    expect((await s.req("/api/me", { cookie })).res.status).toBe(401);
  });

  it("upsert keeps created_at on second sign-in; accountId stable", async () => {
    const s = setup();
    const a = await s.signIn();
    s.setNow(new Date(NOW.getTime() + 10_000));
    const b = await s.signIn();
    expect(b.res.status).toBe(200);
    expect(b.json<MeResponse>().accountId).toBe(a.json<MeResponse>().accountId);
    expect(s.db.getAccount(accountId)!.createdAt).toBe(NOW.getTime() / 1000);
  });

  it("pro reflects pro_until", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    const until = NOW.getTime() / 1000 + 86_400;
    s.db.setProUntil(accountId, until);
    const me = (await s.req("/api/me", { cookie })).json<MeResponse>();
    expect(me).toMatchObject({ pro: true, proUntil: new Date(until * 1000).toISOString(), watchLimit: null });
  });

  it("the signed tx's txid is what gets checked against the chain", async () => {
    const s = setup();
    const r = await s.signIn();
    const tx = decodeTransaction(hexToBin(r.tx.hex));
    expect(typeof tx).not.toBe("string");
    expect(hashTransaction(hexToBin(r.tx.hex))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GET /api/me/loans", () => {
  it("401 without a session", async () => {
    const s = setup();
    const r = await s.req("/api/me/loans");
    expect(r.res.status).toBe(401);
    expect(code(r.text)).toBe("unauthorized");
  });

  it("returns only loans whose id matches a minting NFT in the wallet", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    const r = await s.req("/api/me/loans", { cookie });
    expect(r.res.status).toBe(200);
    expect(r.json<LoanView[]>().map((l) => l.id)).toEqual(["aa".repeat(32)]);
    // derived receive + change 0..19
    const asked = s.calls.getUtxos.flat();
    expect(asked).toHaveLength(40);
    expect(asked).toContain(RECEIVE0);
    expect(asked).toContain(CHANGE5);
    // cached for 60 s per account
    await s.req("/api/me/loans", { cookie });
    expect(s.calls.getUtxos).toHaveLength(1);
    s.setNow(new Date(NOW.getTime() + 61_000));
    await s.req("/api/me/loans", { cookie });
    expect(s.calls.getUtxos).toHaveLength(2);
  });

  it("503 not_ready when the reader has no state", async () => {
    const s = setup({ state: null });
    const { cookie } = await s.signIn();
    const r = await s.req("/api/me/loans", { cookie });
    expect(r.res.status).toBe(503);
    expect(code(r.text)).toBe("not_ready");
  });
});

describe("GET /api/utxos", () => {
  it("returns Utxo[] for valid addresses", async () => {
    const s = setup();
    const r = await s.req(`/api/utxos?addresses=${RECEIVE0},${CHANGE5}`);
    expect(r.res.status).toBe(200);
    const list = r.json<Utxo[]>();
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual(utxo(RECEIVE0, 0, nft("aa".repeat(32), "minting")));
  });

  it("400 on missing, invalid, non-mainnet or too many addresses", async () => {
    const s = setup();
    for (const q of ["", "?addresses=", "?addresses=nope", `?addresses=${RECEIVE0},bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq`, `?addresses=${RECEIVE0.slice("bitcoincash:".length)}`]) {
      const r = await s.req(`/api/utxos${q}`, { ip: "1.1.1.1" });
      expect(r.res.status, q).toBe(400);
      expect(code(r.text)).toBe("bad_request");
    }
    const many = Array.from({ length: 61 }, () => RECEIVE0).join(",");
    expect((await s.req(`/api/utxos?addresses=${many}`, { ip: "1.1.1.2" })).res.status).toBe(400);
    const sixty = Array.from({ length: 60 }, () => RECEIVE0).join(",");
    expect((await s.req(`/api/utxos?addresses=${sixty}`, { ip: "1.1.1.2" })).res.status).toBe(200);
  });

  it("rate limits /api/utxos and /api/auth/* at 30/min per IP", async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { ip: "9.9.9.9" })).res.status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const r = await s.req("/api/auth/verify", { json: { signedTxHex: "00" }, ip: "9.9.9.9" });
      expect(r.res.status).toBe(401);
    }
    const limited = await s.req(`/api/utxos?addresses=${RECEIVE0}`, { ip: "9.9.9.9" });
    expect(limited.res.status).toBe(429);
    expect(code(limited.text)).toBe("rate_limited");
    expect((await s.req("/api/auth/logout", { method: "POST", ip: "9.9.9.9" })).res.status).toBe(429);
    // other IPs and non-limited routes unaffected
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { ip: "8.8.8.8" })).res.status).toBe(200);
    expect((await s.req("/api/loans", { ip: "9.9.9.9" })).res.status).toBe(200);
    // next window
    s.setNow(new Date(NOW.getTime() + 60_000));
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { ip: "9.9.9.9" })).res.status).toBe(200);
  });
});

describe("privacy", () => {
  it("xpubs never appear in any response body", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    await s.req("/api/me", { cookie });
    await s.req("/api/me/loans", { cookie });
    await s.req("/api/auth/logout", { method: "POST", cookie });
    await s.req("/api/auth/challenge", { json: { xpubReceive: wallet.xpubReceive, xpubChange: "bad", outpoint: OUTPOINT, path: ["receive", 0] } });
    expect(s.bodies.length).toBeGreaterThan(5);
    for (const b of s.bodies) {
      expect(b).not.toContain(wallet.xpubReceive);
      expect(b).not.toContain(wallet.xpubChange);
    }
  });
});
