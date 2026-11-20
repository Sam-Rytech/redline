import { randomBytes } from "node:crypto";
import { binToHex, decodeCashAddress, sha256, utf8ToBin } from "@bitauth/libauth";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  FREE_WATCH_LIMIT,
  type ApiError,
  type ChallengeRequest,
  type ChallengeResponse,
  type LoansResponse,
  type MeResponse,
  type OkResponse,
} from "@redline/api-types";
import { summarize } from "@redline/paryon-decoder";
import { ChallengeError, createChallenge, p2pkhForXpub, verifyLogin, type VerifyDeps } from "@redline/wizard-login/server";
import type { ServerConfig } from "./config.js";
import type { AccountRow, Db } from "./db.js";
import { addressFor, type Chain } from "./electrum.js";
import type { ChainReader } from "./reader.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const STALE_MS = 5 * 60_000;
const CACHE_CONTROL = "public, max-age=15";

export const SESSION_COOKIE = "rl_session";
export const SESSION_SECONDS = 7 * 24 * 3600;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_UTXO_ADDRESSES = 60;
const WALLET_ADDRESS_COUNT = 20;
const WALLET_CACHE_MS = 60_000;

/** Sessions are stored by hash so a leaked DB does not leak live cookies. */
const sessionKey = (token: string) => binToHex(sha256.hash(utf8ToBin(token)));
const isSessionToken = (t: string | undefined): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

export interface AppDeps {
  reader: ChainReader;
  db: Db;
  chain: Chain;
  config: Pick<ServerConfig, "loginDomain" | "secureCookies">;
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const { reader, db, chain, config } = deps;
  const now = deps.now ?? (() => new Date());
  const nowSec = () => Math.floor(now().getTime() / 1000);
  const app = new Hono().basePath("/api");

  app.notFound((c) => c.json(err("not_found", "No such route"), 404));
  app.onError((e, c) => {
    console.error(e instanceof Error ? e.message : "unknown error");
    return c.json(err("internal", "Internal error"), 500);
  });

  const notReady = (c: Context) =>
    c.json(err("not_ready", "Loading chain data, try again in a few seconds"), 503);
  const badRequest = (c: Context, message: string) => c.json(err("bad_request", message), 400);
  const chainDown = (c: Context, e: unknown) => {
    console.error(`chain request failed: ${e instanceof Error ? e.message : String(e)}`);
    return c.json(err("chain_unavailable", "Could not reach the BCH network, try again"), 503);
  };

  // ---------- rate limit: fixed window, per IP, shared by /auth/* and /utxos ----------
  let windowId = -1;
  const hits = new Map<string, number>();
  const clientIp = (c: Context): string => {
    const xff = c.req.header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    if (first) return first;
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? "unknown";
  };
  const rateLimit = async (c: Context, next: () => Promise<void>) => {
    const w = Math.floor(now().getTime() / RATE_WINDOW_MS);
    if (w !== windowId) {
      windowId = w;
      hits.clear();
    }
    const ip = clientIp(c);
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    if (n > RATE_LIMIT) return c.json(err("rate_limited", "Too many requests, slow down"), 429);
    await next();
  };
  app.use("/auth/*", rateLimit);
  app.use("/utxos", rateLimit);

  // ---------- sessions ----------
  const sessionAccount = (c: Context): AccountRow | null => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!isSessionToken(token)) return null;
    const s = db.getSession(sessionKey(token), nowSec());
    return s ? db.getAccount(s.accountId) : null;
  };
  const unauthorized = (c: Context) => c.json(err("unauthorized", "Sign in first"), 401);
  const meFor = (a: AccountRow): MeResponse => {
    const pro = a.proUntil !== null && a.proUntil > nowSec();
    return {
      accountId: a.id,
      pro,
      proUntil: a.proUntil !== null ? new Date(a.proUntil * 1000).toISOString() : null,
      telegramLinked: false,
      watchLimit: pro ? null : FREE_WATCH_LIMIT,
    };
  };
  const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await c.req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  // ---------- public loan data ----------
  app.get("/health", (c) => {
    const s = reader.current();
    const stale = !s || now().getTime() - new Date(s.updatedAt).getTime() > STALE_MS;
    return c.json({
      ok: true,
      blockHeight: s?.blockHeight ?? null,
      updatedAt: s?.updatedAt ?? null,
      stale,
      lastError: reader.lastError(),
    });
  });

  app.get("/loans", (c) => {
    const s = reader.current();
    if (!s) return notReady(c);
    const body: LoansResponse = {
      blockHeight: s.blockHeight,
      priceUsd: s.priceUsd,
      updatedAt: s.updatedAt,
      summary: summarize(s.loans),
      loans: s.loans,
    };
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(body);
  });

  app.get("/loans/:id", (c) => {
    const s = reader.current();
    if (!s) return notReady(c);
    const loan = s.byId.get(c.req.param("id"));
    if (!loan) return c.json(err("not_found", "No such loan"), 404);
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(loan);
  });

  // ---------- auth ----------
  app.post("/auth/challenge", async (c) => {
    const body = await readJson(c);
    if (!body) return badRequest(c, "Expected a JSON ChallengeRequest");
    const t = nowSec();
    let ch;
    try {
      ch = createChallenge(body as unknown as ChallengeRequest, {
        domain: config.loginDomain,
        now: t,
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
      });
    } catch (e) {
      if (e instanceof ChallengeError) return c.json(err(e.code, e.message), 400);
      throw e;
    }
    db.purgeExpired(t);
    db.insertChallenge(ch);
    const res: ChallengeResponse = { nonce: ch.nonceHex, expiry: ch.expiry, domain: ch.domain };
    return c.json(res);
  });

  app.post("/auth/verify", async (c) => {
    const body = await readJson(c);
    const hex = body?.signedTxHex;
    if (typeof hex !== "string" || hex.length === 0 || hex.length > 20_000) {
      return badRequest(c, "Expected { signedTxHex }");
    }
    const vdeps: VerifyDeps = {
      domain: config.loginDomain,
      now: nowSec,
      getChallenge: async (n) => db.getChallenge(n),
      markChallengeUsed: async (n, t) => db.markChallengeUsed(n, t),
      getSourceOutput: (op) => chain.getSourceOutput(op),
      isUnspentOrSpentBy: (op, txid) => chain.isUnspentOrSpentBy(op, txid),
    };
    let result;
    try {
      result = await verifyLogin(hex.toLowerCase(), vdeps);
    } catch (e) {
      return chainDown(c, e);
    }
    if (!result.ok) return c.json(err(result.code, result.message), 401);

    const t = nowSec();
    db.upsertAccount({ id: result.accountId, xpubReceive: result.xpubReceive, xpubChange: result.xpubChange, now: t });
    const token = randomBytes(32).toString("hex");
    db.createSession(sessionKey(token), result.accountId, t + SESSION_SECONDS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_SECONDS,
      ...(config.secureCookies && { secure: true }),
    });
    const account = db.getAccount(result.accountId);
    if (!account) throw new Error("account vanished after upsert");
    return c.json(meFor(account));
  });

  app.post("/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (isSessionToken(token)) db.deleteSession(sessionKey(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", ...(config.secureCookies && { secure: true }) });
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  app.get("/me", (c) => {
    const a = sessionAccount(c);
    return a ? c.json(meFor(a)) : unauthorized(c);
  });

  // ---------- wallet views ----------
  const mintingCache = new Map<string, { at: number; categories: Set<string> }>();
  const walletAddresses = (a: AccountRow): string[] => {
    const out: string[] = [];
    for (const xpub of [a.xpubReceive, a.xpubChange]) {
      for (let i = 0; i < WALLET_ADDRESS_COUNT; i++) {
        const lock = p2pkhForXpub(xpub, i);
        const addr = lock && addressFor(lock);
        if (addr) out.push(addr);
      }
    }
    return out;
  };

  app.get("/me/loans", async (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    const s = reader.current();
    if (!s) return notReady(c);
    const t = now().getTime();
    let cached = mintingCache.get(a.id);
    if (!cached || t - cached.at >= WALLET_CACHE_MS) {
      let utxos;
      try {
        utxos = await chain.getUtxos(walletAddresses(a));
      } catch (e) {
        return chainDown(c, e);
      }
      const categories = new Set<string>();
      for (const u of utxos) if (u.token?.nft?.capability === "minting") categories.add(u.token.category);
      for (const [k, v] of mintingCache) if (t - v.at >= WALLET_CACHE_MS) mintingCache.delete(k);
      cached = { at: t, categories };
      mintingCache.set(a.id, cached);
    }
    const mine = cached.categories;
    return c.json(s.loans.filter((l) => mine.has(l.id)));
  });

  app.get("/utxos", async (c) => {
    const raw = c.req.query("addresses") ?? "";
    const addresses = raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    if (addresses.length === 0) return badRequest(c, "addresses is required");
    if (addresses.length > MAX_UTXO_ADDRESSES) return badRequest(c, `At most ${MAX_UTXO_ADDRESSES} addresses`);
    for (const a of addresses) {
      const d = a.startsWith("bitcoincash:") ? decodeCashAddress(a) : "missing prefix";
      if (typeof d === "string" || d.prefix !== "bitcoincash") return badRequest(c, "Invalid bitcoincash: address");
    }
    try {
      return c.json(await chain.getUtxos(addresses));
    } catch (e) {
      return chainDown(c, e);
    }
  });

  return app;
}
