import { randomBytes } from "node:crypto";
import { decodeCashAddress } from "@bitauth/libauth";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  FREE_WATCH_LIMIT,
  type ApiError,
  type ChallengeRequest,
  type ChallengeResponse,
  type LoansResponse,
  type MeResponse,
  type OkResponse,
  type TelegramLinkResponse,
  type Watch,
  type WatchRules,
} from "@redline/api-types";
import { summarize } from "@redline/paryon-decoder";
import {
  CHALLENGE_TTL_SECONDS,
  ChallengeError,
  createChallenge,
  p2pkhForXpub,
  verifyLogin,
  type VerifyDeps,
} from "@redline/wizard-login/server";
import type { ServerConfig } from "./config.js";
import type { AccountRow, Db, WatchRow } from "./db.js";
import { addressFor, type Chain } from "./electrum.js";
import type { ChainReader } from "./reader.js";
import { tokenHash } from "./tokens.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const STALE_MS = 5 * 60_000;
const CACHE_CONTROL = "public, max-age=15";

export const SESSION_COOKIE = "rl_session";
export const SESSION_SECONDS = 7 * 24 * 3600;
/** binds a challenge to the browser that requested it; only sent to /api/auth */
export const CHALLENGE_COOKIE = "rl_chal";
const CHALLENGE_COOKIE_PATH = "/api/auth";
const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_MAX_KEYS = 10_000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_UTXO_ADDRESSES = 60;
const WALLET_ADDRESS_COUNT = 20;
const WALLET_CACHE_MS = 60_000;
export const LINK_TOKEN_SECONDS = 10 * 60;
const MAX_LOAN_ID_LENGTH = 128;
const RULE_KEYS = ["liquidation", "loanGone"] as const;

const sessionKey = tokenHash;

/** undefined → {}; an object of optional booleans → those; anything else → null */
function parseRules(v: unknown): Partial<WatchRules> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Partial<WatchRules> = {};
  for (const k of RULE_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (typeof x !== "boolean") return null;
    out[k] = x;
  }
  return out;
}

const toWatch = (w: WatchRow): Watch => ({
  id: w.id,
  loanId: w.loanId,
  rules: w.rules,
  // "gone" is internal bookkeeping; the API only knows risk bands
  lastBand: w.lastBand === "gone" ? null : w.lastBand,
  createdAt: new Date(w.createdAt * 1000).toISOString(),
});
const isSessionToken = (t: string | undefined): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

export interface AppDeps {
  reader: ChainReader;
  db: Db;
  chain: Chain;
  config: Pick<ServerConfig, "loginDomain" | "secureCookies" | "trustProxyHops" | "publicOrigin"> &
    Partial<Pick<ServerConfig, "logXff">>;
  now?: () => Date;
  /** the Telegram bot's username (no @); undefined while unknown or when no bot is configured */
  botUsername?: () => string | undefined;
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
  const socketIp = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown"; // not running under @hono/node-server
    }
  };
  /**
   * hops=0: the TCP peer. hops=N: the Nth x-forwarded-for entry from the right (1 = the one our
   * nearest proxy appended); everything left of that is client-controlled. A header with fewer
   * than N entries falls back to its left-most entry.
   */
  const clientIp = (c: Context): string => {
    if (config.trustProxyHops > 0) {
      const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts[Math.max(0, parts.length - config.trustProxyHops)]!;
    }
    return socketIp(c);
  };
  // LOG_XFF=1: diagnostic to find the real header chain on staging; never more than 5 lines
  let xffLogged = 0;
  app.use("/auth/*", async (c, next) => {
    if (config.logXff && xffLogged < 5) {
      xffLogged++;
      console.log(`x-forwarded-for (${xffLogged}/5): ${c.req.header("x-forwarded-for") ?? "(none)"}`);
    }
    await next();
  });
  const rateLimit = async (c: Context, next: () => Promise<void>) => {
    const w = Math.floor(now().getTime() / RATE_WINDOW_MS);
    if (w !== windowId) {
      windowId = w;
      hits.clear();
    }
    const ip = clientIp(c);
    if (!hits.has(ip) && hits.size >= RATE_LIMIT_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    if (n > RATE_LIMIT) return c.json(err("rate_limited", "Too many requests, slow down"), 429);
    await next();
  };
  app.use("/auth/*", rateLimit);
  app.use("/utxos", rateLimit);

  // ---------- POST hardening (CSRF + size) ----------
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(err("too_large", `Request body over ${MAX_BODY_BYTES} bytes`), 413),
  });
  app.use("*", async (c, next) => {
    const method = c.req.method;
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE") return next();
    if (config.publicOrigin && c.req.header("origin") !== config.publicOrigin) {
      return c.json(err("bad_origin", "Cross-origin request refused"), 403);
    }
    if (method === "DELETE") return next();
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return c.json(err("bad_content_type", "Send Content-Type: application/json"), 415);
    return limitBody(c, next);
  });

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
      telegramLinked: db.getTelegramChat(a.id) !== null,
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
    let made;
    try {
      made = createChallenge(body as unknown as ChallengeRequest, {
        domain: config.loginDomain,
        now: t,
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
      });
    } catch (e) {
      if (e instanceof ChallengeError) return c.json(err(e.code, e.message), 400);
      throw e;
    }
    const ch = made.challenge;
    db.purgeExpired(t);
    db.insertChallenge(ch);
    setCookie(c, CHALLENGE_COOKIE, made.bindingToken, {
      httpOnly: true,
      sameSite: "Lax",
      path: CHALLENGE_COOKIE_PATH,
      maxAge: CHALLENGE_TTL_SECONDS,
      ...(config.secureCookies && { secure: true }),
    });
    const res: ChallengeResponse = { nonce: ch.nonceHex, expiry: ch.expiry, domain: ch.domain };
    return c.json(res);
  });

  app.post("/auth/verify", async (c) => {
    const body = await readJson(c);
    const hex = body?.signedTxHex;
    if (typeof hex !== "string" || hex.length === 0 || hex.length > 20_000) {
      return badRequest(c, "Expected { signedTxHex }");
    }
    const binding = getCookie(c, CHALLENGE_COOKIE);
    // one attempt per challenge cookie: clear it whatever the outcome
    deleteCookie(c, CHALLENGE_COOKIE, { path: CHALLENGE_COOKIE_PATH, httpOnly: true, sameSite: "Lax", ...(config.secureCookies && { secure: true }) });
    const vdeps: VerifyDeps = {
      domain: config.loginDomain,
      bindingToken: binding ?? null,
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

  // ---------- watches ----------
  const isPro = (a: AccountRow) => a.proUntil !== null && a.proUntil > nowSec();
  const noWatch = (c: Context) => c.json(err("not_found", "No such watch"), 404);

  app.get("/watches", (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    return c.json(db.listWatches(a.id).map(toWatch));
  });

  app.post("/watches", async (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    const body = await readJson(c);
    const loanId = body?.loanId;
    const rules = parseRules(body?.rules);
    if (typeof loanId !== "string" || loanId.length === 0 || loanId.length > MAX_LOAN_ID_LENGTH || !rules) {
      return badRequest(c, "Expected { loanId, rules? } with boolean rules");
    }
    const s = reader.current();
    if (!s) return notReady(c);
    if (!s.byId.has(loanId)) return c.json(err("not_found", "No such loan"), 404);
    if (db.listWatches(a.id).some((w) => w.loanId === loanId)) {
      return c.json(err("watch_exists", "Already watching this loan"), 409);
    }
    if (!isPro(a) && db.countWatches(a.id) >= FREE_WATCH_LIMIT) {
      return c.json(err("watch_limit", "Free plan allows 1 watch. Get the 30-day Pro pass for more."), 403);
    }
    const id = randomBytes(8).toString("hex");
    if (!db.insertWatch({ id, accountId: a.id, loanId, rules: { liquidation: true, loanGone: true, ...rules }, createdAt: nowSec() })) {
      return c.json(err("watch_exists", "Already watching this loan"), 409);
    }
    const row = db.getWatch(id);
    if (!row) throw new Error("watch vanished after insert");
    return c.json(toWatch(row), 201);
  });

  app.patch("/watches/:id", async (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    const w = db.getWatch(c.req.param("id"));
    if (!w || w.accountId !== a.id) return noWatch(c);
    const body = await readJson(c);
    // missing rules = no-op (same as the mock); present rules must be booleans
    const rules = body ? parseRules(body.rules) : null;
    if (!rules) return badRequest(c, "Expected { rules } with boolean rules");
    db.updateWatchRules(w.id, a.id, { ...w.rules, ...rules });
    const row = db.getWatch(w.id);
    return row ? c.json(toWatch(row)) : noWatch(c);
  });

  app.delete("/watches/:id", (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    if (!db.deleteWatch(c.req.param("id"), a.id)) return noWatch(c);
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  // ---------- telegram ----------
  app.post("/telegram/link-token", (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    const bot = deps.botUsername?.();
    if (!bot) return c.json(err("telegram_unavailable", "Telegram alerts are not configured on this server"), 503);
    const t = nowSec();
    // 16 random bytes → 22 base64url chars, inside Telegram's start-payload alphabet [A-Za-z0-9_-]{1,64}
    const token = randomBytes(16).toString("base64url");
    db.purgeExpired(t);
    db.insertLinkToken(tokenHash(token), a.id, t, t + LINK_TOKEN_SECONDS);
    const res: TelegramLinkResponse = {
      token,
      url: `https://t.me/${encodeURIComponent(bot)}?start=${token}`,
      expiresAt: new Date((t + LINK_TOKEN_SECONDS) * 1000).toISOString(),
    };
    return c.json(res);
  });

  app.post("/telegram/unlink", (c) => {
    const a = sessionAccount(c);
    if (!a) return unauthorized(c);
    db.unlinkTelegram(a.id);
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  return app;
}
