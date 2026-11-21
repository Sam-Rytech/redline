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
  type LoanView,
  type MeResponse,
  type OkResponse,
  type VerifyRequest,
  type WatchRules,
} from "@redline/api-types";
import { summarize } from "@redline/paryon-decoder";
import {
  CHALLENGE_TTL_SECONDS,
  ChallengeError,
  createChallenge,
  p2pkhForXpub,
  verifyLogin,
} from "@redline/wizard-login/server";
import { checkAge } from "./age.js";
import type { ServerConfig } from "./config.js";
import { randomHex, sha256Hex, type Secrets } from "./crypto.js";
import {
  deleteAccount,
  deleteSession,
  getAccount,
  getChallenge,
  getSession,
  insertChallenge,
  insertSession,
  isTelegramLinked,
  markChallengeUsed,
  upsertAccount,
  type AccountRow,
} from "./db/auth.js";
import type { Db } from "./db/open.js";
import {
  DEFAULT_RULES,
  countWatches,
  deleteWatch,
  getWatch,
  insertWatch,
  listWatches,
  toWatch,
  updateWatchRules,
} from "./db/watches.js";
import { addressFor, type Chain } from "./electrum.js";
import type { ChainReader } from "./reader.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const STALE_MS = 5 * 60_000;
const CACHE_CONTROL = "public, max-age=15";

export const SESSION_COOKIE = "rl_session";
export const SESSION_SECONDS = 7 * 24 * 3600;
/** binds a sign-in challenge to the browser that asked for it; only sent to /api/auth */
export const CHALLENGE_COOKIE = "rl_ch";
const CHALLENGE_COOKIE_PATH = "/api/auth";
/** result of the age screen (signed) */
export const AGE_COOKIE = "rl_age";
const AGE_OK_SECONDS = 24 * 3600;
const AGE_BLOCKED_SECONDS = 365 * 24 * 3600;

const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 10_000;
/** per IP per minute (docs/SECURITY.md) */
export const LIMITS = { auth: 10, utxos: 30 } as const;
export const MAX_UTXO_ADDRESSES = 40;
const WALLET_ADDRESS_COUNT = 20;
const WALLET_CACHE_MS = 60_000;

const isToken = (t: string | undefined): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
const MAX_LOAN_ID_LENGTH = 128;
const RULE_KEYS = ["liquidation", "loanGone"] as const;

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

export interface AppDeps {
  reader: ChainReader;
  db: Db;
  chain: Chain;
  secrets: Secrets;
  config: Pick<ServerConfig, "loginDomain" | "publicOrigin" | "trustProxyHops"> & Partial<Pick<ServerConfig, "logXff">>;
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const { reader, db, chain, secrets, config } = deps;
  const now = deps.now ?? (() => new Date());
  const nowSec = () => Math.floor(now().getTime() / 1000);
  const app = new Hono().basePath("/api");

  app.notFound((c) => c.json(err("not_found", "No such route"), 404));
  app.onError((e, c) => {
    // the message only: no stack, no request data (it can hold signed transactions or keys)
    console.error(`request failed: ${e instanceof Error ? e.message : "unknown error"}`);
    return c.json(err("internal", "Internal error"), 500);
  });

  const notReady = (c: Context) => c.json(err("not_ready", "Loading chain data, try again in a few seconds"), 503);
  const badRequest = (c: Context, message: string) => c.json(err("bad_request", message), 400);
  const chainDown = (c: Context, e: unknown) => {
    console.error(`chain request failed: ${e instanceof Error ? e.message : String(e)}`);
    return c.json(err("chain_unavailable", "Could not reach the BCH network, try again"), 503);
  };
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax" as const };

  // ---------- rate limits: fixed one-minute window per IP and route group ----------
  const socketIp = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  /**
   * hops = 0: the TCP peer. hops = N: the Nth x-forwarded-for entry from the right (1 = the entry our
   * nearest proxy appended); entries further left are client-controlled.
   */
  const clientIp = (c: Context): string => {
    if (config.trustProxyHops > 0) {
      const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) return parts[Math.max(0, parts.length - config.trustProxyHops)]!;
    }
    return socketIp(c);
  };
  let xffLogged = 0;
  const limiter = (limit: number) => {
    let windowId = -1;
    const hits = new Map<string, number>();
    return async (c: Context, next: () => Promise<void>) => {
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
      if (n > limit) return c.json(err("rate_limited", "Too many requests, wait a minute and try again"), 429);
      await next();
    };
  };
  app.use("/auth/*", async (c, next) => {
    if (config.logXff && xffLogged < 5) {
      xffLogged++;
      console.log(`x-forwarded-for (${xffLogged}/5): ${c.req.header("x-forwarded-for") ?? "(none)"}`);
    }
    await next();
  });
  app.use("/auth/*", limiter(LIMITS.auth));
  app.use("/age-check", limiter(LIMITS.auth));
  app.use("/utxos", limiter(LIMITS.utxos));

  // ---------- state-changing requests: CSRF and size (docs/SECURITY.md) ----------
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(err("too_large", `Request body over ${MAX_BODY_BYTES / 1024} KB`), 413),
  });
  app.use("*", async (c, next) => {
    const method = c.req.method;
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE" && method !== "PUT") return next();
    if (c.req.header("origin") !== config.publicOrigin) {
      return c.json(err("forbidden_origin", "Request must come from the Redline site"), 403);
    }
    if (method !== "DELETE" && !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json(err("forbidden_origin", "Request body must be application/json"), 403);
    }
    return limitBody(c, next);
  });

  const readJson = async <T>(c: Context): Promise<T | null> => {
    try {
      const v: unknown = await c.req.json();
      return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
    } catch {
      return null;
    }
  };

  // ---------- sessions ----------
  interface WalletKeys {
    xpubReceive: string;
    xpubChange: string;
  }
  interface Signed {
    sessionId: string;
    account: AccountRow;
    keys: () => WalletKeys | null;
  }
  const signedIn = (c: Context): Signed | null => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!isToken(token)) return null;
    const sessionId = sha256Hex(token);
    const s = getSession(db, sessionId, nowSec());
    if (!s) return null;
    const account = getAccount(db, s.accountId);
    if (!account) return null;
    return {
      sessionId,
      account,
      keys: () => {
        const plain = secrets.open(s.keysEnc, sessionId);
        if (!plain) return null;
        try {
          return JSON.parse(plain) as WalletKeys;
        } catch {
          return null;
        }
      },
    };
  };
  const unauthorized = (c: Context) => c.json(err("unauthorized", "Sign in first"), 401);
  const meFor = (a: AccountRow): MeResponse => {
    const pro = a.proUntil !== null && a.proUntil > nowSec();
    return {
      accountId: a.id,
      pro,
      proUntil: a.proUntil === null ? null : new Date(a.proUntil * 1000).toISOString(),
      telegramLinked: isTelegramLinked(db, a.id),
      watchLimit: pro ? null : FREE_WATCH_LIMIT,
    };
  };

  // ---------- health and loans ----------
  app.get("/health", (c) => {
    const s = reader.current();
    const stale = !s || now().getTime() - new Date(s.updatedAt).getTime() > STALE_MS;
    return c.json({
      ok: true,
      blockHeight: s?.blockHeight ?? null,
      updatedAt: s?.updatedAt ?? null,
      stale,
      lastError: reader.lastError(),
      missingSidecars: s?.missingSidecars ?? null,
    });
  });

  app.get("/loans", (c) => {
    const s = reader.current();
    if (!s) return notReady(c);
    const ageMs = now().getTime() - new Date(s.updatedAt).getTime();
    const body: LoansResponse = {
      blockHeight: s.blockHeight,
      priceUsd: s.priceUsd,
      updatedAt: s.updatedAt,
      stale: ageMs > STALE_MS,
      dataAgeSeconds: Math.max(0, Math.floor(ageMs / 1000)),
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

  // ---------- age screen (docs/COMPLIANCE.md) ----------
  app.post("/age-check", async (c) => {
    if (secrets.readAge(getCookie(c, AGE_COOKIE)) === "blocked") {
      return c.json(err("age_blocked", "Redline is not available to you"), 403);
    }
    const body = await readJson<{ dateOfBirth?: unknown }>(c);
    const result = checkAge(body?.dateOfBirth, now());
    if (result === "invalid") return badRequest(c, "dateOfBirth must be a real past date as YYYY-MM-DD");
    setCookie(c, AGE_COOKIE, secrets.signAge(result), {
      ...cookieOpts,
      path: "/",
      maxAge: result === "ok" ? AGE_OK_SECONDS : AGE_BLOCKED_SECONDS,
    });
    if (result === "blocked") return c.json(err("age_blocked", "Redline is not available to you"), 403);
    return c.json({ ok: true } satisfies OkResponse);
  });

  // ---------- sign-in ----------
  app.post("/auth/challenge", async (c) => {
    const age = secrets.readAge(getCookie(c, AGE_COOKIE));
    if (age === "blocked") return c.json(err("age_blocked", "Redline is not available to you"), 403);
    if (age !== "ok") return c.json(err("age_required", "Confirm your date of birth before signing in"), 403);
    const body = await readJson<ChallengeRequest>(c);
    if (!body) return badRequest(c, "JSON object body required");
    try {
      const { challenge, browserId } = createChallenge(body, {
        domain: config.loginDomain,
        now: nowSec(),
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
      });
      insertChallenge(db, challenge);
      setCookie(c, CHALLENGE_COOKIE, browserId, { ...cookieOpts, path: CHALLENGE_COOKIE_PATH, maxAge: CHALLENGE_TTL_SECONDS });
      const res: ChallengeResponse = { nonce: challenge.nonceHex, expiry: challenge.expiry, domain: challenge.domain };
      return c.json(res);
    } catch (e) {
      if (e instanceof ChallengeError) return c.json(err(e.code, e.message), 400);
      throw e;
    }
  });

  app.post("/auth/verify", async (c) => {
    const browserId = getCookie(c, CHALLENGE_COOKIE) ?? null;
    // the challenge cookie is single-use: any verify attempt clears it
    deleteCookie(c, CHALLENGE_COOKIE, { path: CHALLENGE_COOKIE_PATH, secure: true });
    const body = await readJson<VerifyRequest>(c);
    if (!body) return badRequest(c, "JSON object body required");
    let result;
    try {
      result = await verifyLogin(body, {
        domain: config.loginDomain,
        browserId,
        now: nowSec,
        getChallenge: async (n) => getChallenge(db, n),
        markChallengeUsed: async (n, t) => markChallengeUsed(db, n, t),
        getSourceOutput: (op) => chain.getSourceOutput(op),
        isUnspentOrSpentBy: (op, txid) => chain.isUnspentOrSpentBy(op, txid),
      });
    } catch (e) {
      return chainDown(c, e);
    }
    if (!result.ok) {
      if (result.code === "challenge_mismatch") return c.json(err("challenge_mismatch", result.message), 403);
      if (result.code === "challenge_expired" || result.code === "challenge_used") {
        return c.json(err(result.code, result.message), 410);
      }
      return c.json(err("login_invalid", `${result.code}: ${result.message}`), 422);
    }
    const t = nowSec();
    upsertAccount(db, result.accountId, t);
    const token = randomHex(32);
    const sessionId = sha256Hex(token);
    const keys: WalletKeys = { xpubReceive: result.xpubReceive, xpubChange: result.xpubChange };
    insertSession(db, {
      id: sessionId,
      accountId: result.accountId,
      keysEnc: secrets.seal(JSON.stringify(keys), sessionId),
      createdAt: t,
      expiresAt: t + SESSION_SECONDS,
    });
    setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, path: "/", maxAge: SESSION_SECONDS });
    return c.json(meFor(getAccount(db, result.accountId)!));
  });

  app.post("/auth/logout", (c) => {
    const s = signedIn(c);
    if (s) deleteSession(db, s.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true } satisfies OkResponse);
  });

  // ---------- account ----------
  app.get("/me", (c) => {
    const s = signedIn(c);
    return s ? c.json(meFor(s.account)) : unauthorized(c);
  });

  app.delete("/me", (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    deleteAccount(db, s.account.id);
    walletCache.delete(s.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true } satisfies OkResponse);
  });

  // loans whose loan key (a minting NFT of the loan's category) is in the signed-in wallet
  const walletCache = new Map<string, { at: number; categories: Set<string> }>();
  app.get("/me/loans", async (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    const state = reader.current();
    if (!state) return notReady(c);
    const keys = s.keys();
    if (!keys) return unauthorized(c);
    let cached = walletCache.get(s.sessionId);
    if (!cached || now().getTime() - cached.at > WALLET_CACHE_MS) {
      const addresses: string[] = [];
      for (const xpub of [keys.xpubReceive, keys.xpubChange]) {
        for (let i = 0; i < WALLET_ADDRESS_COUNT; i++) {
          const lock = p2pkhForXpub(xpub, i);
          const a = lock ? addressFor(lock) : null;
          if (a) addresses.push(a);
        }
      }
      try {
        const utxos = await chain.getUtxos(addresses);
        const categories = new Set(
          utxos.filter((u) => u.token?.nft?.capability === "minting").map((u) => u.token!.category),
        );
        cached = { at: now().getTime(), categories };
        walletCache.set(s.sessionId, cached);
      } catch (e) {
        return chainDown(c, e);
      }
    }
    const mine: LoanView[] = state.loans.filter((l) => cached!.categories.has(l.id));
    return c.json(mine);
  });

  // ---------- watches ----------
  const isPro = (a: AccountRow) => a.proUntil !== null && a.proUntil > nowSec();

  app.get("/watches", (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    return c.json(listWatches(db, s.account.id).map(toWatch));
  });

  app.post("/watches", async (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    const body = await readJson<{ loanId?: unknown; rules?: unknown }>(c);
    if (!body) return badRequest(c, "JSON object body required");
    const { loanId } = body;
    if (typeof loanId !== "string" || loanId.length === 0 || loanId.length > MAX_LOAN_ID_LENGTH) {
      return badRequest(c, "loanId must be a loan id string");
    }
    const rules = parseRules(body.rules);
    if (!rules) return badRequest(c, "rules must be an object of booleans: liquidation, loanGone");
    const state = reader.current();
    if (!state) return notReady(c);
    if (!state.byId.has(loanId)) return c.json(err("not_found", "No such loan"), 404);
    if (listWatches(db, s.account.id).some((w) => w.loanId === loanId)) {
      return c.json(err("watch_exists", "You already watch this loan"), 409);
    }
    if (!isPro(s.account) && countWatches(db, s.account.id) >= FREE_WATCH_LIMIT) {
      return c.json(err("watch_limit", `The free plan watches ${FREE_WATCH_LIMIT} loan. The 30-day Pro pass watches any number.`), 403);
    }
    const id = randomHex(16);
    if (!insertWatch(db, { id, accountId: s.account.id, loanId, rules: { ...DEFAULT_RULES, ...rules }, createdAt: nowSec() })) {
      return c.json(err("watch_exists", "You already watch this loan"), 409);
    }
    return c.json(toWatch(getWatch(db, s.account.id, id)!), 201);
  });

  app.patch("/watches/:id", async (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    const w = getWatch(db, s.account.id, c.req.param("id"));
    if (!w) return c.json(err("not_found", "No such watch"), 404);
    const body = await readJson<{ rules?: unknown }>(c);
    if (!body) return badRequest(c, "JSON object body required");
    const rules = parseRules(body.rules);
    if (!rules) return badRequest(c, "rules must be an object of booleans: liquidation, loanGone");
    updateWatchRules(db, s.account.id, w.id, { ...w.rules, ...rules });
    return c.json(toWatch(getWatch(db, s.account.id, w.id)!));
  });

  app.delete("/watches/:id", (c) => {
    const s = signedIn(c);
    if (!s) return unauthorized(c);
    if (!deleteWatch(db, s.account.id, c.req.param("id"))) return c.json(err("not_found", "No such watch"), 404);
    return c.json({ ok: true } satisfies OkResponse);
  });

  // ---------- wallet coins (for picking the sign-in coin) ----------
  app.get("/utxos", async (c) => {
    const raw = c.req.query("addresses") ?? "";
    const addresses = raw.split(",").map((a) => a.trim()).filter(Boolean);
    if (addresses.length === 0) return badRequest(c, "addresses query parameter required");
    if (addresses.length > MAX_UTXO_ADDRESSES) return badRequest(c, `At most ${MAX_UTXO_ADDRESSES} addresses`);
    for (const a of addresses) {
      const d = a.startsWith("bitcoincash:") ? decodeCashAddress(a) : "missing prefix";
      if (typeof d === "string") return badRequest(c, `Not a mainnet cashaddr: ${a.slice(0, 64)}`);
    }
    try {
      return c.json(await chain.getUtxos(addresses));
    } catch (e) {
      return chainDown(c, e);
    }
  });

  return app;
}
