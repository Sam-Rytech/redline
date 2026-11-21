import { binToHex, lockingBytecodeToCashAddress, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { ApiError, ChallengeResponse, LoanView, MeResponse, Utxo } from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { FUNDING_TXID, makeLoginTx, makeWallet, type TestWallet } from "@redline/wizard-login/testing";
import { LIMITS, MAX_UTXO_ADDRESSES, PEER_LIMIT_FACTOR } from "../src/app.js";
import type { Chain } from "../src/electrum.js";
import type { ChainReader, LoanState } from "../src/reader.js";
import { TEST_ORIGIN, testApp } from "./support.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");
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
const keysOf = (w: TestWallet) => ({ xpubReceive: w.xpubReceive, xpubChange: w.xpubChange });
const accountId = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));

const views = computeLoanViews(
  ["aa", "bb", "cc"].map((id) => ({
    id: id.repeat(32), status: "mature" as const, debtPusd: 1000, collateralSats: 10e8, rateRaw: 274, nextRateRaw: 274, amountBeingRedeemedPusd: 0,
  })),
  200,
);
const loanState: LoanState = {
  blockHeight: 1, priceUsd: 200, updatedAt: NOW.toISOString(), loans: views, byId: new Map(views.map((v) => [v.id, v])), raw: [], missingSidecars: 0,
};
const reader = (s: LoanState | null): ChainReader => ({ current: () => s, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} });

const utxo = (address: string, vout: number, token: Utxo["token"] = null): Utxo => ({ txid: "dd".repeat(32), vout, address, satoshis: 1000, height: 5, token });
const nft = (category: string, capability: "none" | "mutable" | "minting") => ({ category, amount: "0", nft: { capability, commitment: "" } });

function fakeChain(o: { spentElsewhere?: boolean; down?: boolean } = {}) {
  const calls = { getUtxos: [] as string[][] };
  const walletUtxos: Utxo[] = [
    utxo(RECEIVE0, 0, nft("aa".repeat(32), "minting")),
    utxo(CHANGE5, 1, nft("bb".repeat(32), "none")), // not minting, so not this wallet's loan key
    utxo(CHANGE5, 2, nft("ee".repeat(32), "minting")), // minting, but no such loan
  ];
  const chain: Chain = {
    async getSourceOutput(op) {
      if (o.down) throw new Error("electrum down");
      if (op.txid === OUTPOINT.txid && op.vout === OUTPOINT.vout) return { lockingBytecode: wallet.lockingBytecode("receive", 0), valueSatoshis: 10_000n };
      if (op.txid === ATTACKER_OUTPOINT.txid && op.vout === ATTACKER_OUTPOINT.vout) {
        return { lockingBytecode: attacker.lockingBytecode("receive", 0), valueSatoshis: 10_000n };
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

type ReqInit = RequestInit & { json?: unknown; cookie?: string; xff?: string; socketIp?: string; origin?: string | null };

function setup(
  o: { state?: LoanState | null; spentElsewhere?: boolean; down?: boolean; trustProxyHops?: number; clientIpHeader?: string; peerIpHeader?: string } = {},
) {
  const { chain, calls } = fakeChain(o);
  let now = NOW;
  const { app, db } = testApp({
    reader: reader(o.state === undefined ? loanState : o.state),
    chain,
    config: { trustProxyHops: o.trustProxyHops ?? 0, clientIpHeader: o.clientIpHeader, peerIpHeader: o.peerIpHeader },
    now: () => now,
  });
  const bodies: string[] = [];
  const req = async (path: string, init: ReqInit = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
    if ((method === "POST" || method === "PATCH") && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? TEST_ORIGIN);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.xff) headers.set("x-forwarded-for", init.xff);
    const env = { incoming: { socket: { remoteAddress: init.socketIp ?? "127.0.0.1" } } };
    const res = await app.request(path, { ...init, method, headers, ...(init.json !== undefined && { body: JSON.stringify(init.json) }) }, env);
    const text = await res.text();
    bodies.push(text);
    return { res, text, json: <T>() => JSON.parse(text) as T };
  };
  const cookieFrom = (res: Response, name: string): string | null => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
    return c ? c.split(";")[0]! : null;
  };
  const passAge = async (init: ReqInit = {}) => {
    const r = await req("/api/age-check", { json: { dateOfBirth: "1990-05-04" }, ...init });
    expect(r.res.status, r.text).toBe(200);
    return cookieFrom(r.res, "rl_age")!;
  };
  const challenge = async (init: ReqInit = {}, outpoint = OUTPOINT) => {
    const age = await passAge(init);
    const r = await req("/api/auth/challenge", { json: { outpoint, path: ["receive", 0] }, ...init, cookie: [age, init.cookie].filter(Boolean).join("; ") });
    expect(r.res.status, r.text).toBe(200);
    return { ...r.json<ChallengeResponse>(), chCookie: cookieFrom(r.res, "rl_ch")!, setCookie: r.res.headers.getSetCookie() };
  };
  const signIn = async (init: ReqInit = {}) => {
    const ch = await challenge(init);
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const r = await req("/api/auth/verify", { json: { signedTxHex: t.hex, ...keysOf(wallet) }, cookie: ch.chCookie, ...init });
    return { ...r, setCookies: r.res.headers.getSetCookie(), cookie: cookieFrom(r.res, "rl_session") ?? "", tx: t, ch };
  };
  return { db, req, passAge, challenge, signIn, bodies, calls, cookieFrom, setNow: (d: Date) => (now = d) };
}

const code = (text: string) => (JSON.parse(text) as ApiError).error.code;

describe("age screen (COMPLIANCE.md, PRD R8)", () => {
  it("13 or older passes and sets a signed rl_age cookie", async () => {
    const s = setup();
    const r = await s.req("/api/age-check", { json: { dateOfBirth: "2013-11-21" } });
    expect(r.res.status).toBe(200);
    const set = r.res.headers.getSetCookie().find((c) => c.startsWith("rl_age="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
  });

  it("under 13 is blocked, and changing the date afterwards does not pass", async () => {
    const s = setup();
    const r = await s.req("/api/age-check", { json: { dateOfBirth: "2013-11-22" } });
    expect(r.res.status).toBe(403);
    expect(code(r.text)).toBe("age_blocked");
    const blocked = s.cookieFrom(r.res, "rl_age")!;
    const again = await s.req("/api/age-check", { json: { dateOfBirth: "1990-01-01" }, cookie: blocked });
    expect(again.res.status).toBe(403);
    expect(code(again.text)).toBe("age_blocked");
    const ch = await s.req("/api/auth/challenge", { json: { outpoint: OUTPOINT, path: ["receive", 0] }, cookie: blocked });
    expect(code(ch.text)).toBe("age_blocked");
  });

  it("rejects an invalid date with 400 and stores nothing", async () => {
    const s = setup();
    const r = await s.req("/api/age-check", { json: { dateOfBirth: "2000-02-30" } });
    expect(r.res.status).toBe(400);
    expect(r.res.headers.getSetCookie()).toEqual([]);
  });

  it("challenge needs a passed age check (age_required), and a forged cookie does not count", async () => {
    const s = setup();
    for (const cookie of [undefined, "rl_age=ok", `rl_age=ok.${"0".repeat(64)}`]) {
      const r = await s.req("/api/auth/challenge", { json: { outpoint: OUTPOINT, path: ["receive", 0] }, ...(cookie && { cookie }) });
      expect(r.res.status).toBe(403);
      expect(code(r.text)).toBe("age_required");
    }
  });

  it("never stores the date of birth", async () => {
    const s = setup();
    await s.signIn();
    const dump = JSON.stringify(
      ["accounts", "sessions", "challenges"].map((t) => s.db.prepare(`SELECT * FROM ${t}`).all()),
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v),
    );
    expect(dump).not.toContain("1990");
  });
});

describe("sign-in (SECURITY.md, PRD R4, R5)", () => {
  it("age → challenge → sign → verify → session → /me → logout → 401", async () => {
    const s = setup();
    const r = await s.signIn();
    expect(r.res.status, r.text).toBe(200);
    expect(r.json<MeResponse>()).toEqual({ accountId, pro: false, proUntil: null, telegramLinked: false, watchLimit: 1 });
    const session = r.setCookies.find((c) => c.startsWith("rl_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=604800/);
    expect(r.setCookies.some((c) => /^rl_ch=;/.test(c) || /^rl_ch=.*Max-Age=0/i.test(c))).toBe(true);

    expect((await s.req("/api/me", { cookie: r.cookie })).json<MeResponse>().accountId).toBe(accountId);
    const out = await s.req("/api/auth/logout", { json: {}, cookie: r.cookie });
    expect(out.res.status).toBe(200);
    expect(s.db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect((await s.req("/api/me", { cookie: r.cookie })).res.status).toBe(401);
  });

  it("sets rl_ch HttpOnly, Secure, scoped to /api/auth for 5 minutes", async () => {
    const s = setup();
    const ch = await s.challenge();
    const set = ch.setCookie.find((c) => c.startsWith("rl_ch="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/Path=\/api\/auth/);
    expect(set).toMatch(/Max-Age=300/);
  });

  it("the same wallet signs in as the same account from two browsers", async () => {
    const s = setup();
    const a = await s.signIn();
    const b = await s.signIn();
    expect(a.json<MeResponse>().accountId).toBe(b.json<MeResponse>().accountId);
    expect(a.cookie).not.toBe(b.cookie);
    expect(s.db.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 1 });
  });

  it("verify from a different browser fails with 403 challenge_mismatch (relay attack)", async () => {
    const s = setup();
    const ch = await s.challenge();
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const none = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex, ...keysOf(wallet) } });
    expect(none.res.status).toBe(403);
    expect(code(none.text)).toBe("challenge_mismatch");
    const other = await s.challenge();
    const wrong = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex, ...keysOf(wallet) }, cookie: other.chCookie });
    expect(code(wrong.text)).toBe("challenge_mismatch");
  });

  it("replaying the signed login is 410 challenge_used; an expired one is 410 challenge_expired", async () => {
    const s = setup();
    const first = await s.signIn();
    const replay = await s.req("/api/auth/verify", { json: { signedTxHex: first.tx.hex, ...keysOf(wallet) }, cookie: first.ch.chCookie });
    expect(replay.res.status).toBe(410);
    expect(code(replay.text)).toBe("challenge_used");

    const ch = await s.challenge();
    s.setNow(new Date(NOW.getTime() + 301_000));
    const t = makeLoginTx({ wallet, outpoint: OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const late = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex, ...keysOf(wallet) }, cookie: ch.chCookie });
    expect(late.res.status).toBe(410);
    expect(code(late.text)).toBe("challenge_expired");
  });

  it("an attacker's own coin with the victim's xpubs is 422 login_invalid", async () => {
    const s = setup();
    const ch = await s.challenge({}, ATTACKER_OUTPOINT);
    const t = makeLoginTx({ wallet: attacker, outpoint: ATTACKER_OUTPOINT, domain: ch.domain, nonceHex: ch.nonce, expiry: ch.expiry });
    const r = await s.req("/api/auth/verify", { json: { signedTxHex: t.hex, ...keysOf(wallet) }, cookie: ch.chCookie });
    expect(r.res.status).toBe(422);
    expect(code(r.text)).toBe("login_invalid");
    expect(r.text).toContain("wrong_address");
    expect(s.db.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 0 });
  });

  it("other verification failures are 422 login_invalid with the reason", async () => {
    const s = setup({ spentElsewhere: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(422);
    expect(code(r.text)).toBe("login_invalid");
    expect(r.text).toContain("spent");
  });

  it("change-path challenges are refused", async () => {
    const s = setup();
    const age = await s.passAge();
    const r = await s.req("/api/auth/challenge", { json: { outpoint: OUTPOINT, path: ["change", 0] }, cookie: age });
    expect(r.res.status).toBe(400);
    expect(code(r.text)).toBe("bad_path");
  });

  it("an Electrum outage during verify is 503 chain_unavailable", async () => {
    const s = setup({ down: true });
    const r = await s.signIn();
    expect(r.res.status).toBe(503);
    expect(code(r.text)).toBe("chain_unavailable");
  });
});

describe("data minimisation (SECURITY.md)", () => {
  it("accounts hold no xpub; the session holds them encrypted; no response contains them", async () => {
    const s = setup();
    const r = await s.signIn();
    await s.req("/api/me", { cookie: r.cookie });
    await s.req("/api/me/loans", { cookie: r.cookie });
    const cols = (s.db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "created_at", "pro_until", "age_ok", "muted"]);
    const rows = JSON.stringify(
      ["accounts", "sessions", "challenges"].map((t) => s.db.prepare(`SELECT * FROM ${t}`).all()),
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v),
    );
    expect(rows).not.toContain(wallet.xpubReceive);
    expect(rows).not.toContain(wallet.xpubChange);
    expect(rows).not.toContain(r.tx.hex); // the signed transaction is never stored
    for (const b of s.bodies) {
      expect(b).not.toContain(wallet.xpubReceive);
      expect(b).not.toContain(wallet.xpubChange);
    }
  });

  it("the session cookie value is not stored; the row is keyed by its hash", async () => {
    const s = setup();
    const r = await s.signIn();
    const token = r.cookie.split("=")[1]!;
    const ids = (s.db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((x) => x.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(token);
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("/api/me/loans", () => {
  it("returns only loans whose minting loan key sits in the wallet's receive or change addresses", async () => {
    const s = setup();
    const r = await s.signIn();
    const mine = await s.req("/api/me/loans", { cookie: r.cookie });
    expect(mine.res.status).toBe(200);
    expect(mine.json<LoanView[]>().map((l) => l.id)).toEqual(["aa".repeat(32)]);
    const asked = s.calls.getUtxos[0]!;
    expect(asked).toHaveLength(40);
    expect(asked).toContain(RECEIVE0);
    expect(asked).toContain(CHANGE5);
    await s.req("/api/me/loans", { cookie: r.cookie });
    expect(s.calls.getUtxos).toHaveLength(1); // cached for a minute
  });

  it("401 without a session, 503 before chain data", async () => {
    expect((await setup().req("/api/me/loans")).res.status).toBe(401);
    const s = setup({ state: null });
    const r = await s.signIn();
    expect((await s.req("/api/me/loans", { cookie: r.cookie })).res.status).toBe(503);
  });
});

describe("DELETE /api/me (PRD R10)", () => {
  it("removes the account, its sessions, watches, alert history and Telegram link in one step", async () => {
    const s = setup();
    const r = await s.signIn();
    s.db.prepare("INSERT INTO watches (id, account_id, loan_id, rules_json, created_at) VALUES ('w', ?, 'l', '{}', 1)").run(accountId);
    s.db.prepare("INSERT INTO alerts_sent (id, watch_id, rule, band, arming, sent_at) VALUES ('a', 'w', 'liquidation', 'danger', 1, 1)").run();
    s.db.prepare("INSERT INTO telegram_chats (account_id, chat_id, linked_at) VALUES (?, '42', 1)").run(accountId);
    s.db.prepare("INSERT INTO telegram_links (token_hash, account_id, expires_at) VALUES ('t', ?, 9999999999)").run(accountId);
    const del = await s.req("/api/me", { method: "DELETE", cookie: r.cookie });
    expect(del.res.status, del.text).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    for (const t of ["accounts", "sessions", "watches", "alerts_sent", "telegram_chats", "telegram_links"]) {
      expect(s.db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
    expect((await s.req("/api/me", { cookie: r.cookie })).res.status).toBe(401);
  });

  it("needs a session and our Origin", async () => {
    const s = setup();
    expect((await s.req("/api/me", { method: "DELETE" })).res.status).toBe(401);
    const r = await s.signIn();
    const cross = await s.req("/api/me", { method: "DELETE", cookie: r.cookie, origin: "https://evil.example" });
    expect(cross.res.status).toBe(403);
    expect(code(cross.text)).toBe("forbidden_origin");
  });
});

describe("request hardening (SECURITY.md)", () => {
  it("a cross-origin or Origin-less POST is 403 forbidden_origin", async () => {
    const s = setup();
    for (const origin of ["https://evil.example", null]) {
      const r = await s.req("/api/age-check", { json: { dateOfBirth: "1990-01-01" }, origin });
      expect(r.res.status).toBe(403);
      expect(code(r.text)).toBe("forbidden_origin");
    }
  });

  it("a non-JSON POST is 403 forbidden_origin", async () => {
    const s = setup();
    const r = await s.req("/api/age-check", { method: "POST", body: "dateOfBirth=1990-01-01", headers: { "content-type": "text/plain" } });
    expect(r.res.status).toBe(403);
    expect(code(r.text)).toBe("forbidden_origin");
  });

  it("a body over 16 KB is 413 too_large", async () => {
    const s = setup();
    const r = await s.req("/api/age-check", { json: { dateOfBirth: "1990-01-01", pad: "x".repeat(17 * 1024) } });
    expect(r.res.status).toBe(413);
    expect(code(r.text)).toBe("too_large");
  });

  it(`auth routes allow ${LIMITS.auth} requests a minute per IP, then 429`, async () => {
    const s = setup();
    for (let i = 0; i < LIMITS.auth; i++) {
      expect((await s.req("/api/auth/challenge", { json: {}, socketIp: "10.0.0.1" })).res.status).not.toBe(429);
    }
    const over = await s.req("/api/auth/challenge", { json: {}, socketIp: "10.0.0.1" });
    expect(over.res.status).toBe(429);
    expect(code(over.text)).toBe("rate_limited");
    expect((await s.req("/api/auth/challenge", { json: {}, socketIp: "10.0.0.2" })).res.status).not.toBe(429);
    s.setNow(new Date(NOW.getTime() + 61_000));
    expect((await s.req("/api/auth/challenge", { json: {}, socketIp: "10.0.0.1" })).res.status).not.toBe(429);
  });

  it("a spoofed x-forwarded-for does not get around the limit", async () => {
    const direct = setup();
    for (let i = 0; i <= LIMITS.auth; i++) await direct.req("/api/auth/challenge", { json: {}, xff: `1.2.3.${i}` });
    expect((await direct.req("/api/auth/challenge", { json: {}, xff: "9.9.9.9" })).res.status).toBe(429);

    const proxied = setup({ trustProxyHops: 1 });
    for (let i = 0; i <= LIMITS.auth; i++) await proxied.req("/api/auth/challenge", { json: {}, xff: `6.6.6.${i}, 7.7.7.7` });
    expect((await proxied.req("/api/auth/challenge", { json: {}, xff: "1.1.1.1, 7.7.7.7" })).res.status).toBe(429);
    expect((await proxied.req("/api/auth/challenge", { json: {}, xff: "7.7.7.8" })).res.status).not.toBe(429);
  });

  it("behind Vercel and Fly: one limit per visitor, and a looser one per connection", async () => {
    const s = setup({ clientIpHeader: "x-real-ip", peerIpHeader: "fly-client-ip" });
    // /age-check is limited like /auth and is cheap to call
    const via = (visitor: string, peer: string) =>
      s.req("/api/age-check", { json: {}, headers: { "x-real-ip": visitor, "fly-client-ip": peer } });
    // two visitors behind the same Vercel address do not share a limit
    for (let i = 0; i < LIMITS.auth; i++) await via("102.0.0.1", "3.66.0.1");
    expect((await via("102.0.0.1", "3.66.0.1")).res.status).toBe(429);
    expect((await via("102.0.0.2", "3.66.0.1")).res.status).not.toBe(429);
    // a direct caller faking x-real-ip is capped by its real address (fly-client-ip)
    let last = 0;
    for (let i = 0; i <= LIMITS.auth * PEER_LIMIT_FACTOR; i++) last = (await via(`9.9.${i >> 8}.${i & 255}`, "66.6.6.6")).res.status;
    expect(last).toBe(429);
    // a value that is not an IP falls back to the connection
    for (let i = 0; i < LIMITS.auth; i++) await via("not-an-ip", "5.5.5.5");
    expect((await via("not-an-ip", "5.5.5.5")).res.status).toBe(429);
  });

  it(`/utxos takes at most ${MAX_UTXO_ADDRESSES} mainnet addresses and ${LIMITS.utxos} calls a minute`, async () => {
    const s = setup();
    const many = Array.from({ length: MAX_UTXO_ADDRESSES + 1 }, () => RECEIVE0).join(",");
    expect((await s.req(`/api/utxos?addresses=${many}`)).res.status).toBe(400);
    expect((await s.req("/api/utxos?addresses=not-an-address")).res.status).toBe(400);
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0.slice("bitcoincash:".length)}`)).res.status).toBe(400);
    const ok = await s.req(`/api/utxos?addresses=${RECEIVE0}`);
    expect(ok.res.status).toBe(200);
    expect(ok.json<Utxo[]>()).toHaveLength(1);
    for (let i = 0; i < LIMITS.utxos - 4; i++) await s.req(`/api/utxos?addresses=${RECEIVE0}`);
    expect((await s.req(`/api/utxos?addresses=${RECEIVE0}`)).res.status).toBe(429);
  });
});
