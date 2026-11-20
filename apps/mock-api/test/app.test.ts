import { describe, expect, it } from "vitest";
import type { Invoice, LoansResponse, LoanView, MeResponse, Watch } from "@redline/api-types";
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
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call("/api/watches")).json()) as Watch[]).length).toBe(0);
  });

  it("logs out", async () => {
    const app = createApp();
    const call = await signIn(app);
    await call("/api/auth/logout", { method: "POST" });
    expect((await call("/api/me")).status).toBe(401);
  });
});
