import { binToHex, decodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it, vi } from "vitest";
import type { ApiError, ChallengeResponse, LoanView, MeResponse, Utxo } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { FUNDING_TXID, makeLoginTx, makeWallet } from "@redline/wizard-login/testing";
import { createApp, type AppDeps } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Chain } from "../src/electrum.js";
import type { ChainReader, LoanState } from "../src/reader.js";

const DOMAIN = "redline.test";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const wallet = makeWallet(3);
const attacker = makeWallet(4);
const OUTPOINT = { txid: FUNDING_TXID, vout: 1 };
const ATTACKER_OUTPOINT = { txid: FUNDING_TXID, vout: 2 };
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
      if (op.txid === OUTPOINT.txid && op.vout === OUTPOINT.vout) return { lockingBytecode: wallet.lockingBytecode("receive", 0), valueSatoshis: 10_000n };
      if (op.txid === ATTACKER_OUTPOINT.txid && op.vout === ATTACKER_OUTPOINT.vout) {
        return { lockingBytecode: attacker.lockingBytecode("change", 0), valueSatoshis: 10_000n };
      }
      return null;
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

type ReqInit = RequestInit & { json?: unknown; cookie?: string; xff?: string; socketIp?: string; origin?: string };

function setup(o: { secureCookies?: boolean; state?: LoanState | null; spentElsewhere?: boolean; config?: Partial<AppDeps["config"]> } = {}) {
  const db = openDb(":memory:");
  const { chain, calls } = fakeChain(o);
  let now = NOW;
  const app = createApp({
    reader: reader(o.state === undefined ? loanState : o.state),
    db,
    chain,
    config: { loginDomain: DOMAIN, secureCookies: o.secureCookies ?? false, trustProxyHops: 0, logXff: false, publicOrigin: undefined, ...o.config },
    now: () => now,
  });
  const bodies: string[] = [];
  const req = async (path: string, init: ReqInit = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
    if (method === "POST" && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.xff) headers.set("x-forwarded-for", init.xff);
    if (init.origin) headers.set("origin", init.origin);
    const env = { incoming: { socket: { remoteAddress: init.socketIp ?? "127.0.0.1" } } };
    const res = await app.request(
      path,
      { ...init, method, headers, ...(init.json !== undefined && { body: JSON.stringify(init.json) }) },
      env,
    );
    const text = await res.text();
    bodies.push(text);
    return { res, text, json: <T>() => JSON.parse(text) as T };
  };
  const cookieFrom = (res: Response, name: string): string | null => {
    const all = res.headers.getSetCookie();
    const c = all.find((x) => x.startsWith(`${name}=`));
    return c ? c.split(";")[0]! : null;
  };
  const challenge = async (init: ReqInit = {}, body: unknown = { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] }) => {
    const r = await req("/api/auth/challenge", { json: body, ...init });
    expect(r.res.status, r.text).toBe(200);
    return { ...r.json<ChallengeResponse>(), chalCookie: cookieFrom(r.res, "rl_chal")!, setCookie: r.res.headers.getSetCookie() };
  };
  const signIn = async (init: ReqInit = {}) => {
    const ch = await challenge(init);
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const r = await req("/api/auth/verify", { json: { signedTxHex: t.hex }, cookie: ch.chalCookie, ...init });
    const cookie = cookieFrom(r.res, "rl_session") ?? "";
    return { ...r, setCookies: r.res.headers.getSetCookie(), cookie, tx: t, ch };
  };
  return { app, db, req, challenge, signIn, bodies, calls, cookieFrom, setNow: (d: Date) => (now = d) };
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
    const chalSet = ch.setCookie.find((c) => c.startsWith("rl_chal="))!;
    expect(chalSet).toMatch(/^rl_chal=[0-9a-f]{64};/);
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/api/auth", "Max-Age=300"]) expect(chalSet).toContain(part);

    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const v = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex }, cookie: ch.chalCookie });
    expect(v.res.status, v.text).toBe(200);
    expect(v.json<MeResponse>()).toEqual({ accountId, pro: false, proUntil: null, telegramLinked: false, watchLimit: 1 });
    const setCookies = v.res.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith("rl_session="))!;
    expect(session).toMatch(/^rl_session=[0-9a-f]{64};/);
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(session).toContain(part);
    expect(session).not.toContain("Secure");
    // challenge cookie is cleared
    expect(setCookies.find((c) => c.startsWith("rl_chal="))).toMatch(/rl_chal=;.*Max-Age=0/);
    const cookie = session.split(";")[0]!;

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

  it("Secure cookies when configured", async () => {
    const s = setup({ secureCookies: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(200);
    expect(r.ch.setCookie.find((c) => c.startsWith("rl_chal="))).toContain("Secure");
    expect(r.setCookies.find((c) => c.startsWith("rl_session="))).toContain("Secure");
  });

  it("reused tx → 401 nonce_used", async () => {
    const s = setup();
    const first = await s.signIn();
    expect(first.res.status).toBe(200);
    const again = await s.req("/api/auth/verify", { json: { signedTxHex: first.tx.hex }, cookie: first.ch.chalCookie });
    expect(again.res.status).toBe(401);
    expect(code(again.text)).toBe("nonce_used");
  });

  it("PoC: victim receive xpub + attacker change xpub/UTXO on the change path → 400 bad_path, no session", async () => {
    const s = setup();
    const r = await s.req("/api/auth/challenge", {
      json: { xpubReceive: wallet.xpubReceive, xpubChange: attacker.xpubChange, outpoint: ATTACKER_OUTPOINT, path: ["change", 0] },
    });
    expect(r.res.status).toBe(400);
    expect(code(r.text)).toBe("bad_path");
    // and claiming the attacker's change coin on the receive path fails verification
    const ch = await s.challenge({}, { xpubReceive: wallet.xpubReceive, xpubChange: attacker.xpubChange, outpoint: ATTACKER_OUTPOINT, path: ["receive", 0] });
    const t = makeLoginTx({ wallet: attacker, path: ["change", 0], outpoint: ATTACKER_OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const v = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex }, cookie: ch.chalCookie });
    expect(v.res.status).toBe(401);
    expect(code(v.text)).toBe("wrong_address");
    expect(s.db.getAccount(accountId)).toBeNull();
  });

  it("challenge_not_bound: valid signed tx without / with another browser's challenge cookie", async () => {
    const s = setup();
    const ch = await s.challenge();
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const none = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex } });
    expect(none.res.status).toBe(401);
    expect(code(none.text)).toBe("challenge_not_bound");
    const otherBrowser = await s.challenge();
    const wrong = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex }, cookie: otherBrowser.chalCookie });
    expect(wrong.res.status).toBe(401);
    expect(code(wrong.text)).toBe("challenge_not_bound");
    // the rightful browser can still use it
    const ok = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex }, cookie: ch.chalCookie });
    expect(ok.res.status).toBe(200);
  });

  it("verify failure codes are passed through as 401", async () => {
    const s = setup({ spentElsewhere: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(401);
    expect(code(r.text)).toBe("spent");
    expect(s.cookieFrom(r.res, "rl_session")).toBeNull();
    const garbage = await s.req("/api/auth/verify", { json: { signedTxHex: "00" } });
    expect(garbage.res.status).toBe(401);
    expect(code(garbage.text)).toBe("bad_tx");
  });

  it("400 on malformed requests", async () => {
    const s = setup();
    const bad = await s.req("/api/auth/verify", { method: "POST", body: "not json" });
    expect(bad.res.status).toBe(400);
    expect(code(bad.text)).toBe("bad_request");
    expect(code((await s.req("/api/auth/verify", { json: {} })).text)).toBe("bad_request");
    const ch = await s.req("/api/auth/challenge", { json: { xpubReceive: "nope", xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 0] } });
    expect(ch.res.status).toBe(400);
    expect(code(ch.text)).toBe("bad_xpub");
    const ch2 = await s.req("/api/auth/challenge", { json: { xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, outpoint: OUTPOINT, path: ["receive", 1000] } });
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

  it("the signed tx decodes and has a txid", async () => {
    const s = setup();
    const r = await s.signIn();
    expect(typeof decodeTransaction(hexToBin(r.tx.hex))).not.toBe("string");
    expect(hashTransaction(hexToBin(r.tx.hex))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("request hardening", () => {
  it("413 too_large for POST bodies over 32 KB", async () => {
    const s = setup();
    const r = await s.req("/api/auth/verify", { json: { signedTxHex: "00".repeat(20_000) } });
    expect(r.res.status).toBe(413);
    expect(code(r.text)).toBe("too_large");
  });

  it("415 bad_content_type on POST /api/auth/* without JSON content type", async () => {
    const s = setup();
    for (const path of ["/api/auth/challenge", "/api/auth/verify", "/api/auth/logout"]) {
      for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
        const r = await s.req(path, { method: "POST", body: "{}", headers: { "content-type": ct } });
        expect(r.res.status, `${path} ${ct}`).toBe(415);
        expect(code(r.text)).toBe("bad_content_type");
      }
    }
    const charset = await s.req("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" } });
    expect(charset.res.status).toBe(200);
  });

  it("403 bad_origin when PUBLIC_ORIGIN is set and Origin differs or is missing", async () => {
    const s = setup({ config: { publicOrigin: "https://redline.app" } });
    for (const origin of [undefined, "https://evil.example", "https://redline.app.evil.example"]) {
      const r = await s.req("/api/auth/logout", { method: "POST", ...(origin && { origin }) });
      expect(r.res.status, String(origin)).toBe(403);
      expect(code(r.text)).toBe("bad_origin");
    }
    const ok = await s.signIn({ origin: "https://redline.app" });
    expect(ok.res.status).toBe(200);
  });

  it("no origin check when PUBLIC_ORIGIN is unset", async () => {
    const s = setup();
    expect((await s.req("/api/auth/logout", { method: "POST", origin: "https://anything.example" })).res.status).toBe(200);
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
    const asked = s.calls.getUtxos.flat();
    expect(asked).toHaveLength(40);
    expect(asked).toContain(RECEIVE0);
    expect(asked).toContain(CHANGE5);
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
      const r = await s.req(`/api/utxos${q}`, { socketIp: "1.1.1.1" });
      expect(r.res.status, q).toBe(400);
      expect(code(r.text)).toBe("bad_request");
    }
    const many = Array.from({ length: 61 }, () => RECEIVE0).join(",");
    expect((await s.req(`/api/utxos?addresses=${many}`, { socketIp: "1.1.1.2" })).res.status).toBe(400);
    const sixty = Array.from({ length: 60 }, () => RECEIVE0).join(",");
    expect((await s.req(`/api/utxos?addresses=${sixty}`, { socketIp: "1.1.1.2" })).res.status).toBe(200);
  });
});

describe("rate limit (30/min per IP on /api/auth/* and /api/utxos)", () => {
  it("uses the socket address by default; spoofed x-forwarded-for does not bypass", async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "9.9.9.9", xff: `10.0.0.${i}` })).res.status).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      const r = await s.req("/api/auth/verify", { json: { signedTxHex: "00" }, socketIp: "9.9.9.9", xff: `11.0.0.${i}` });
      expect(r.res.status).toBe(401);
    }
    const limited = await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "9.9.9.9", xff: "12.0.0.1" });
    expect(limited.res.status).toBe(429);
    expect(code(limited.text)).toBe("rate_limited");
    expect((await s.req("/api/auth/logout", { method: "POST", socketIp: "9.9.9.9" })).res.status).toBe(429);
    // other IPs and non-limited routes unaffected
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "8.8.8.8" })).res.status).toBe(200);
    expect((await s.req("/api/loans", { socketIp: "9.9.9.9" })).res.status).toBe(200);
    // next window
    s.setNow(new Date(NOW.getTime() + 60_000));
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "9.9.9.9" })).res.status).toBe(200);
  });

  it("1 hop uses the right-most x-forwarded-for entry; a spoofed left-most entry does not bypass", async () => {
    const s = setup({ config: { trustProxyHops: 1 } });
    for (let i = 0; i < 30; i++) {
      const r = await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: `6.6.6.${i}, 9.9.9.9` });
      expect(r.res.status).toBe(200);
    }
    const limited = await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "1.2.3.4, 9.9.9.9" });
    expect(limited.res.status).toBe(429);
    // a different real client behind the same proxy is fine
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "9.9.9.9, 7.7.7.7" })).res.status).toBe(200);
  });

  it("2 hops uses the second-from-right entry (Vercel -> Railway); spoofed left entries do not bypass", async () => {
    const s = setup({ config: { trustProxyHops: 2 } });
    // chain: <client-spoofed...>, real client, vercel edge
    for (let i = 0; i < 30; i++) {
      const r = await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: `6.6.6.${i}, 5.5.5.5, 3.3.3.3` });
      expect(r.res.status).toBe(200);
    }
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "1.2.3.4, 5.5.5.5, 3.3.3.9" })).res.status).toBe(429);
    // the right-most entry alone is not the key
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "8.8.8.8, 3.3.3.3" })).res.status).toBe(200);
  });

  it("falls back to the left-most entry when the header has fewer entries than hops", async () => {
    const s = setup({ config: { trustProxyHops: 3 } });
    for (let i = 0; i < 30; i++) {
      expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "5.5.5.5, 3.3.3.3" })).res.status).toBe(200);
    }
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.1", xff: "5.5.5.5" })).res.status).toBe(429);
    // no header at all: socket address
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`, { socketIp: "100.64.0.2" })).res.status).toBe(200);
  });

  it("LOG_XFF logs the raw x-forwarded-for of the first 5 /api/auth requests only", async () => {
    const s = setup({ config: { logXff: true } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 8; i++) await s.req("/api/utxos?addresses=" + RECEIVE0, { socketIp: "4.4.4.4", xff: "ignored" });
      expect(log).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) await s.req("/api/auth/verify", { json: { signedTxHex: "00" }, socketIp: `4.4.4.${i}`, xff: `1.1.1.${i}, 2.2.2.2` });
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("x-forwarded-for"));
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain("1.1.1.0, 2.2.2.2");
      expect(lines.join("\n")).not.toContain("1.1.1.5");
    } finally {
      log.mockRestore();
    }
  });

  it("does not log x-forwarded-for unless LOG_XFF is set", async () => {
    const s = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await s.req("/api/auth/verify", { json: { signedTxHex: "00" }, xff: "1.1.1.1" });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
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
