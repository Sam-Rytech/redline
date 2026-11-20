import { randomBytes } from "node:crypto";
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hashTransaction, hexToBin, sha256, utf8ToBin, type TransactionCommon } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { ApiError, Invoice, InvoiceQuote, MeResponse, Outpoint } from "@redline/api-types";
import { encodeInvoiceOpReturn, estimatePaymentFee, invoiceOpReturnHex } from "@redline/wizard-login";
import { makeWallet, signP2pkhInputs } from "@redline/wizard-login/testing";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { openDb } from "../src/db.js";
import { classifyBroadcastError } from "../src/invoices.js";
import type { ChainReader, LoanState } from "../src/reader.js";
import { fakePaymentChain } from "./fake-payment-chain.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const DAY = 86_400;
const MERCHANT = "bitcoincash:zq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygyzxn9ta6";
const MERCHANT_LOCK = (() => {
  const r = cashAddressToLockingBytecode(MERCHANT);
  if (typeof r === "string") throw new Error(r);
  return r.bytecode;
})();
const PRICE = 400; // → 62,500 sats
const AMOUNT = 62_500;

const wallet = makeWallet(3);
const stranger = makeWallet(4);
type Path = ["receive" | "change", number];

const state = (price = PRICE): LoanState => ({ blockHeight: 1, priceUsd: price, updatedAt: NOW.toISOString(), loans: [], byId: new Map() });
const hash = (t: string) => binToHex(sha256.hash(utf8ToBin(t)));
const txid = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

function setup(o: { merchant?: string | null; state?: LoanState | null; proUntil?: number | null } = {}) {
  const db = openDb(":memory:");
  const fake = fakePaymentChain();
  let current = o.state === undefined ? state() : o.state;
  let now = NOW;
  const sleeps: number[] = [];
  const reader: ChainReader = { current: () => current, lastError: () => null, refresh: async () => {}, start() {}, stop() {}, onUpdate() {} };
  const merchant = o.merchant === undefined ? MERCHANT : o.merchant;
  const app = createApp({
    reader,
    db,
    chain: { getSourceOutput: async () => null, isUnspentOrSpentBy: async () => false, getUtxos: async () => [] },
    config: { loginDomain: "redline.test", secureCookies: false, trustProxyHops: 0, logXff: false, publicOrigin: undefined },
    now: () => now,
    ...(merchant && { payments: { merchantAddress: merchant, chain: fake.chain, sleep: async (ms: number) => void sleeps.push(ms) } }),
  });

  // coins: who owns them and at which path (for signing)
  const owner = new Map<string, { w: typeof wallet; path: Path }>();
  const coin = (n: number, vout: number, w: typeof wallet, path: Path, sats: number, token = false): Outpoint => {
    const op = { txid: txid(n), vout };
    fake.addCoin(op, w.lockingBytecode(path[0], path[1]), BigInt(sats), token ? { category: hexToBin("cc".repeat(32)), amount: 5n } : undefined);
    owner.set(`${op.txid}:${op.vout}`, { w, path });
    return op;
  };
  const C = {
    r3: coin(1, 0, wallet, ["receive", 3], 50_000),
    c1: coin(1, 1, wallet, ["change", 1], 30_000),
    r2token: coin(1, 2, wallet, ["receive", 2], 100_000, true),
    stranger: coin(2, 0, stranger, ["receive", 0], 100_000),
    r25: coin(1, 3, wallet, ["receive", 25], 100_000),
    small: coin(1, 4, wallet, ["receive", 4], 1_000),
    big: coin(1, 5, wallet, ["receive", 19], 200_000),
  };

  const user = (accountId: string, w = wallet, proUntil: number | null = o.proUntil ?? null) => {
    db.upsertAccount({ id: accountId, xpubReceive: w.xpubReceive, xpubChange: w.xpubChange, now: NOW_S });
    db.setProUntil(accountId, proUntil);
    const token = randomBytes(32).toString("hex");
    db.createSession(hash(token), accountId, NOW_S + 365 * DAY);
    return async (path: string, json?: unknown) => {
      const res = await app.request(path, {
        method: json === undefined ? "GET" : "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(json !== undefined && { "content-type": "application/json" }) },
        ...(json !== undefined && { body: JSON.stringify(json) }),
      });
      const text = await res.text();
      return { status: res.status, json: <T>() => JSON.parse(text) as T, code: () => (JSON.parse(text) as ApiError).error?.code, text };
    };
  };

  /** a payment tx for `inv`, signed by the coins' owners; overrides make it wrong in one way */
  const payTx = (
    inv: Invoice,
    x: { inputs?: Outpoint[]; value?: number; lock?: Uint8Array; opReturns?: Uint8Array[]; change?: number; tokenOut?: boolean } = {},
  ) => {
    const inputs = x.inputs ?? inv.inputs;
    const unsigned: TransactionCommon = {
      version: 2,
      locktime: 0,
      inputs: inputs.map((i) => ({ outpointTransactionHash: hexToBin(i.txid), outpointIndex: i.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })),
      outputs: [
        { lockingBytecode: x.lock ?? MERCHANT_LOCK, valueSatoshis: BigInt(x.value ?? inv.amountSats) },
        ...(x.opReturns ?? [encodeInvoiceOpReturn(inv.id)]).map((b) => ({ lockingBytecode: b, valueSatoshis: 0n })),
        {
          lockingBytecode: wallet.lockingBytecode("change", 0),
          valueSatoshis: BigInt(x.change ?? 10_000),
          ...(x.tokenOut && { token: { category: hexToBin("dd".repeat(32)), amount: 1n } }),
        },
      ],
    };
    const own = inputs.map((i) => owner.get(`${i.txid}:${i.vout}`)!);
    const sources = inputs.map((i) => fake.coins.get(`${i.txid}:${i.vout}`)!.output as { lockingBytecode: Uint8Array; valueSatoshis: bigint });
    const signed = signP2pkhInputs(unsigned, sources, own.map((x) => x.w.privateKey(x.path[0], x.path[1])));
    const bin = encodeTransaction(signed);
    return { hex: binToHex(bin), bin, txid: hashTransaction(bin) };
  };

  return { app, db, fake, C, user, payTx, sleeps, setState: (s: LoanState | null) => (current = s), setNow: (d: Date) => (now = d) };
}

const create = (call: Awaited<ReturnType<ReturnType<typeof setup>["user"]>>, inputs: Outpoint[]) => call("/api/invoices", { asset: "BCH", inputs });

describe("invoice routes", () => {
  it("401 without a session; 503 payments_unavailable without MERCHANT_ADDRESS", async () => {
    const s = setup();
    for (const [method, path] of [["GET", "/api/invoices/quote"], ["POST", "/api/invoices"], ["GET", "/api/invoices/x"], ["POST", "/api/invoices/x/submit"]] as const) {
      const res = await s.app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" && { body: "{}" }) });
      expect(res.status, path).toBe(401);
    }
    const n = setup({ merchant: null });
    const call = n.user("acc");
    for (const r of [await call("/api/invoices/quote"), await create(call, [n.C.r3]), await call("/api/invoices/x"), await call("/api/invoices/x/submit", { signedTxHex: "00" })]) {
      expect(r.status).toBe(503);
      expect(r.code()).toBe("payments_unavailable");
    }
  });

  it("quote: ceil(0.25 / price × 1e8) at the reader's price, valid 5 minutes; 503 not_ready without state", async () => {
    const s = setup({ state: state(300) });
    const call = s.user("acc");
    const q = (await call("/api/invoices/quote")).json<InvoiceQuote>();
    expect(q).toEqual<InvoiceQuote>({
      asset: "BCH",
      amountSats: 83_334,
      priceUsd: 300,
      merchantAddress: MERCHANT,
      validUntil: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    });
    s.setState(null);
    const r = await call("/api/invoices/quote");
    expect(r.status).toBe(503);
    expect(r.code()).toBe("not_ready");
    expect((await create(call, [s.C.big])).code()).toBe("not_ready");
  });

  it("create: validates and fixes the amount; Invoice shape", async () => {
    const s = setup();
    const call = s.user("acc");
    const r = await create(call, [s.C.r3, s.C.c1]);
    expect(r.status).toBe(201);
    const inv = r.json<Invoice>();
    expect(inv.id).toMatch(/^[0-9a-f]{32}$/);
    expect(inv).toEqual<Invoice>({
      id: inv.id,
      status: "open",
      asset: "BCH",
      amountSats: AMOUNT,
      merchantAddress: MERCHANT,
      opReturnHex: invoiceOpReturnHex(inv.id),
      inputs: [s.C.r3, s.C.c1],
      txid: null,
      createdAt: NOW.toISOString(),
      paidAt: null,
    });
    expect((await call(`/api/invoices/${inv.id}`)).json<Invoice>()).toEqual(inv);
  });

  it("create: refuses bad bodies, duplicates, foreign, token, spent, missing and too-small coins (no invoice made)", async () => {
    const s = setup();
    const call = s.user("acc");
    const spent = s.C.big;
    s.fake.coins.get(`${spent.txid}:${spent.vout}`)!.spentBy = "ee".repeat(32);
    const cases: Array<[unknown, number, string]> = [
      [{ asset: "PUSD", inputs: [s.C.r3, s.C.c1] }, 400, "bad_request"],
      [{ asset: "BCH", inputs: [] }, 400, "bad_request"],
      [{ asset: "BCH" }, 400, "bad_request"],
      [{ asset: "BCH", inputs: Array.from({ length: 11 }, (_, i) => ({ txid: txid(1), vout: i })) }, 400, "bad_request"],
      [{ asset: "BCH", inputs: [{ txid: "xyz", vout: 0 }] }, 400, "bad_request"],
      [{ asset: "BCH", inputs: [{ txid: txid(1), vout: -1 }] }, 400, "bad_request"],
      [{ asset: "BCH", inputs: [s.C.r3, { ...s.C.r3 }] }, 400, "duplicate_input"],
      [{ asset: "BCH", inputs: [s.C.r3, s.C.stranger] }, 400, "foreign_input"],
      [{ asset: "BCH", inputs: [s.C.r25] }, 400, "foreign_input"],
      [{ asset: "BCH", inputs: [s.C.r2token] }, 400, "token_input"],
      [{ asset: "BCH", inputs: [spent] }, 400, "input_spent"],
      [{ asset: "BCH", inputs: [{ txid: txid(9), vout: 0 }] }, 400, "input_not_found"],
      [{ asset: "BCH", inputs: [s.C.r3, s.C.small] }, 400, "insufficient_inputs"], // 51,000 < 62,500 + 500
    ];
    for (const [body, status, code] of cases) {
      const r = await call("/api/invoices", body);
      expect([r.status, r.code()], JSON.stringify(body)).toEqual([status, code]);
    }
    // the bar is amount + the shared fee estimate for that many inputs (300 for one)
    s.fake.addCoin({ txid: txid(5), vout: 0 }, wallet.lockingBytecode("receive", 7), BigInt(AMOUNT + estimatePaymentFee(1) - 1));
    expect((await create(call, [{ txid: txid(5), vout: 0 }])).code()).toBe("insufficient_inputs");
    s.fake.addCoin({ txid: txid(5), vout: 1 }, wallet.lockingBytecode("receive", 7), BigInt(AMOUNT + estimatePaymentFee(1)));
    expect((await create(call, [{ txid: txid(5), vout: 1 }])).status).toBe(201);
    expect(s.db.listInvoices("acc")).toHaveLength(1);
  });

  it("one open invoice per account: same inputs → the same invoice; different inputs → 409 invoice_open while its coins are unspent", async () => {
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    const again = await create(call, [s.C.c1, s.C.r3]); // any order
    expect(again.status).toBe(200);
    expect(again.json<Invoice>().id).toBe(a.id);
    const b = await create(call, [s.C.big]);
    expect([b.status, b.code()]).toEqual([409, "invoice_open"]);
    expect(b.json<ApiError>().error.invoiceId).toBe(a.id);
    expect(b.json<ApiError>().error.message).toContain(a.id);
    // 30 minutes later it has expired: a new invoice with other coins is fine
    s.setNow(new Date(NOW.getTime() + 30 * 60_000));
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>().status).toBe("expired");
    expect((await create(call, [s.C.big])).status).toBe(201);
  });

  it("an open invoice whose coin was spent elsewhere is replaced; GET reports inputsSpent", async () => {
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>().inputsSpent).toBeUndefined();
    s.fake.accept(s.payTx(a, { opReturns: [], lock: wallet.lockingBytecode("receive", 1) }).bin); // spent elsewhere
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>()).toMatchObject({ status: "open", inputsSpent: true });
    const b = await create(call, [s.C.big]);
    expect(b.status).toBe(201);
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>().status).toBe("expired");
  });

  it("create fetches raw outputs first: a foreign or token coin never triggers listunspent; owned scripts once each", async () => {
    const s = setup();
    const call = s.user("acc");
    expect((await create(call, [s.C.r3, s.C.stranger])).code()).toBe("foreign_input");
    expect((await create(call, [s.C.r2token])).code()).toBe("token_input");
    expect(s.fake.calls.filter((c) => c === "unspentOutpoints" || c === "getOutputs")).toEqual([]);
    s.fake.calls.length = 0;
    expect((await create(call, [s.C.r3, s.C.c1])).status).toBe(201);
    expect(s.fake.calls).toEqual(["getSourceOutputs", "unspentOutpoints"]);
  });

  it("price outside 10..100000 → 503 not_ready for quote and create", async () => {
    for (const price of [5, 200_000]) {
      const s = setup({ state: state(price) });
      const call = s.user("acc");
      expect((await call("/api/invoices/quote")).code()).toBe("not_ready");
      expect((await create(call, [s.C.big])).code()).toBe("not_ready");
    }
  });

  it("the 20 s history cache only helps FIND payments: a payment made after the cache filled is found by a fresh rescan", async () => {
    const s = setup();
    const call = s.user("acc");
    const other = s.user("acc2"); // same wallet keys, another account
    const scans = () => s.fake.calls.filter((c) => c === "recentTransactions").length;
    // acc2's invoice was spent elsewhere: its GET scans (and fills the cache)
    const b = (await create(other, [s.C.r3, s.C.c1])).json<Invoice>();
    s.fake.accept(s.payTx(b, { opReturns: [], lock: wallet.lockingBytecode("receive", 1) }).bin);
    expect((await other(`/api/invoices/${b.id}`)).json<Invoice>()).toMatchObject({ status: "open", inputsSpent: true });
    expect(scans()).toBe(2); // cached miss → fresh rescan before saying inputsSpent
    // now acc pays; the cache (filled seconds ago) does not have it
    const a = (await create(call, [s.C.big])).json<Invoice>();
    const tx = s.payTx(a);
    s.fake.accept(tx.bin);
    const got = (await call(`/api/invoices/${a.id}`)).json<Invoice>();
    expect(got).toMatchObject({ status: "paid", txid: tx.txid });
    expect(got.inputsSpent).toBeUndefined();
  });

  it("a cached hit finds a payment without a new scan", async () => {
    const s = setup();
    const call = s.user("acc");
    const other = s.user("acc2");
    const a = (await create(call, [s.C.big])).json<Invoice>();
    const b = (await create(other, [s.C.r3, s.C.c1])).json<Invoice>();
    s.fake.accept(s.payTx(a).bin);
    s.fake.accept(s.payTx(b).bin);
    const scans = () => s.fake.calls.filter((c) => c === "recentTransactions").length;
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>().status).toBe("paid");
    expect((await other(`/api/invoices/${b.id}`)).json<Invoice>().status).toBe("paid");
    expect(scans()).toBe(1);
  });

  it("GET never marks an invoice dead; create's fresh check does (past expiry + grace), then it is never rescanned", async () => {
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.big])).json<Invoice>();
    s.fake.accept(s.payTx(a, { opReturns: [], lock: wallet.lockingBytecode("receive", 1) }).bin);
    s.setNow(new Date(NOW.getTime() + 41 * 60_000));
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>()).toMatchObject({ status: "expired", inputsSpent: true });
    expect(s.db.getInvoice(a.id)!.status).not.toBe("dead");
    expect((await create(call, [s.C.r3, s.C.c1])).status).toBe(201);
    expect(s.db.getInvoice(a.id)!.status).toBe("dead");
    s.fake.calls.length = 0;
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>()).toMatchObject({ status: "expired", inputsSpent: true });
    expect(s.fake.calls).toEqual([]);
  });

  it("create fails closed (503, no invoice) when an earlier invoice cannot be checked", async () => {
    // spent inputs + the history scan fails
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.big])).json<Invoice>();
    s.fake.accept(s.payTx(a, { opReturns: [], lock: wallet.lockingBytecode("receive", 1) }).bin);
    s.fake.fail("recentTransactions");
    const r = await create(call, [s.C.r3, s.C.c1]);
    expect([r.status, r.code()]).toEqual([503, "chain_unavailable"]);
    expect(r.json<ApiError>().error.message).toMatch(/earlier payment/);
    expect(s.db.listInvoices("acc")).toHaveLength(1);
    // past-expiry earlier invoice whose outputs cannot be read
    const s2 = setup();
    const call2 = s2.user("acc");
    (await create(call2, [s2.C.big])).json<Invoice>();
    s2.setNow(new Date(NOW.getTime() + 31 * 60_000));
    s2.fake.fail("getOutputs");
    const r2 = await create(call2, [s2.C.r3, s2.C.c1]);
    expect([r2.status, r2.code()]).toEqual([503, "chain_unavailable"]);
    expect(s2.db.listInvoices("acc")).toHaveLength(1);
  });

  it("find-payment needs exactly one OP_RETURN (the invoice's)", async () => {
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.big])).json<Invoice>();
    s.fake.accept(s.payTx(a, { opReturns: [encodeInvoiceOpReturn(a.id), encodeInvoiceOpReturn(a.id)] }).bin);
    expect((await call(`/api/invoices/${a.id}`)).json<Invoice>()).toMatchObject({ status: "open", inputsSpent: true });
  });

  it("broadcast accepted but the lookup misses: retried 3× with 1 s waits; paid if the node answered our txid", async () => {
    const s = setup();
    const call = s.user("acc");
    const a = (await create(call, [s.C.big])).json<Invoice>();
    const tx = s.payTx(a);
    s.fake.setBroadcast(() => ({ ok: true, txid: tx.txid })); // accepted, but no host returns it yet
    s.fake.calls.length = 0;
    const r = await call(`/api/invoices/${a.id}/submit`, { signedTxHex: tx.hex });
    expect(r.json<Invoice>()).toMatchObject({ status: "paid", txid: tx.txid });
    expect(s.fake.calls.filter((c) => c === "getTransaction")).toHaveLength(3);
    expect(s.sleeps).toEqual([1000, 1000]);
    // no txid in the answer and still not found → 502, not paid
    const s2 = setup();
    const call2 = s2.user("acc");
    const b = (await create(call2, [s2.C.big])).json<Invoice>();
    s2.fake.setBroadcast(() => ({ ok: true }));
    const r2 = await call2(`/api/invoices/${b.id}/submit`, { signedTxHex: s2.payTx(b).hex });
    expect([r2.status, r2.code()]).toEqual([502, "broadcast_failed"]);
    expect(s2.db.getAccount("acc")!.proUntil).toBeNull();
  });

  it("submit: broadcasts, marks paid, Pro for 30 days, unlimited watches", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    const tx = s.payTx(inv);
    const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: tx.hex });
    expect(r.status).toBe(200);
    expect(r.json<Invoice>()).toEqual({ ...inv, status: "paid", txid: tx.txid, paidAt: NOW.toISOString() });
    expect(s.fake.broadcasts).toEqual([tx.hex]);
    const me = (await call("/api/me")).json<MeResponse>();
    expect(me).toMatchObject({ pro: true, proUntil: new Date((NOW_S + 30 * DAY) * 1000).toISOString(), watchLimit: null });
  });

  it("submit twice → the same paid invoice, no second broadcast, Pro not extended twice", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    const tx = s.payTx(inv);
    const first = (await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: tx.hex })).json<Invoice>();
    s.setNow(new Date(NOW.getTime() + 60_000));
    const second = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: tx.hex });
    expect(second.status).toBe(200);
    expect(second.json<Invoice>()).toEqual(first);
    // even a different (garbage) body after payment just returns the invoice
    expect((await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: "00" })).json<Invoice>()).toEqual(first);
    expect(s.fake.broadcasts).toHaveLength(1);
    expect(s.db.getAccount("acc")!.proUntil).toBe(NOW_S + 30 * DAY);
  });

  it("concurrent submits extend Pro once", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    const tx = s.payTx(inv);
    const rs = await Promise.all([1, 2, 3].map(() => call(`/api/invoices/${inv.id}/submit`, { signedTxHex: tx.hex })));
    for (const r of rs) expect(r.json<Invoice>().status).toBe("paid");
    expect(s.db.getAccount("acc")!.proUntil).toBe(NOW_S + 30 * DAY);
  });

  it("submit refuses a wrong transaction with distinct codes and broadcasts nothing", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    const other = encodeInvoiceOpReturn("ab".repeat(16));
    const cases: Array<[string, string]> = [
      ["zz", "bad_request"],
      ["00", "bad_tx"],
      [s.payTx(inv, { inputs: [s.C.r3] }).hex, "wrong_inputs"],
      [s.payTx(inv, { inputs: [s.C.r3, s.C.c1, s.C.big] }).hex, "wrong_inputs"],
      [s.payTx(inv, { inputs: [s.C.r3, s.C.big] }).hex, "wrong_inputs"],
      [s.payTx(inv, { value: AMOUNT - 1 }).hex, "underpaid"],
      [s.payTx(inv, { lock: wallet.lockingBytecode("receive", 0) }).hex, "underpaid"],
      [s.payTx(inv, { opReturns: [other] }).hex, "wrong_op_return"],
      [s.payTx(inv, { opReturns: [] }).hex, "wrong_op_return"],
      [s.payTx(inv, { opReturns: [encodeInvoiceOpReturn(inv.id), encodeInvoiceOpReturn(inv.id)] }).hex, "wrong_op_return"],
      [s.payTx(inv, { tokenOut: true }).hex, "token_output"],
    ];
    for (const [hex, code] of cases) {
      const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: hex });
      expect([r.status, r.code()], code).toEqual([400, code]);
    }
    // inputs in another order are fine
    const reordered = s.payTx(inv, { inputs: [s.C.c1, s.C.r3] });
    expect((await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: reordered.hex })).json<Invoice>().status).toBe("paid");
    expect(s.fake.broadcasts).toEqual([reordered.hex]);
  });

  it("already known to the node (the wallet broadcast it) → paid", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    const tx = s.payTx(inv);
    s.fake.accept(tx.bin);
    const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: tx.hex });
    expect(r.json<Invoice>()).toMatchObject({ status: "paid", txid: tx.txid });
  });

  it("inputs already spent + find-payment hit → paid with the transaction actually on chain", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    const onChain = s.payTx(inv, { change: 9_000 }); // e.g. a re-signed variant the wallet broadcast
    s.fake.accept(onChain.bin);
    const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect(r.json<Invoice>()).toMatchObject({ status: "paid", txid: onChain.txid });
    expect(s.db.getAccount("acc")!.proUntil).toBe(NOW_S + 30 * DAY);
  });

  it("inputs spent by something else → 409 inputs_spent, invoice stays unpaid", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    // the user spent the coin elsewhere (no invoice OP_RETURN)
    s.fake.accept(s.payTx(inv, { opReturns: [], lock: wallet.lockingBytecode("receive", 1) }).bin);
    const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect([r.status, r.code()]).toEqual([409, "inputs_spent"]);
    expect((await call(`/api/invoices/${inv.id}`)).json<Invoice>().status).toBe("open");
    expect(s.db.getAccount("acc")!.proUntil).toBeNull();
  });

  it("other node rejection → 502 broadcast_failed with the node's message; chain down → 503", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    s.fake.setBroadcast(() => ({ ok: false, message: "the transaction was rejected by network rules.\n\nmin relay fee not met, 100 < 300 (code 66)" }));
    const r = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect([r.status, r.code()]).toEqual([502, "broadcast_failed"]);
    expect(r.json<ApiError>().error.message).toContain("min relay fee not met");
    s.fake.setBroadcast(null);
    s.fake.setDown(true);
    const d = await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect([d.status, d.code()]).toEqual([503, "chain_unavailable"]);
    expect(s.db.getInvoice(inv.id)!.status).toBe("open");
  });

  it("GET of an open invoice whose inputs our payment spent → paid (lost submit)", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    expect((await call(`/api/invoices/${inv.id}`)).json<Invoice>().status).toBe("open");
    const tx = s.payTx(inv);
    s.fake.accept(tx.bin);
    expect((await call(`/api/invoices/${inv.id}`)).json<Invoice>()).toMatchObject({ status: "paid", txid: tx.txid });
    expect((await call("/api/me")).json<MeResponse>().pro).toBe(true);
    // a chain outage does not break GET: it answers with what it knows
    const inv2 = (await create(call, [s.C.big])).json<Invoice>();
    s.fake.setDown(true);
    expect((await call(`/api/invoices/${inv2.id}`)).json<Invoice>().status).toBe("open");
  });

  it("creating a new invoice when the previous one was paid on chain → 409 already_paid, Pro activated", async () => {
    const s = setup();
    const call = s.user("acc");
    const inv = (await create(call, [s.C.r3, s.C.c1])).json<Invoice>();
    const tx = s.payTx(inv);
    s.fake.accept(tx.bin); // wallet broadcast, then the browser lost everything
    const r = await create(call, [s.C.big]);
    expect([r.status, r.code()]).toEqual([409, "already_paid"]);
    expect(r.json<ApiError>().error.message).toContain(tx.txid);
    expect(s.db.getInvoice(inv.id)).toMatchObject({ status: "paid", txid: tx.txid });
    expect(s.db.getAccount("acc")!.proUntil).toBe(NOW_S + 30 * DAY);
    // and a fresh purchase afterwards is allowed (extends Pro)
    expect((await create(call, [s.C.big])).status).toBe(201);
  });

  it("another account's invoice is 404 for GET and submit", async () => {
    const s = setup();
    const mine = s.user("acc");
    const theirs = s.user("other", stranger);
    const inv = (await create(mine, [s.C.big])).json<Invoice>();
    expect((await theirs(`/api/invoices/${inv.id}`)).status).toBe(404);
    const r = await theirs(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect([r.status, r.code()]).toEqual([404, "not_found"]);
    expect(s.fake.broadcasts).toHaveLength(0);
    // and the stranger cannot lock our coins into their invoice
    expect((await create(theirs, [s.C.big])).code()).toBe("foreign_input");
  });

  it("Pro stacks on a running pass", async () => {
    const s = setup({ proUntil: NOW_S + 10 * DAY });
    const call = s.user("acc");
    const inv = (await create(call, [s.C.big])).json<Invoice>();
    await call(`/api/invoices/${inv.id}/submit`, { signedTxHex: s.payTx(inv).hex });
    expect(s.db.getAccount("acc")!.proUntil).toBe(NOW_S + 40 * DAY);
  });
});

describe("classifyBroadcastError", () => {
  it("known / spent / other", () => {
    expect(classifyBroadcastError("the transaction was rejected by network rules.\n\ntxn-already-known")).toBe("known");
    expect(classifyBroadcastError("txn-already-in-mempool")).toBe("known");
    expect(classifyBroadcastError("Transaction already in block chain")).toBe("known");
    expect(classifyBroadcastError("Missing inputs")).toBe("spent");
    expect(classifyBroadcastError("bad-txns-inputs-missingorspent")).toBe("spent");
    expect(classifyBroadcastError("txn-mempool-conflict (code 18)")).toBe("spent");
    expect(classifyBroadcastError("min relay fee not met")).toBe("other");
    expect(classifyBroadcastError("mandatory-script-verify-flag-failed")).toBe("other");
  });
});
