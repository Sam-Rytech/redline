import { describe, expect, it } from "vitest";
import type { Invoice, InvoiceQuote, LoansResponse, LoanView, MeResponse, Watch } from "@redline/api-types";
import { createApp } from "../src/app.js";

async function signIn(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTxHex: "00" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
    });
}

describe("mock api", () => {
  it("serves realistic loans with every risk band", async () => {
    const app = createApp();
    const body = (await (await app.request("/api/loans")).json()) as LoansResponse;
    expect(body.loans.length).toBe(40);
    const bands = new Set(body.loans.map((l) => l.risk));
    expect([...bands].sort()).toEqual(["critical", "danger", "safe", "watch"]);
    expect(body.loans.some((l) => l.stranded)).toBe(true);
    expect(body.loans.some((l) => l.redemptionInProgress)).toBe(true);
    expect(body.summary.within20pct).toBe(
      body.loans.filter((l) => l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2).length,
    );
    const stranded = body.loans.filter((l) => l.stranded);
    expect(body.summary.strandedCount).toBe(stranded.length);
    expect(body.summary.strandedCount).toBeGreaterThan(0);
    expect(body.summary.strandedBch).toBeCloseTo(stranded.reduce((a, l) => a + l.collateralBch, 0), 8);
  });

  it("returns one loan or 404", async () => {
    const app = createApp();
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const one = (await (await app.request(`/api/loans/${loans[5]!.id}`)).json()) as LoanView;
    expect(one.id).toBe(loans[5]!.id);
    expect((await app.request("/api/loans/nope")).status).toBe(404);
  });

  it("requires sign-in for /me", async () => {
    const app = createApp();
    expect((await app.request("/api/me")).status).toBe(401);
    const call = await signIn(app);
    const me = (await (await call("/api/me")).json()) as MeResponse;
    expect(me.pro).toBe(false);
    expect(me.watchLimit).toBe(1);
    const mine = (await (await call("/api/me/loans")).json()) as LoanView[];
    expect(mine.map((l) => l.risk).slice(0, 2)).toEqual(["critical", "watch"]);
    expect(mine[2]!.stranded).toBe(true);
  });

  it("enforces the free watch limit until Pro is paid", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const w1 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[0]!.id }) });
    expect(w1.status).toBe(201);
    const w2 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[1]!.id }) });
    expect(w2.status).toBe(403);
    expect(((await w2.json()) as { error: { code: string } }).error.code).toBe("watch_limit");

    const inv = (await (
      await call("/api/invoices", {
        method: "POST",
        body: JSON.stringify({ asset: "BCH", inputs: [{ txid: "ab".repeat(32), vout: 0 }] }),
      })
    ).json()) as Invoice;
    expect(inv.status).toBe("open");
    const paid = (await (
      await call(`/api/invoices/${inv.id}/submit`, { method: "POST", body: JSON.stringify({ signedTxHex: "00" }) })
    ).json()) as Invoice;
    expect(paid.status).toBe("paid");
    const again = (await (
      await call(`/api/invoices/${inv.id}/submit`, { method: "POST", body: JSON.stringify({ signedTxHex: "00" }) })
    ).json()) as Invoice;
    expect(again.txid).toBe(paid.txid);

    const me = (await (await call("/api/me")).json()) as MeResponse;
    expect(me.pro).toBe(true);
    expect(me.watchLimit).toBeNull();
    const w3 = await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[1]!.id }) });
    expect(w3.status).toBe(201);
  });

  it("updates and deletes watches", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const w = (await (
      await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[0]!.id }) })
    ).json()) as Watch;
    expect(w.rules).toEqual({ liquidation: true, loanGone: true });
    const p = (await (
      await call(`/api/watches/${w.id}`, { method: "PATCH", body: JSON.stringify({ rules: { loanGone: false } }) })
    ).json()) as Watch;
    expect(p.rules).toEqual({ liquidation: true, loanGone: false });
    // PATCH {} is a no-op, same as the real server
    const noop = await call(`/api/watches/${w.id}`, { method: "PATCH", body: "{}" });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as Watch).rules).toEqual({ liquidation: true, loanGone: false });
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call("/api/watches")).json()) as Watch[]).length).toBe(0);
  });

  it("links and unlinks Telegram", async () => {
    const app = createApp();
    expect((await app.request("/api/telegram/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const call = await signIn(app);
    await call("/api/mock/telegram-linked");
    expect(((await (await call("/api/me")).json()) as MeResponse).telegramLinked).toBe(true);
    const r = await call("/api/telegram/unlink", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(((await (await call("/api/me")).json()) as MeResponse).telegramLinked).toBe(false);
  });

  it("PATCH without JSON content type is 415, like the real server", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const w = (await (await call("/api/watches", { method: "POST", body: JSON.stringify({ loanId: loans[0]!.id }) })).json()) as Watch;
    const r = await call(`/api/watches/${w.id}`, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  });

  it("logs out", async () => {
    const app = createApp();
    const call = await signIn(app);
    await call("/api/auth/logout", { method: "POST" });
    expect((await call("/api/me")).status).toBe(401);
  });

  it("quotes the pro pass and validates invoice input", async () => {
    const app = createApp();
    expect((await app.request("/api/invoices/quote")).status).toBe(401);
    const call = await signIn(app);
    const q = (await (await call("/api/invoices/quote")).json()) as InvoiceQuote;
    expect(q.asset).toBe("BCH");
    const inv = (await (
      await call("/api/invoices", {
        method: "POST",
        body: JSON.stringify({ asset: "BCH", inputs: [{ txid: "ab".repeat(32), vout: 0 }] }),
      })
    ).json()) as Invoice;
    expect(inv.amountSats).toBe(q.amountSats);
    expect(inv.merchantAddress).toBe(q.merchantAddress);
    const empty = await call("/api/invoices", { method: "POST", body: JSON.stringify({ asset: "BCH", inputs: [] }) });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    const wrong = await call("/api/invoices", {
      method: "POST",
      body: JSON.stringify({ asset: "PUSD", inputs: [{ txid: "ab".repeat(32), vout: 0 }] }),
    });
    expect(wrong.status).toBe(400);
  });

  it("rejects a duplicate watch on the same loan", async () => {
    const app = createApp();
    const call = await signIn(app);
    const { loans } = (await (await app.request("/api/loans")).json()) as LoansResponse;
    const body = JSON.stringify({ loanId: loans[0]!.id });
    expect((await call("/api/watches", { method: "POST", body })).status).toBe(201);
    const dup = await call("/api/watches", { method: "POST", body });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("watch_exists");
  });

  it("rejects every POST without Content-Type: application/json (415), like the real server", async () => {
    const app = createApp();
    const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    for (const headers of [undefined, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }]) {
      const res = await app.request("/api/auth/verify", { method: "POST", headers, body: JSON.stringify({ signedTxHex: "00" }) });
      expect(res.status).toBe(415);
      expect(await code(res)).toBe("bad_content_type");
    }
    // logout too (bodyless fetch has no content type), and before the auth check
    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(415);
    expect((await app.request("/api/watches", { method: "POST", body: "{}" })).status).toBe(415);
    // charset parameter is fine; JSON body `{}` on logout is fine
    const ok = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });
    expect(ok.status).toBe(200);
  });

  it("maps malformed JSON to 400 and unknown paths to 404", async () => {
    const app = createApp();
    const res = await app.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    const nope = await app.request("/api/nope");
    expect(nope.status).toBe(404);
    expect(((await nope.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
