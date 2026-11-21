import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type {
  ApiError,
  ChallengeResponse,
  CreateInvoiceRequest,
  CreateWatchRequest,
  Invoice,
  InvoiceQuote,
  LoansResponse,
  TelegramLinkResponse,
  UpdateWatchRequest,
  Utxo,
  Watch,
} from "@redline/api-types";
import { PRO_PASS_DAYS, PRO_PASS_USD } from "@redline/api-types";
import { computeLoanViews, summarize } from "@redline/paryon-decoder";
import { MOCK_BLOCK_HEIGHT, MOCK_PRICE_USD, makeRawLoans } from "./fixtures.js";
import { SESSION_COOKIE, SESSION_VALUE, me, newState } from "./state.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const randHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const MERCHANT_ADDRESS = "bitcoincash:zmockmerchantaddressxxxxxxxxxxxxxxxxxxxxxxx";
const PROTECTED = ["/api/me", "/api/watches", "/api/telegram", "/api/invoices", "/api/mock"];
const proPassSats = () => Math.round((PRO_PASS_USD / MOCK_PRICE_USD) * 1e8);
const readJson = async <T>(c: Context): Promise<T | null> => {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
};
const badJson = (c: Context) => c.json(err("bad_request", "Valid JSON body required"), 400);
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const MAX_BODY_BYTES = 16 * 1024;

/** Same rule as the real server: 13 or older on today's UTC date. */
function ageResult(dob: unknown): "ok" | "blocked" | "invalid" {
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return "invalid";
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  const born = new Date(Date.UTC(y, m - 1, d));
  const today = new Date();
  if (born.getUTCDate() !== d || born.getUTCMonth() !== m - 1 || y < 1900 || born > today) return "invalid";
  const before = today.getUTCMonth() < m - 1 || (today.getUTCMonth() === m - 1 && today.getUTCDate() < d);
  return today.getUTCFullYear() - y - (before ? 1 : 0) >= 13 ? "ok" : "blocked";
}

export function createApp() {
  const state = newState();
  const loans = computeLoanViews(makeRawLoans(), MOCK_PRICE_USD);
  const app = new Hono().basePath("/api");

  const authed = (c: Context) => state.signedIn && getCookie(c, SESSION_COOKIE) === SESSION_VALUE;

  app.use("*", async (c, next) => {
    const p = c.req.path;
    const guarded = PROTECTED.some((x) => p === x || p.startsWith(x + "/"));
    if (guarded && !authed(c)) return c.json(err("unauthorized", "Sign in first"), 401);
    await next();
  });

  // Same request rules as the real server, except the Origin check (the mock runs behind any dev proxy).
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(err("too_large", "Request body over 16 KB"), 413),
  });
  app.use("*", async (c, next) => {
    const m = c.req.method;
    if (m !== "POST" && m !== "PATCH" && m !== "PUT") return next();
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json(err("forbidden_origin", "Request body must be application/json"), 403);
    }
    return limitBody(c, next);
  });

  app.notFound((c) => c.json(err("not_found", "No such route"), 404));
  app.onError((e, c) => {
    console.error(e);
    return c.json(err("internal", "Internal error"), 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- loans
  app.get("/loans", (c) => {
    const body: LoansResponse = {
      blockHeight: MOCK_BLOCK_HEIGHT,
      priceUsd: MOCK_PRICE_USD,
      updatedAt: new Date().toISOString(),
      stale: false,
      dataAgeSeconds: 0,
      summary: summarize(loans),
      loans,
    };
    return c.json(body);
  });
  app.get("/loans/:id", (c) => {
    const l = loans.find((x) => x.id === c.req.param("id"));
    return l ? c.json(l) : c.json(err("not_found", "No such loan"), 404);
  });

  // ---- age screen
  app.post("/age-check", async (c) => {
    if (getCookie(c, "rl_age") === "blocked") return c.json(err("age_blocked", "Redline is not available to you"), 403);
    const body = await readJson<{ dateOfBirth?: unknown }>(c);
    const r = ageResult(body?.dateOfBirth);
    if (r === "invalid") return c.json(err("bad_request", "dateOfBirth must be a real past date as YYYY-MM-DD"), 400);
    setCookie(c, "rl_age", r, { httpOnly: true, sameSite: "Lax", path: "/" });
    if (r === "blocked") return c.json(err("age_blocked", "Redline is not available to you"), 403);
    return c.json({ ok: true });
  });

  // ---- auth
  app.post("/auth/challenge", async (c) => {
    const age = getCookie(c, "rl_age");
    if (age === "blocked") return c.json(err("age_blocked", "Redline is not available to you"), 403);
    if (age !== "ok") return c.json(err("age_required", "Confirm your date of birth before signing in"), 403);
    if (!(await readJson(c))) return badJson(c);
    setCookie(c, "rl_ch", "mock-browser", { httpOnly: true, sameSite: "Lax", path: "/api/auth", maxAge: 300 });
    const body: ChallengeResponse = {
      nonce: randHex(16),
      expiry: Math.floor(Date.now() / 1000) + 300,
      domain: "localhost",
    };
    return c.json(body);
  });
  app.post("/auth/verify", async (c) => {
    const bound = getCookie(c, "rl_ch") === "mock-browser";
    deleteCookie(c, "rl_ch", { path: "/api/auth" });
    if (!bound) return c.json(err("challenge_mismatch", "Ask for a challenge from this browser first"), 403);
    const body = await readJson<{ signedTxHex?: string }>(c);
    if (!body) return badJson(c);
    const { signedTxHex } = body;
    if (!signedTxHex) return c.json(err("bad_request", "signedTxHex required"), 400);
    state.signedIn = true;
    setCookie(c, SESSION_COOKIE, SESSION_VALUE, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.json(me(state));
  });
  app.post("/auth/logout", (c) => {
    state.signedIn = false;
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/utxos", (c) => {
    const first = (c.req.query("addresses") ?? "").split(",")[0] ?? "";
    const utxos: Utxo[] = [
      { txid: "11".repeat(32), vout: 0, address: first, satoshis: 5_000, height: MOCK_BLOCK_HEIGHT - 3, token: null },
      { txid: "22".repeat(32), vout: 1, address: first, satoshis: 120_000, height: MOCK_BLOCK_HEIGHT - 10, token: null },
    ];
    return c.json(utxos);
  });

  // ---- me
  app.get("/me", (c) => c.json(me(state)));
  app.delete("/me", (c) => {
    const fresh = newState();
    Object.assign(state, fresh);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/me/loans", (c) => c.json(loans.slice(0, 3)));

  // ---- watches
  app.get("/watches", (c) => c.json(state.watches));
  app.post("/watches", async (c) => {
    const body = await readJson<CreateWatchRequest>(c);
    if (!body) return badJson(c);
    if (!loans.some((l) => l.id === body.loanId)) return c.json(err("not_found", "No such loan"), 404);
    if (state.watches.some((w) => w.loanId === body.loanId))
      return c.json(err("watch_exists", "Already watching this loan"), 409);
    const limit = me(state).watchLimit;
    if (limit !== null && state.watches.length >= limit)
      return c.json(err("watch_limit", "Free plan allows 1 watch. Get the 30-day Pro pass for more."), 403);
    const w: Watch = {
      id: String(state.nextId++),
      loanId: body.loanId,
      rules: { liquidation: true, loanGone: true, ...body.rules },
      lastBand: null,
      createdAt: new Date().toISOString(),
    };
    state.watches.push(w);
    return c.json(w, 201);
  });
  app.patch("/watches/:id", async (c) => {
    const w = state.watches.find((x) => x.id === c.req.param("id"));
    if (!w) return c.json(err("not_found", "No such watch"), 404);
    const body = await readJson<UpdateWatchRequest>(c);
    if (!body) return badJson(c);
    w.rules = { ...w.rules, ...body.rules };
    return c.json(w);
  });
  app.delete("/watches/:id", (c) => {
    const before = state.watches.length;
    state.watches = state.watches.filter((x) => x.id !== c.req.param("id"));
    return before === state.watches.length ? c.json(err("not_found", "No such watch"), 404) : c.json({ ok: true });
  });

  // ---- telegram
  app.post("/telegram/link-token", (c) => {
    const token = randHex(8);
    const body: TelegramLinkResponse = {
      token,
      url: `https://t.me/RedlineMockBot?start=${token}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    return c.json(body);
  });
  app.get("/mock/telegram-linked", (c) => {
    state.telegramLinked = true;
    return c.json(me(state));
  });

  // ---- invoices
  app.get("/invoices/quote", (c) => {
    const q: InvoiceQuote = {
      asset: "BCH",
      amountSats: proPassSats(),
      priceUsd: MOCK_PRICE_USD,
      merchantAddress: MERCHANT_ADDRESS,
      validUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    return c.json(q);
  });
  app.post("/invoices", async (c) => {
    const body = await readJson<CreateInvoiceRequest>(c);
    if (!body) return badJson(c);
    if (body.asset !== "BCH") return c.json(err("bad_request", "asset must be BCH"), 400);
    if (!Array.isArray(body.inputs) || body.inputs.length === 0)
      return c.json(err("bad_request", "inputs must be a non-empty array"), 400);
    const id = randHex(8);
    const inv: Invoice = {
      id,
      status: "open",
      asset: "BCH",
      amountSats: proPassSats(),
      merchantAddress: MERCHANT_ADDRESS,
      opReturnHex: toHex("PWINV") + id,
      inputs: body.inputs,
      txid: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
    };
    state.invoices.set(id, inv);
    return c.json(inv, 201);
  });
  app.get("/invoices/:id", (c) => {
    const inv = state.invoices.get(c.req.param("id"));
    return inv ? c.json(inv) : c.json(err("not_found", "No such invoice"), 404);
  });
  app.post("/invoices/:id/submit", (c) => {
    const inv = state.invoices.get(c.req.param("id"));
    if (!inv) return c.json(err("not_found", "No such invoice"), 404);
    if (inv.status !== "paid") {
      inv.status = "paid";
      inv.txid = randHex(32);
      inv.paidAt = new Date().toISOString();
      state.proUntil = new Date(Date.now() + PRO_PASS_DAYS * 86_400_000);
    }
    return c.json(inv);
  });

  return app;
}
