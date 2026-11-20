import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type {
  ApiError,
  ChallengeResponse,
  CreateInvoiceRequest,
  CreateWatchRequest,
  Invoice,
  LoansResponse,
  TelegramLinkResponse,
  UpdateWatchRequest,
  Utxo,
  Watch,
} from "@redline/api-types";
import { computeLoanViews } from "@redline/paryon-decoder";
import { MOCK_BLOCK_HEIGHT, MOCK_PRICE_USD, makeRawLoans } from "./fixtures.js";
import { SESSION_COOKIE, SESSION_VALUE, me, newState } from "./state.js";

const err = (code: string, message: string): ApiError => ({ error: { code, message } });
const randHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");

export function createApp() {
  const state = newState();
  const loans = computeLoanViews(makeRawLoans(), MOCK_PRICE_USD);
  const app = new Hono().basePath("/api");

  const authed = (c: Context) => state.signedIn && getCookie(c, SESSION_COOKIE) === SESSION_VALUE;

  app.use("*", async (c, next) => {
    const p = c.req.path;
    const open = p === "/api/health" || p.startsWith("/api/loans") || p.startsWith("/api/auth") || p === "/api/utxos";
    if (!open && !authed(c)) return c.json(err("unauthorized", "Sign in first"), 401);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- loans
  app.get("/loans", (c) => {
    const body: LoansResponse = {
      blockHeight: MOCK_BLOCK_HEIGHT,
      priceUsd: MOCK_PRICE_USD,
      updatedAt: new Date().toISOString(),
      summary: {
        total: loans.length,
        within20pct: loans.filter((l) => l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2).length,
        totalCollateralBch: loans.reduce((a, l) => a + l.collateralBch, 0),
        totalDebtPusd: loans.reduce((a, l) => a + l.debtPusd, 0),
      },
      loans,
    };
    return c.json(body);
  });
  app.get("/loans/:id", (c) => {
    const l = loans.find((x) => x.id === c.req.param("id"));
    return l ? c.json(l) : c.json(err("not_found", "No such loan"), 404);
  });

  // ---- auth
  app.post("/auth/challenge", (c) => {
    const body: ChallengeResponse = {
      nonce: randHex(16),
      expiry: Math.floor(Date.now() / 1000) + 300,
      domain: "localhost",
    };
    return c.json(body);
  });
  app.post("/auth/verify", async (c) => {
    const { signedTxHex } = await c.req.json<{ signedTxHex?: string }>();
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
  app.get("/me/loans", (c) => c.json(loans.slice(0, 3)));

  // ---- watches
  app.get("/watches", (c) => c.json(state.watches));
  app.post("/watches", async (c) => {
    const body = await c.req.json<CreateWatchRequest>();
    if (!loans.some((l) => l.id === body.loanId)) return c.json(err("not_found", "No such loan"), 404);
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
    const body = await c.req.json<UpdateWatchRequest>();
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
  app.post("/invoices", async (c) => {
    const body = await c.req.json<CreateInvoiceRequest>();
    const id = randHex(8);
    const inv: Invoice = {
      id,
      status: "open",
      asset: "BCH",
      amountSats: Math.round((0.25 / MOCK_PRICE_USD) * 1e8),
      merchantAddress: "bitcoincash:zmockmerchantaddressxxxxxxxxxxxxxxxxxxxxxxx",
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
      state.proUntil = new Date(Date.now() + 30 * 86_400_000);
    }
    return c.json(inv);
  });

  return app;
}
