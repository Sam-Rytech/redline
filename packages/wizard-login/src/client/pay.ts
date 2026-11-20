// Browser half of the 30-day Pro pass payment (BCH): quote → pick coins → invoice (the server pins
// the coins) → the wallet signs AND broadcasts → submit. Exactly-once: the pending invoice id is kept
// in storage and any retry reuses its pinned inputs, so a second payment would be a double spend the
// network refuses. Never retries with other coins on its own (ARCHITECTURE.md §7 gotchas 2, 5, 6).
import {
  cashAddressToLockingBytecode,
  hexToBin,
  type Input,
  type Output,
  type TransactionCommon,
} from "@bitauth/libauth";
import type { ApiError, CreateInvoiceRequest, Invoice, InvoiceQuote, Outpoint, Utxo } from "@redline/api-types";
import {
  DUST_SATS,
  MAX_INVOICE_INPUTS,
  encodeInvoiceOpReturn,
  estimatePaymentFee,
  invoiceOpReturnHex,
} from "../payment.js";
import { LOGIN_ADDRESS_COUNT, deriveAddresses, txidOf, type LoginWallet } from "./login.js";

export const PENDING_INVOICE_KEY = "redline-pending-invoice";
export const PAY_USER_PROMPT = "Pay 30-day Redline Pro pass";

export type PaymentErrorCode = "no_paths" | "no_funds" | "wallet_rejected" | "server_rejected" | "already_paid" | "network";
export type PayStep = "quote" | "coins" | "invoice" | "signing" | "submitting" | "checking";

export class PaymentError extends Error {
  status?: number;
  serverCode?: string;
  /** receive address 0 (for no_funds) */
  address?: string;
  /** the server's error.invoiceId (already_paid, invoice_open) */
  invoiceId?: string;

  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    extra: { status?: number; serverCode?: string; address?: string; invoiceId?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "PaymentError";
    if (extra.invoiceId !== undefined) this.invoiceId = extra.invoiceId;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.serverCode !== undefined) this.serverCode = extra.serverCode;
    if (extra.address !== undefined) this.address = extra.address;
  }
}

export type PayStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PayProPassOptions {
  manager: LoginWallet;
  /** default "/api" */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** where the pending invoice id is kept between attempts (default: localStorage when present) */
  storage?: PayStorage;
  onStep?: (step: PayStep, detail?: string) => void;
}

/** Token-free coins, largest first, until they cover amount + fee estimate (the server's bar); at most 10. Null if they never do. */
export function selectPaymentCoins<T extends Pick<Utxo, "txid" | "vout" | "satoshis" | "token">>(
  utxos: readonly T[],
  amountSats: number,
): { coins: T[]; fee: number } | null {
  const plain = utxos
    .filter((u) => u.token === null && Number.isSafeInteger(u.satoshis) && u.satoshis > 0)
    .sort((a, b) => b.satoshis - a.satoshis || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
  const coins: T[] = [];
  let total = 0;
  for (const u of plain) {
    if (coins.length === MAX_INVOICE_INPUTS) break;
    coins.push(u);
    total += u.satoshis;
    const fee = estimatePaymentFee(coins.length);
    if (total >= amountSats + fee) return { coins, fee };
  }
  return null;
}

export interface PaymentCoin {
  outpoint: Outpoint;
  satoshis: number;
  lockingBytecode: Uint8Array;
}

/**
 * The unsigned payment: inputs = `coins` in that order; outputs = merchant amount, invoice OP_RETURN,
 * change (dropped into the fee below dust). Throws when the coins cannot cover amount + fee.
 */
export function buildPaymentTx(o: {
  invoiceId: string;
  amountSats: number;
  merchantLockingBytecode: Uint8Array;
  coins: readonly PaymentCoin[];
  changeLockingBytecode: Uint8Array;
}): { transaction: TransactionCommon; sourceOutputs: Array<Input & Output>; fee: number } {
  const total = o.coins.reduce((s, c) => s + c.satoshis, 0);
  const estimate = estimatePaymentFee(o.coins.length);
  const change = total - o.amountSats - estimate;
  if (change < 0) throw new Error(`Coins hold ${total} sats; need ${o.amountSats + estimate}`);
  const inputs = o.coins.map((c) => ({
    outpointTransactionHash: hexToBin(c.outpoint.txid),
    outpointIndex: c.outpoint.vout,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
  }));
  const outputs: Output[] = [
    { lockingBytecode: Uint8Array.from(o.merchantLockingBytecode), valueSatoshis: BigInt(o.amountSats) },
    { lockingBytecode: encodeInvoiceOpReturn(o.invoiceId), valueSatoshis: 0n },
  ];
  if (change >= DUST_SATS) outputs.push({ lockingBytecode: Uint8Array.from(o.changeLockingBytecode), valueSatoshis: BigInt(change) });
  const fee = change >= DUST_SATS ? estimate : total - o.amountSats;
  return {
    transaction: { version: 2, locktime: 0, inputs, outputs },
    sourceOutputs: o.coins.map((c, i) => ({ ...inputs[i]!, lockingBytecode: c.lockingBytecode, valueSatoshis: BigInt(c.satoshis) })),
    fee,
  };
}

const isAbort = (e: unknown, signal?: AbortSignal) =>
  signal?.aborted === true || (e instanceof Error && e.name === "AbortError") || (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function defaultStorage(): PayStorage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined; // blocked storage throws on access
  }
}

/** Pay for the 30-day Pro pass; resolves with the invoice once it is paid. */
export async function payProPass(opts: PayProPassOptions): Promise<Invoice> {
  const { manager, signal, onStep } = opts;
  const apiBase = (opts.apiBase ?? "/api").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = opts.storage ?? defaultStorage();
  const store = {
    get: () => {
      try {
        return storage?.getItem(PENDING_INVOICE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set: (id: string) => {
      try {
        storage?.setItem(PENDING_INVOICE_KEY, id);
      } catch {
        // best effort; the server's already_paid check is the backstop
      }
    },
    clear: () => {
      try {
        storage?.removeItem(PENDING_INVOICE_KEY);
      } catch {
        // ignore
      }
    },
  };
  signal?.throwIfAborted();

  const api = async <T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method: init.method ?? "GET",
        credentials: "include",
        ...(init.body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
        ...(signal && { signal }),
      });
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw new PaymentError("network", `Could not reach the server (${path.split("?")[0]}): ${messageOf(e)}`, { cause: e });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw new PaymentError("network", `Unexpected non-JSON response from ${path.split("?")[0]} (HTTP ${res.status})`, { status: res.status, cause: e });
    }
    if (!res.ok) {
      const err = (body as Partial<ApiError> | null)?.error;
      const code = typeof err?.code === "string" ? err.code : `http_${res.status}`;
      const msg = typeof err?.message === "string" ? err.message : res.statusText || "request failed";
      throw new PaymentError(code === "already_paid" ? "already_paid" : "server_rejected", `${code}: ${msg}`, {
        status: res.status,
        serverCode: code,
        ...(typeof err?.invoiceId === "string" && { invoiceId: err.invoiceId }),
      });
    }
    return body as T;
  };
  const getInvoice = (id: string) => api<Invoice>(`/invoices/${encodeURIComponent(id)}`);
  const paidDetail = (inv: Invoice) => `Already paid ✓ txid ${inv.txid}`;

  // wallet keys + the addresses the server accepts coins from (receive/change 0..19)
  const paths = manager.getSessionPaths();
  const xpubReceive = paths.find((p) => p.name === "receive")?.xpub;
  const xpubChange = paths.find((p) => p.name === "change")?.xpub;
  if (!xpubReceive || !xpubChange) {
    throw new PaymentError("no_paths", "The wallet did not share its receive and change keys (xpubs). Reconnect the wallet and try again.");
  }
  const where = new Map<string, ["receive" | "change", number]>();
  let receive0: string;
  let change0Lock: Uint8Array;
  try {
    const rec = deriveAddresses(xpubReceive, LOGIN_ADDRESS_COUNT);
    const chg = deriveAddresses(xpubChange, LOGIN_ADDRESS_COUNT);
    rec.forEach((a, i) => where.set(a, ["receive", i]));
    chg.forEach((a, i) => where.set(a, ["change", i]));
    receive0 = rec[0]!;
    const l = cashAddressToLockingBytecode(chg[0]!);
    if (typeof l === "string") throw new Error(l);
    change0Lock = l.bytecode;
  } catch (e) {
    throw new PaymentError("no_paths", `The wallet shared an unusable xpub: ${messageOf(e)}`, { cause: e });
  }
  const walletUtxos = async (): Promise<Utxo[]> => {
    const list = await api<Utxo[]>(`/utxos?addresses=${encodeURIComponent([...where.keys()].join(","))}`);
    if (!Array.isArray(list)) throw new PaymentError("network", "Unexpected /utxos response");
    return list.filter((u) => where.has(u.address));
  };

  // 1. a pending invoice from an earlier attempt: paid → done; open → reuse its pinned inputs
  let invoice: Invoice | null = null;
  let utxos: Utxo[] | null = null;
  const pendingId = store.get();
  if (pendingId) {
    onStep?.("checking", `earlier invoice ${pendingId}`);
    let prev: Invoice | null = null;
    try {
      prev = await getInvoice(pendingId);
    } catch (e) {
      if (!(e instanceof PaymentError && e.status === 404)) throw e;
    }
    if (prev?.status === "paid") {
      store.clear();
      onStep?.("checking", paidDetail(prev));
      return prev;
    }
    // open but its coins were spent by something that does not pay it: it can never be paid
    if (prev?.status === "open" && !prev.inputsSpent) invoice = prev;
    else store.clear();
  }

  // 2. new invoice: quote, coins, POST
  if (!invoice) {
    onStep?.("quote");
    const quote = await api<InvoiceQuote>("/invoices/quote");
    onStep?.("coins", `${quote.amountSats} sats (≈ $0.25 at $${quote.priceUsd}/BCH)`);
    utxos = await walletUtxos();
    const sel = selectPaymentCoins(utxos, quote.amountSats);
    if (!sel) {
      const need = quote.amountSats + estimatePaymentFee(1);
      throw new PaymentError(
        "no_funds",
        `The Pro pass costs ${quote.amountSats} sats; your wallet needs about ${need} sats of plain BCH (no tokens) on its first ${LOGIN_ADDRESS_COUNT} addresses. Send some to ${receive0} and try again.`,
        { address: receive0 },
      );
    }
    onStep?.("invoice", `${sel.coins.length} coin(s)`);
    const body: CreateInvoiceRequest = { asset: "BCH", inputs: sel.coins.map((c) => ({ txid: c.txid, vout: c.vout })) };
    try {
      invoice = await api<Invoice>("/invoices", { method: "POST", body });
    } catch (e) {
      // another invoice (other coins, e.g. after lost storage) is still open and payable: pay that one
      if (!(e instanceof PaymentError && e.serverCode === "invoice_open" && e.invoiceId)) throw e;
      onStep?.("invoice", `reusing open invoice ${e.invoiceId}`);
      invoice = await getInvoice(e.invoiceId);
      if (invoice.status !== "open") throw e;
    }
    // never sign for more than the quote shown (+5 %) or to another address
    if (invoice.amountSats > quote.amountSats * 1.05 || invoice.merchantAddress !== quote.merchantAddress) {
      throw new PaymentError(
        "server_rejected",
        `The invoice (${invoice.amountSats} sats to ${invoice.merchantAddress}) does not match the quote (${quote.amountSats} sats to ${quote.merchantAddress}); not paying it.`,
      );
    }
    store.set(invoice.id);
  }

  // 3. the invoice's coins, in the invoice's order
  if (invoice.opReturnHex !== invoiceOpReturnHex(invoice.id)) {
    throw new PaymentError("server_rejected", "The server sent an invoice with an unexpected OP_RETURN");
  }
  const merchant = cashAddressToLockingBytecode(invoice.merchantAddress);
  if (typeof merchant === "string") throw new PaymentError("server_rejected", `The server sent an invalid merchant address: ${merchant}`);
  utxos ??= await walletUtxos();
  const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
  const coins: Array<PaymentCoin & { path: ["receive" | "change", number] }> = [];
  for (const op of invoice.inputs) {
    const u = byOutpoint.get(`${op.txid}:${op.vout}`);
    const path = u && where.get(u.address);
    const lock = u && cashAddressToLockingBytecode(u.address);
    if (!u || !path || !lock || typeof lock === "string" || u.token !== null) {
      throw new PaymentError(
        "network",
        `Invoice ${invoice.id}'s coin ${op.txid}:${op.vout} is no longer in your wallet. If you just paid, it will show as paid in a minute — try again then; otherwise the invoice expires 30 minutes after it was made and you can start over.`,
      );
    }
    coins.push({ outpoint: op, satoshis: u.satoshis, lockingBytecode: lock.bytecode, path });
  }
  let built;
  try {
    built = buildPaymentTx({ invoiceId: invoice.id, amountSats: invoice.amountSats, merchantLockingBytecode: merchant.bytecode, coins, changeLockingBytecode: change0Lock });
  } catch (e) {
    throw new PaymentError("no_funds", `The invoice's coins do not cover ${invoice.amountSats} sats + fee: ${messageOf(e)}`, { address: receive0, cause: e });
  }

  // 4. sign + broadcast in the wallet; inputPaths from the FINAL input order
  onStep?.("signing", manager.walletName ? `approve ${invoice.amountSats} sats in ${manager.walletName}` : `approve ${invoice.amountSats} sats in your wallet`);
  let signedTxHex: string;
  try {
    const res = await manager.signTransaction(
      {
        transaction: { transaction: built.transaction, sourceOutputs: built.sourceOutputs, broadcast: true, userPrompt: PAY_USER_PROMPT },
        inputPaths: coins.map((c, i) => [i, c.path[0], c.path[1]]),
      },
      signal ? { signal } : undefined,
    );
    if (res.error) throw new Error(res.error);
    signedTxHex = typeof res.signedTransaction === "string" ? res.signedTransaction.trim().toLowerCase() : "";
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    // the outcome may be unknown (gotcha 6): keep the invoice, a retry reuses the same coins
    throw new PaymentError("wallet_rejected", `The wallet did not sign: ${messageOf(e)}`, { cause: e });
  }
  if (!/^(?:[0-9a-f]{2})+$/.test(signedTxHex)) throw new PaymentError("wallet_rejected", "The wallet returned no signed transaction");

  // 5. submit; on a lost connection ask the server whether the payment landed
  const txid = txidOf(signedTxHex);
  onStep?.("submitting", `txid ${txid}`);
  let paid: Invoice;
  try {
    paid = await api<Invoice>(`/invoices/${encodeURIComponent(invoice.id)}/submit`, { method: "POST", body: { signedTxHex } });
  } catch (e) {
    if (!(e instanceof PaymentError && e.code === "network")) throw e;
    onStep?.("checking", `connection lost; checking invoice ${invoice.id}`);
    let check: Invoice;
    try {
      check = await getInvoice(invoice.id);
    } catch (e2) {
      if (isAbort(e2, signal)) throw e2;
      throw new PaymentError("network", `Could not confirm the payment (${e.message}). Try again: it reuses the same coins, so you cannot pay twice.`, { cause: e });
    }
    if (check.status !== "paid") {
      throw new PaymentError("network", `The payment is not confirmed yet (${e.message}). Try again: it reuses the same coins, so you cannot pay twice.`, { cause: e });
    }
    paid = check;
  }
  if (paid.status !== "paid") throw new PaymentError("server_rejected", `Invoice ${paid.id} is ${paid.status}, not paid`);
  store.clear();
  return paid;
}
