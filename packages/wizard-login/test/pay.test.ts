// payProPass(): unit tests for coin selection / tx building, and end to end against the real
// Redline app (createApp) with an in-memory DB, a fake chain and a fake wallet that signs every input.
import { randomBytes } from "node:crypto";
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  utf8ToBin,
  type TransactionCommon,
} from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { Invoice, MeResponse, Utxo } from "@redline/api-types";
import { createApp, SESSION_COOKIE } from "../../../apps/server/src/app.js";
import { openDb } from "../../../apps/server/src/db.js";
import type { ChainReader } from "../../../apps/server/src/reader.js";
import { fakePaymentChain } from "../../../apps/server/test/fake-payment-chain.js";
import { PAY_USER_PROMPT, PENDING_INVOICE_KEY, PaymentError, buildPaymentTx, payProPass, selectPaymentCoins, type PayStep } from "../src/client/pay.js";
import type { LoginWallet } from "../src/client/login.js";
import { encodeInvoiceOpReturn, estimatePaymentFee } from "../src/payment.js";
import { makeWallet, signP2pkhInputs, type TestWallet } from "./helpers.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const MERCHANT = "bitcoincash:zq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygyzxn9ta6";
const MERCHANT_LOCK = (cashAddressToLockingBytecode(MERCHANT) as { bytecode: Uint8Array }).bytecode;
const AMOUNT = 62_500; // at $400
const wallet = makeWallet(11);
const addr = (b: Uint8Array) => (lockingBytecodeToCashAddress({ bytecode: b, prefix: "bitcoincash" }) as { address: string }).address;
const utxo = (n: number, sats: number, token = false): Utxo => ({
  txid: n.toString(16).padStart(2, "0").repeat(32),
  vout: 0,
  address: "bitcoincash:qx",
  satoshis: sats,
  height: 1,
  token: token ? { category: "cc".repeat(32), amount: "1", nft: null } : null,
});

describe("selectPaymentCoins", () => {
  it("token-free coins, largest first, until amount + fee estimate is covered (same bar as the server)", () => {
    const sel = selectPaymentCoins([utxo(1, 1_000), utxo(2, 30_000), utxo(3, 500_000, true), utxo(4, 50_000)], AMOUNT);
    expect(sel?.coins.map((c) => c.satoshis)).toEqual([50_000, 30_000]);
    expect(sel?.fee).toBe(estimatePaymentFee(2));
    // one coin worth exactly amount + 300 (the one-input fee) is enough
    expect(selectPaymentCoins([utxo(1, AMOUNT + 300)], AMOUNT)?.coins).toHaveLength(1);
    expect(selectPaymentCoins([utxo(1, AMOUNT + 299)], AMOUNT)).toBeNull();
    // never more than 10 inputs
    expect(selectPaymentCoins(Array.from({ length: 12 }, (_, i) => utxo(i + 1, 6_400)), AMOUNT)).toBeNull(); // 10 × 6,400 < 62,500 + fee; the 11th never counts
    expect(selectPaymentCoins([], AMOUNT)).toBeNull();
  });
});

describe("buildPaymentTx", () => {
  const id = "ab".repeat(16);
  const coins = [
    { outpoint: { txid: "11".repeat(32), vout: 1 }, satoshis: 50_000, lockingBytecode: wallet.lockingBytecode("receive", 0) },
    { outpoint: { txid: "22".repeat(32), vout: 0 }, satoshis: 30_000, lockingBytecode: wallet.lockingBytecode("change", 2) },
  ];
  it("merchant output, invoice OP_RETURN, change to change/0; inputs in the given order", () => {
    const b = buildPaymentTx({ invoiceId: id, amountSats: AMOUNT, merchantLockingBytecode: MERCHANT_LOCK, coins, changeLockingBytecode: wallet.lockingBytecode("change", 0) });
    const fee = estimatePaymentFee(2);
    expect(b.fee).toBe(fee);
    expect(b.transaction.inputs.map((i) => [binToHex(i.outpointTransactionHash), i.outpointIndex, i.sequenceNumber])).toEqual([
      ["11".repeat(32), 1, 0xffffffff],
      ["22".repeat(32), 0, 0xffffffff],
    ]);
    expect(b.transaction.outputs.map((o) => [binToHex(o.lockingBytecode), o.valueSatoshis])).toEqual([
      [binToHex(MERCHANT_LOCK), BigInt(AMOUNT)],
      [binToHex(encodeInvoiceOpReturn(id)), 0n],
      [binToHex(wallet.lockingBytecode("change", 0)), BigInt(80_000 - AMOUNT - fee)],
    ]);
    expect(b.sourceOutputs.map((s) => [s.valueSatoshis, s.outpointIndex])).toEqual([[50_000n, 1], [30_000n, 0]]);
  });
  it("change below dust goes to the fee", () => {
    const b = buildPaymentTx({
      invoiceId: id,
      amountSats: AMOUNT,
      merchantLockingBytecode: MERCHANT_LOCK,
      coins: [{ ...coins[0]!, satoshis: AMOUNT + 800 }],
      changeLockingBytecode: wallet.lockingBytecode("change", 0),
    });
    expect(b.transaction.outputs).toHaveLength(2);
    expect(b.fee).toBe(800);
  });
  it("throws when the coins cannot cover amount + fee", () => {
    expect(() =>
      buildPaymentTx({ invoiceId: id, amountSats: AMOUNT, merchantLockingBytecode: MERCHANT_LOCK, coins: [{ ...coins[0]!, satoshis: AMOUNT + 100 }], changeLockingBytecode: wallet.lockingBytecode("change", 0) }),
    ).toThrow();
  });
});

// ---------- end to end ----------

const reader: ChainReader = {
  current: () => ({ blockHeight: 1, priceUsd: 400, updatedAt: NOW.toISOString(), loans: [], byId: new Map() }),
  lastError: () => null,
  refresh: async () => {},
  start() {},
  stop() {},
  onUpdate() {},
};

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

function setup() {
  let price = 400;
  const fake = fakePaymentChain();
  const db = openDb(":memory:");
  const getUtxos = async (addresses: string[]): Promise<Utxo[]> => {
    const out: Utxo[] = [];
    for (const [k, c] of fake.coins) {
      if (c.spentBy) continue;
      const a = addr(c.output.lockingBytecode);
      if (!addresses.includes(a)) continue;
      const [txid, vout] = k.split(":");
      out.push({ txid: txid!, vout: Number(vout), address: a, satoshis: Number(c.output.valueSatoshis), height: 1, token: c.output.token ? { category: "cc".repeat(32), amount: "1", nft: null } : null });
    }
    return out;
  };
  const app = createApp({
    reader: { ...reader, current: () => ({ ...reader.current()!, priceUsd: price }) },
    db,
    chain: { getSourceOutput: async () => null, isUnspentOrSpentBy: async () => false, getUtxos },
    config: { loginDomain: "redline.test", secureCookies: false, trustProxyHops: 0, logXff: false, publicOrigin: undefined },
    now: () => NOW,
    payments: { merchantAddress: MERCHANT, chain: fake.chain },
  });
  const accountId = binToHex(sha256.hash(utf8ToBin(wallet.xpubReceive)));
  db.upsertAccount({ id: accountId, xpubReceive: wallet.xpubReceive, xpubChange: wallet.xpubChange, now: NOW_S });
  const token = randomBytes(32).toString("hex");
  db.createSession(binToHex(sha256.hash(utf8ToBin(token))), accountId, NOW_S + 3600);

  // a browser with the session cookie; `fail` can drop a request or its response
  const calls: string[] = [];
  let fail: ((method: string, path: string) => "request" | "response" | null) | null = null;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost:5174");
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const f = fail?.(method, url.pathname);
    if (f === "request") throw new TypeError("Failed to fetch");
    const headers = new Headers(init.headers);
    if (init.credentials === "include") headers.set("cookie", `${SESSION_COOKIE}=${token}`);
    const res = await app.request(url.pathname + url.search, { ...init, headers });
    if (f === "response") throw new TypeError("Failed to fetch");
    return res;
  }) as typeof globalThis.fetch;

  const coin = (n: number, path: ["receive" | "change", number], sats: number, token = false) =>
    fake.addCoin(
      { txid: n.toString(16).padStart(2, "0").repeat(32), vout: 0 },
      wallet.lockingBytecode(path[0], path[1]),
      BigInt(sats),
      token ? { category: hexToBin("cc".repeat(32)), amount: 1n } : undefined,
    );

  return { app, db, fake, fetch, calls, accountId, coin, setFail: (f: typeof fail) => (fail = f), setPrice: (p: number) => (price = p) };
}

interface SignCall {
  transaction: TransactionCommon;
  broadcast: boolean | undefined;
  userPrompt: string | undefined;
  inputPaths: [number, string, number][];
}

/** wallet: signs every input with the key at its inputPath, broadcasts when asked (like Paytaca/Selene) */
function fakeManager(w: TestWallet, fake: ReturnType<typeof fakePaymentChain>, o: { reject?: string } = {}) {
  const signCalls: SignCall[] = [];
  const manager: LoginWallet = {
    walletName: "FakeWallet",
    getSessionPaths: () => [
      { name: "receive", xpub: w.xpubReceive },
      { name: "change", xpub: w.xpubChange },
    ],
    async signTransaction(req) {
      const t = req.transaction;
      const tx = t.transaction as TransactionCommon;
      signCalls.push({ transaction: tx, broadcast: t.broadcast, userPrompt: t.userPrompt, inputPaths: req.inputPaths });
      if (o.reject) throw new Error(o.reject);
      const keys = tx.inputs.map((_, i) => {
        const p = req.inputPaths.find(([k]) => k === i);
        if (!p) throw new Error(`no inputPath for input ${i}`);
        return w.privateKey(p[1] as "receive" | "change", p[2]);
      });
      const signed = encodeTransaction(signP2pkhInputs(tx, t.sourceOutputs as never, keys));
      if (t.broadcast) fake.accept(signed);
      return { signedTransaction: binToHex(signed) } as never;
    },
  };
  return { manager, signCalls };
}

async function payError(p: Promise<unknown>): Promise<PaymentError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PaymentError);
    return e as PaymentError;
  }
  throw new Error("expected payProPass to fail");
}

describe("payProPass against the real server app", () => {
  it("pays end to end: quote, coins, invoice, sign + broadcast, submit → paid, Pro on", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 40_000);
    s.coin(2, ["change", 5], 30_000);
    s.coin(3, ["receive", 7], 900_000, true); // tokens: never used
    const { manager, signCalls } = fakeManager(wallet, s.fake);
    const storage = memoryStorage();
    const steps: PayStep[] = [];
    const inv = await payProPass({ manager, fetch: s.fetch, storage, onStep: (st) => steps.push(st) });

    expect(inv.status).toBe("paid");
    expect(steps).toEqual(["quote", "coins", "invoice", "signing", "submitting"]);
    expect(s.calls).toEqual(["GET /api/invoices/quote", "GET /api/utxos", "POST /api/invoices", "POST /api/invoices/" + inv.id + "/submit"]);
    expect(storage.m.size).toBe(0);

    expect(signCalls).toHaveLength(1);
    const call = signCalls[0]!;
    expect(call.broadcast).toBe(true);
    expect(call.userPrompt).toBe(PAY_USER_PROMPT);
    // inputPaths follow the final input order
    expect(call.inputPaths).toEqual([
      [0, "receive", 2],
      [1, "change", 5],
    ]);
    expect(call.transaction.outputs[0]!.valueSatoshis).toBe(BigInt(AMOUNT));
    expect(binToHex(call.transaction.outputs[2]!.lockingBytecode)).toBe(binToHex(wallet.lockingBytecode("change", 0)));
    expect(s.fake.txs.has(inv.txid!)).toBe(true);

    const me = (await (await s.fetch("/api/me", { credentials: "include" })).json()) as MeResponse;
    expect(me.pro).toBe(true);
    expect(me.watchLimit).toBeNull();
  });

  it("no_funds without enough plain BCH; nothing created, wallet not asked", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 10_000);
    const { manager, signCalls } = fakeManager(wallet, s.fake);
    const e = await payError(payProPass({ manager, fetch: s.fetch, storage: memoryStorage() }));
    expect(e.code).toBe("no_funds");
    expect(e.message).toContain(addr(wallet.lockingBytecode("receive", 0)));
    expect(signCalls).toHaveLength(0);
    expect(s.db.listInvoices(s.accountId)).toHaveLength(0);
  });

  it("wallet rejection surfaces verbatim and keeps the invoice; the retry reuses the same inputs", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const storage = memoryStorage();
    const e = await payError(payProPass({ manager: fakeManager(wallet, s.fake, { reject: "User rejected the request" }).manager, fetch: s.fetch, storage }));
    expect(e.code).toBe("wallet_rejected");
    expect(e.message).toContain("User rejected the request");
    const pending = storage.getItem(PENDING_INVOICE_KEY)!;
    expect(pending).toMatch(/^[0-9a-f]{32}$/);

    // a bigger coin arrives: the retry must still use the invoice's persisted input, not pick anew
    s.coin(2, ["receive", 3], 5_000_000);
    s.calls.length = 0;
    const { manager, signCalls } = fakeManager(wallet, s.fake);
    const inv = await payProPass({ manager, fetch: s.fetch, storage });
    expect(inv.id).toBe(pending);
    expect(inv.status).toBe("paid");
    expect(s.calls.some((c) => c === "POST /api/invoices" || c === "GET /api/invoices/quote")).toBe(false);
    expect(signCalls[0]!.inputPaths).toEqual([[0, "receive", 2]]);
    expect(binToHex(signCalls[0]!.transaction.inputs[0]!.outpointTransactionHash)).toBe("01".repeat(32));
  });

  it("lost submit response + failed check → network; the retry answers Already paid ✓ without signing or broadcasting again", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const storage = memoryStorage();
    const { manager, signCalls } = fakeManager(wallet, s.fake);
    s.setFail((m, p) => (p.endsWith("/submit") ? "response" : m === "GET" && p.startsWith("/api/invoices/") && p !== "/api/invoices/quote" ? "request" : null));
    const e = await payError(payProPass({ manager, fetch: s.fetch, storage }));
    expect(e.code).toBe("network");
    expect(storage.getItem(PENDING_INVOICE_KEY)).not.toBeNull();

    s.setFail(null);
    const details: string[] = [];
    const inv = await payProPass({ manager, fetch: s.fetch, storage, onStep: (st, d) => details.push(`${st}:${d ?? ""}`) });
    expect(inv.status).toBe("paid");
    expect(details.some((d) => d.includes("Already paid ✓"))).toBe(true);
    expect(signCalls).toHaveLength(1);
    expect(s.fake.broadcasts).toHaveLength(1); // the server's one broadcast of the wallet's tx
    expect(s.fake.txs.size).toBe(1); // only the one payment tx exists
    expect(storage.m.size).toBe(0);
    expect(s.db.getAccount(s.accountId)!.proUntil).toBe(NOW_S + 30 * 86_400);
  });

  it("submit never arrives but the wallet broadcast it → the check finds the payment", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const storage = memoryStorage();
    s.setFail((m, p) => (p.endsWith("/submit") ? "request" : null));
    const steps: PayStep[] = [];
    const inv = await payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage, onStep: (st) => steps.push(st) });
    expect(inv.status).toBe("paid");
    expect(steps.at(-1)).toBe("checking");
    expect(s.fake.broadcasts).toHaveLength(0); // found via the merchant history, not re-broadcast
    expect(storage.m.size).toBe(0);
  });

  it("refuses, before signing, an invoice that costs > 5 % over the quote or pays another address", async () => {
    for (const tamper of [
      (inv: Invoice) => ({ ...inv, amountSats: Math.floor(AMOUNT * 1.06) }),
      (inv: Invoice) => ({ ...inv, merchantAddress: addr(wallet.lockingBytecode("receive", 9)) }),
    ]) {
      const s = setup();
      s.coin(1, ["receive", 2], 200_000);
      const fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
        const res = await s.fetch(u, init);
        if (init?.method === "POST" && String(u).endsWith("/api/invoices")) {
          return new Response(JSON.stringify(tamper((await res.json()) as Invoice)), { status: res.status, headers: { "content-type": "application/json" } });
        }
        return res;
      }) as typeof globalThis.fetch;
      const { manager, signCalls } = fakeManager(wallet, s.fake);
      const e = await payError(payProPass({ manager, fetch, storage: memoryStorage() }));
      expect(e.code).toBe("server_rejected");
      expect(e.message).toMatch(/quote/);
      expect(signCalls).toHaveLength(0);
    }
  });

  it("a pending invoice whose coins were spent elsewhere is dropped and a fresh one is made", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const storage = memoryStorage();
    await payError(payProPass({ manager: fakeManager(wallet, s.fake, { reject: "no" }).manager, fetch: s.fetch, storage }));
    const first = storage.getItem(PENDING_INVOICE_KEY)!;
    // the user spends that coin somewhere else
    const c1 = s.fake.coins.get("01".repeat(32) + ":0")!;
    s.fake.accept(
      encodeTransaction(
        signP2pkhInputs(
          {
            version: 2,
            locktime: 0,
            inputs: [{ outpointTransactionHash: hexToBin("01".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
            outputs: [{ lockingBytecode: wallet.lockingBytecode("receive", 1), valueSatoshis: 99_000n }],
          },
          [c1.output as never],
          [wallet.privateKey("receive", 2)],
        ),
      ),
    );
    s.coin(2, ["receive", 3], 100_000);
    const inv = await payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage });
    expect(inv.status).toBe("paid");
    expect(inv.id).not.toBe(first);
    expect(inv.inputs).toEqual([{ txid: "02".repeat(32), vout: 0 }]);
  });

  it("409 invoice_open (storage lost, other coins picked) → reuses the open invoice and its coins", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const lost = memoryStorage();
    await payError(payProPass({ manager: fakeManager(wallet, s.fake, { reject: "no" }).manager, fetch: s.fetch, storage: lost }));
    const first = lost.getItem(PENDING_INVOICE_KEY)!;
    s.coin(2, ["receive", 3], 5_000_000); // the next attempt would pick this one
    const storage = memoryStorage();
    const { manager, signCalls } = fakeManager(wallet, s.fake);
    const inv = await payProPass({ manager, fetch: s.fetch, storage });
    expect(inv.id).toBe(first);
    expect(inv.status).toBe("paid");
    expect(signCalls[0]!.inputPaths).toEqual([[0, "receive", 2]]);
    expect(storage.m.size).toBe(0);
  });

  it("a reused invoice_open invoice is paid at its own price (no 5 % check) and its id is stored for retries", async () => {
    const s = setup();
    s.setPrice(300); // invoice A costs 83,334 sats
    s.coin(1, ["receive", 2], 200_000);
    const lost = memoryStorage();
    await payError(payProPass({ manager: fakeManager(wallet, s.fake, { reject: "no" }).manager, fetch: s.fetch, storage: lost }));
    const first = lost.getItem(PENDING_INVOICE_KEY)!;
    s.setPrice(400); // the new quote is 62,500: A is > 5 % above it
    s.coin(2, ["receive", 3], 5_000_000); // the next attempt picks other coins → 409 invoice_open
    const storage = memoryStorage();
    const e = await payError(payProPass({ manager: fakeManager(wallet, s.fake, { reject: "not now" }).manager, fetch: s.fetch, storage }));
    expect(e.code).toBe("wallet_rejected"); // got as far as the wallet: not refused by the quote check
    expect(storage.getItem(PENDING_INVOICE_KEY)).toBe(first);
    const inv = await payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage });
    expect(inv).toMatchObject({ id: first, status: "paid", amountSats: 83_334 });
  });

  it("a stored invoice of someone else / unknown → cleared, fresh purchase", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    const storage = memoryStorage();
    storage.setItem(PENDING_INVOICE_KEY, "ff".repeat(16));
    const inv = await payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage });
    expect(inv.status).toBe("paid");
    expect(inv.id).not.toBe("ff".repeat(16));
  });

  it("server_rejected carries the server's code (e.g. a coin the server will not accept)", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    // the chain says the coin is spent by the time the invoice is created
    s.fake.chain.unspentOutpoints = async () => new Set<string>();
    const e = await payError(payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage: memoryStorage() }));
    expect(e.code).toBe("server_rejected");
    expect(e.serverCode).toBe("input_spent");
    expect(e.status).toBe(400);
  });

  it("already_paid from the server when an earlier lost payment is found", async () => {
    const s = setup();
    s.coin(1, ["receive", 2], 100_000);
    s.coin(2, ["receive", 4], 100_000);
    // first attempt: wallet broadcasts, then the whole browser state is lost
    s.setFail((m, p) => (p.endsWith("/submit") || (m === "GET" && /^\/api\/invoices\/[0-9a-f]{32}$/.test(p)) ? "request" : null));
    await payError(payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage: memoryStorage() }));
    s.setFail(null);
    const e = await payError(payProPass({ manager: fakeManager(wallet, s.fake).manager, fetch: s.fetch, storage: memoryStorage() }));
    expect(e.code).toBe("already_paid");
    expect(e.message).toContain("Already paid ✓");
  });
});
