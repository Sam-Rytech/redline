import { describe, expect, it } from "vitest";
import type { Invoice, InvoiceQuote, LoansResponse, LoanView, MeResponse, Watch } from "@redline/api-types";
import { createApp } from "../src/app.js";

const JSON_HEADERS = { "content-type": "application/json" };
const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!.split(";")[0]!;

/** age check → challenge → verify, the same order as the real server */
async function signIn(app: ReturnType<typeof createApp>) {
  const age = await app.request("/api/age-check", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ dateOfBirth: "1990-05-04" }) });
  expect(age.status).toBe(200);
  const ch = await app.request("/api/auth/challenge", {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie: cookieOf(age, "rl_age") },
    body: JSON.stringify({ outpoint: { txid: "11".repeat(32), vout: 0 }, path: ["receive", 0] }),
  });
  expect(ch.status).toBe(200);
  const res = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie: cookieOf(ch, "rl_ch") },
    body: JSON.stringify({ signedTxHex: "00", xpubReceive: "xpub-mock", xpubChange: "xpub-mock-change" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res, "rl_session");
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
    expect((await call(`/api/watches/${w.id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call("/api/watches")).json()) as Watch[]).length).toBe(0);
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

  it("matches the real server's request rules: JSON only, 16 KB, age before challenge, challenge before verify", async () => {
    const app = createApp();
    const codeOf = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
    const plain = await app.request("/api/age-check", { method: "POST", body: "dateOfBirth=1990-01-01", headers: { "content-type": "text/plain" } });
    expect(plain.status).toBe(403);
    expect(await codeOf(plain)).toBe("forbidden_origin");
    const big = await app.request("/api/age-check", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ pad: "x".repeat(17 * 1024) }) });
    expect(big.status).toBe(413);
    const noAge = await app.request("/api/auth/challenge", { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(await codeOf(noAge)).toBe("age_required");
    const young = await app.request("/api/age-check", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ dateOfBirth: "2020-01-01" }) });
    expect(young.status).toBe(403);
    expect(await codeOf(young)).toBe("age_blocked");
    const again = await app.request("/api/age-check", {
      method: "POST", headers: { ...JSON_HEADERS, cookie: cookieOf(young, "rl_age") }, body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
    expect(await codeOf(again)).toBe("age_blocked");
    const unbound = await app.request("/api/auth/verify", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ signedTxHex: "00" }) });
    expect(unbound.status).toBe(403);
    expect(await codeOf(unbound)).toBe("challenge_mismatch");
  });

  it("DELETE /api/me signs out and resets the account", async () => {
    const app = createApp();
    const call = await signIn(app);
    const del = await call("/api/me", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await call("/api/me")).status).toBe(401);
  });

  it("maps malformed JSON to 400 and unknown paths to 404", async () => {
    const app = createApp();
    const res = await app.request("/api/age-check", { method: "POST", headers: JSON_HEADERS, body: "not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    const nope = await app.request("/api/nope");
    expect(nope.status).toBe(404);
    expect(((await nope.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
