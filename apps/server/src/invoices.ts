// 30-day Pro pass, paid in BCH. The server trusts nothing the client says about coins or amounts:
// the amount comes from the reader's price, every input is fetched from Electrum, and an invoice is
// paid only when its transaction is known to the network. Exactly-once: an invoice pins its inputs,
// so any second payment for it would be a double spend; marking paid + extending Pro is one DB step.
import { randomBytes } from "node:crypto";
import {
  binToHex,
  binsAreEqual,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  type TransactionCommon,
} from "@bitauth/libauth";
import { PRO_PASS_DAYS, type ApiError, type Invoice, type InvoiceQuote, type Outpoint } from "@redline/api-types";
import { MAX_INVOICE_INPUTS, encodeInvoiceOpReturn, estimatePaymentFee, invoiceOpReturnHex, proPassSats } from "@redline/wizard-login";
import { p2pkhForXpub } from "@redline/wizard-login/server";
import type { AccountRow, Db, InvoiceRow } from "./db.js";
import type { PaymentChain } from "./electrum.js";

export const QUOTE_SECONDS = 5 * 60;
export const INVOICE_SECONDS = 30 * 60;
/** inputs must sit on receive/change index 0..19 of the account's xpubs */
export const INVOICE_ADDRESS_COUNT = 20;
/** how many recent merchant-address transactions find-payment looks at */
export const FIND_PAYMENT_LIMIT = 50;
/** merchant history (and its transactions) is reused this long by GET re-checks */
export const HISTORY_CACHE_SECONDS = 20;
/** GET re-checks run at most one fresh history rescan per invoice this often */
export const RESCAN_THROTTLE_SECONDS = 20;
const RESCAN_MAP_MAX = 1000;
/** an unpaid invoice whose inputs were spent elsewhere is given up (dead) this long after expiry */
export const DEAD_GRACE_SECONDS = 10 * 60;
/** sane USD/BCH range; outside it the price feed is broken and nothing is sold */
export const MIN_PRICE_USD = 10;
export const MAX_PRICE_USD = 100_000;
/** after an accepted broadcast, look the tx up this many times, this far apart */
const LOOKUP_TRIES = 3;
const LOOKUP_WAIT_MS = 1000;
/** before a new invoice: earlier unpaid invoices younger than this are checked for an on-chain payment */
const PAID_CHECK_SECONDS = 24 * 3600;
const PAID_CHECK_MAX = 3;
const MAX_TX_HEX = 30_000;
const PRO_SECONDS = PRO_PASS_DAYS * 86_400;
const TXID = /^[0-9a-f]{64}$/;
const OP_RETURN = 0x6a;

/** an Electrum call failed (connect, timeout, transport) → 503 chain_unavailable */
export class ChainUnavailable extends Error {}

export const priceUsable = (p: number) => Number.isFinite(p) && p >= MIN_PRICE_USD && p <= MAX_PRICE_USD;

export type BroadcastClass = "known" | "spent" | "other";

/**
 * Node broadcast rejections (BCHN reject reasons as relayed by Fulcrum; same patterns as cashscript):
 * "known" = this very transaction is already in the mempool / a block; "spent" = an input is missing or
 * already spent (by our own earlier broadcast, or by something else); anything else is a real rejection.
 */
export function classifyBroadcastError(message: string): BroadcastClass {
  const m = message.toLowerCase();
  if (/txn-already-known|txn-already-in-mempool|transaction already in block ?chain|already have transaction/.test(m)) return "known";
  if (/missing inputs|missing-inputs|bad-txns-inputs-missingorspent|bad-txns-inputs-spent|txn-mempool-conflict/.test(m)) return "spent";
  return "other";
}

/** the node's message without raw hex blobs, short enough for an API error */
const nodeMessage = (m: string) => m.replace(/[0-9a-f]{64,}/gi, "…").replace(/\s+/g, " ").trim().slice(0, 300);

export interface InvoiceResult {
  status: 200 | 201 | 400 | 404 | 409 | 502 | 503;
  body: Invoice | ApiError;
}

const err = (status: InvoiceResult["status"], code: string, message: string, extra: { invoiceId?: string } = {}): InvoiceResult => ({
  status,
  body: { error: { code, message, ...extra } },
});
const outKey = (o: Outpoint) => `${o.txid}:${o.vout}`;
const sameSet = (a: Outpoint[], b: Outpoint[]) => {
  if (a.length !== b.length) return false;
  const s = new Set(a.map(outKey));
  return s.size === a.length && b.every((o) => s.has(outKey(o)));
};

/** valid { txid, vout }[] (1..10, lowercase txids) or an error message */
function parseInputs(v: unknown): Outpoint[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_INVOICE_INPUTS) return `inputs must be an array of 1..${MAX_INVOICE_INPUTS} outpoints`;
  const out: Outpoint[] = [];
  for (const x of v) {
    const txid = typeof x?.txid === "string" ? x.txid.toLowerCase() : null;
    const vout = x?.vout;
    if (!txid || !TXID.test(txid) || !Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) return "each input must be { txid: 64 hex, vout: uint32 }";
    out.push({ txid, vout });
  }
  return out;
}

export interface InvoiceDeps {
  db: Db;
  chain: PaymentChain;
  merchantAddress: string;
  /** unix seconds */
  now: () => number;
  /** default setTimeout; injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

/** what a re-check learned about an unpaid invoice */
type Recheck = "paid" | "unspent" | "spent" | "unknown";

export function createInvoices(deps: InvoiceDeps) {
  const { db, chain, now } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const decoded = cashAddressToLockingBytecode(deps.merchantAddress);
  if (typeof decoded === "string") throw new Error(`Invalid merchant address: ${decoded}`);
  const merchantLockHex = binToHex(decoded.bytecode);

  const onChain = async <T>(p: () => Promise<T>): Promise<T> => {
    try {
      return await p();
    } catch (e) {
      throw new ChainUnavailable(e instanceof Error ? e.message : String(e));
    }
  };

  const addressOf = (lockHex: string): string => {
    if (lockHex === merchantLockHex) return deps.merchantAddress;
    const r = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockHex), prefix: "bitcoincash", tokenSupport: true });
    return typeof r === "string" ? lockHex : r.address;
  };
  const statusOf = (r: InvoiceRow) => (r.status === "dead" || (r.status === "open" && r.expiresAt <= now()) ? "expired" : r.status);
  const toApi = (r: InvoiceRow, inputsSpent = false): Invoice => ({
    id: r.id,
    status: statusOf(r),
    asset: "BCH",
    amountSats: r.amountSats,
    merchantAddress: addressOf(r.merchantLockingHex),
    opReturnHex: invoiceOpReturnHex(r.id),
    inputs: r.inputs,
    txid: r.txid,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
    paidAt: r.paidAt !== null ? new Date(r.paidAt * 1000).toISOString() : null,
    ...((inputsSpent || r.status === "dead") && r.status !== "paid" && { inputsSpent: true }),
  });
  const fresh = (id: string): InvoiceRow => {
    const r = db.getInvoice(id);
    if (!r) throw new Error("invoice vanished");
    return r;
  };

  /** does `tx` pay invoice `r`: spends one of its inputs, has exactly one OP_RETURN (its own), pays ≥ amount to its merchant */
  const pays = (tx: TransactionCommon, r: InvoiceRow): boolean => {
    const mine = new Set(r.inputs.map(outKey));
    const lock = hexToBin(r.merchantLockingHex);
    const opReturns = tx.outputs.filter((o) => o.lockingBytecode[0] === OP_RETURN);
    return (
      tx.inputs.some((i) => mine.has(outKey({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }))) &&
      opReturns.length === 1 &&
      binsAreEqual(opReturns[0]!.lockingBytecode, encodeInvoiceOpReturn(r.id)) &&
      tx.outputs.some((o) => binsAreEqual(o.lockingBytecode, lock) && o.valueSatoshis >= BigInt(r.amountSats))
    );
  };

  // merchant history, shared by all requests for HISTORY_CACHE_SECONDS (in-flight scans are shared too)
  const history = new Map<string, { at: number; txs: Promise<Uint8Array[]> }>();
  const recent = (lockHex: string, fresh: boolean): Promise<Uint8Array[]> => {
    const t = now();
    const hit = history.get(lockHex);
    if (!fresh && hit && t - hit.at < HISTORY_CACHE_SECONDS) return hit.txs;
    const txs = onChain(() => chain.recentTransactions(hexToBin(lockHex), FIND_PAYMENT_LIMIT));
    history.set(lockHex, { at: t, txs });
    txs.catch(() => {
      if (history.get(lockHex)?.txs === txs) history.delete(lockHex);
    });
    return txs;
  };

  /**
   * The txid of a transaction on the network that pays `r` (merchant-address history), or null.
   * `fresh` skips the cache: submit and the pre-purchase check must not miss a payment made seconds ago.
   */
  const findPayment = async (r: InvoiceRow, fresh: boolean): Promise<string | null> => {
    for (const bin of await recent(r.merchantLockingHex, fresh)) {
      const tx = decodeTransaction(bin);
      if (typeof tx !== "string" && pays(tx, r)) return hashTransaction(bin);
    }
    return null;
  };

  /** true only if `txid` is now recorded as this invoice's payment */
  const markPaid = (r: InvoiceRow, txid: string): boolean => {
    db.markInvoicePaid(r.id, txid, now(), PRO_SECONDS);
    const after = fresh(r.id);
    return after.status === "paid" && after.txid === txid;
  };

  /** past expiry + grace and spent elsewhere (after a fresh scan): give it up for good */
  const maybeDead = (r: InvoiceRow) => {
    if (now() > r.expiresAt + DEAD_GRACE_SECONDS) db.markInvoiceDead(r.id);
  };

  /**
   * Re-check an unpaid invoice: if any input is spent, look for its payment and mark it paid when found.
   * The 20 s history cache is only used to FIND a payment: "spent" (no payment) is always the result of a
   * fresh scan (GET throttles that rescan per invoice → "unknown"). `mayBury`: also mark it dead when hopeless (create/submit only, never GET).
   * Chain failures throw ChainUnavailable.
   */
  const lastRescan = new Map<string, number>();
  /** true (and records it) when a GET may run a fresh rescan for this invoice now */
  const rescanAllowed = (id: string): boolean => {
    const t = now();
    const prev = lastRescan.get(id);
    if (prev !== undefined && t - prev < RESCAN_THROTTLE_SECONDS) return false;
    if (lastRescan.size >= RESCAN_MAP_MAX) {
      for (const [k, v] of lastRescan) if (t - v >= RESCAN_THROTTLE_SECONDS) lastRescan.delete(k);
      while (lastRescan.size >= RESCAN_MAP_MAX) lastRescan.delete(lastRescan.keys().next().value!);
    }
    lastRescan.set(id, t);
    return true;
  };

  const recheck = async (r: InvoiceRow, o: { cached: boolean; mayBury: boolean; throttle?: boolean }): Promise<Recheck> => {
    const outs = await onChain(() => chain.getOutputs(r.inputs));
    if (!outs.some((x) => x !== null && !x.unspent)) return "unspent";
    let txid = o.cached ? await findPayment(r, false) : null;
    if (!txid && o.throttle && !rescanAllowed(r.id)) return "unknown"; // not known yet: the client keeps waiting
    txid ??= await findPayment(r, true);
    if (txid && markPaid(r, txid)) return "paid";
    if (o.mayBury) maybeDead(r);
    return "spent";
  };

  const ownLocks = (a: AccountRow): Set<string> => {
    const s = new Set<string>();
    for (const xpub of [a.xpubReceive, a.xpubChange]) {
      for (let i = 0; i < INVOICE_ADDRESS_COUNT; i++) {
        const l = p2pkhForXpub(xpub, i);
        if (l) s.add(binToHex(l));
      }
    }
    return s;
  };

  /** the tx is on the network: looked up LOOKUP_TRIES times, 1 s apart */
  const lookup = async (txid: string): Promise<boolean> => {
    for (let i = 0; i < LOOKUP_TRIES; i++) {
      if (i > 0) await sleep(LOOKUP_WAIT_MS);
      if ((await onChain(() => chain.getTransaction(txid))) !== null) return true;
    }
    return false;
  };

  return {
    quote(priceUsd: number): InvoiceQuote {
      return {
        asset: "BCH",
        amountSats: proPassSats(priceUsd),
        priceUsd,
        merchantAddress: deps.merchantAddress,
        validUntil: new Date((now() + QUOTE_SECONDS) * 1000).toISOString(),
      };
    },

    async create(a: AccountRow, body: Record<string, unknown> | null, priceUsd: number): Promise<InvoiceResult> {
      if (body?.asset !== "BCH") return err(400, "bad_request", 'Expected { asset: "BCH", inputs }');
      const inputs = parseInputs(body.inputs);
      if (typeof inputs === "string") return err(400, "bad_request", inputs);
      if (new Set(inputs.map(outKey)).size !== inputs.length) return err(400, "duplicate_input", "The same coin is listed twice");
      const amountSats = proPassSats(priceUsd);

      const t = now();
      const isOpen = (r: InvoiceRow) => r.status === "open" && r.expiresAt > t;
      const openSame = () => db.listInvoices(a.id).find((r) => isOpen(r) && sameSet(r.inputs, inputs));
      const existing = openSame();
      if (existing) return { status: 200, body: toApi(existing) };

      // Earlier unpaid invoices: one may have been paid by a broadcast whose submit never arrived
      // (lost tab or storage) → already_paid. An open one whose coins are all unspent can still be
      // paid → 409 invoice_open (reuse it) rather than risk two live invoices.
      const earlier = db
        .listInvoices(a.id)
        .filter((r) => (r.status === "open" || r.status === "expired") && r.createdAt > t - PAID_CHECK_SECONDS)
        .slice(0, PAID_CHECK_MAX);
      for (const r of earlier) {
        let state: Recheck;
        try {
          state = await recheck(r, { cached: false, mayBury: true });
        } catch (e) {
          // fail closed: selling a second pass while the first payment cannot be ruled out could charge twice
          if (!(e instanceof ChainUnavailable)) throw e;
          console.error(`earlier invoice check failed: ${e.message}`);
          return err(503, "chain_unavailable", "Could not verify your earlier payment — please try again in a minute");
        }
        if (state === "paid") {
          const paid = fresh(r.id);
          return err(409, "already_paid", `Already paid ✓ invoice ${paid.id}, txid ${paid.txid}. Your Pro pass is active.`, { invoiceId: paid.id });
        }
        if (state === "unspent" && isOpen(r)) {
          return err(409, "invoice_open", `Invoice ${r.id} is still open with other coins; pay that one (or wait until it expires).`, { invoiceId: r.id });
        }
      }

      // 1. raw outputs: existence, ownership, tokens — before any listunspent
      const outs = await onChain(() => chain.getSourceOutputs(inputs));
      const mine = ownLocks(a);
      let total = 0n;
      for (const [i, o] of outs.entries()) {
        const op = outKey(inputs[i]!);
        if (!o) return err(400, "input_not_found", `Coin ${op} does not exist`);
        if (!mine.has(binToHex(o.lockingBytecode))) {
          return err(400, "foreign_input", `Coin ${op} is not on one of this wallet's first ${INVOICE_ADDRESS_COUNT} receive/change addresses`);
        }
        if (o.token) return err(400, "token_input", `Coin ${op} carries CashTokens; pay with plain BCH coins`);
        total += o.valueSatoshis;
      }
      // 2. spent? only the (owned) scripts involved, each once
      const unspent = await onChain(() => chain.unspentOutpoints(outs.map((o) => o!.lockingBytecode)));
      for (const op of inputs) if (!unspent.has(outKey(op))) return err(400, "input_spent", `Coin ${outKey(op)} is already spent`);
      const need = BigInt(amountSats + estimatePaymentFee(inputs.length));
      if (total < need) return err(400, "insufficient_inputs", `Coins hold ${total} sats; need at least ${need} (price + fee)`);

      // synchronous from here: no other request can interleave
      const raced = openSame();
      if (raced) return { status: 200, body: toApi(raced) };
      // any open invoice left is expired or has spent coins (else we returned invoice_open above)
      for (const r of db.listInvoices(a.id)) if (r.status === "open") db.expireInvoice(r.id);
      const id = randomBytes(16).toString("hex");
      db.insertInvoice({ id, accountId: a.id, asset: "BCH", amountSats, merchantLockingHex: merchantLockHex, inputs, createdAt: t, expiresAt: t + INVOICE_SECONDS });
      return { status: 201, body: toApi(fresh(id)) };
    },

    async get(a: AccountRow, id: string): Promise<InvoiceResult> {
      const r = db.getInvoice(id);
      if (!r || r.accountId !== a.id) return err(404, "not_found", "No such invoice");
      let spent = false;
      if (r.status === "open" || r.status === "expired") {
        try {
          spent = (await recheck(r, { cached: true, mayBury: false, throttle: true })) === "spent";
        } catch (e) {
          // best effort: answer with what we know
          if (!(e instanceof ChainUnavailable)) throw e;
          console.error(`invoice re-check failed: ${e.message}`);
        }
      }
      return { status: 200, body: toApi(fresh(id), spent) };
    },

    async submit(a: AccountRow, id: string, body: Record<string, unknown> | null): Promise<InvoiceResult> {
      const r = db.getInvoice(id);
      if (!r || r.accountId !== a.id) return err(404, "not_found", "No such invoice");
      if (r.status === "paid") return { status: 200, body: toApi(r) };
      // an expired (or dead) invoice is still accepted: the price was fixed and the coins are pinned,
      // so a late payment is one payment, never a second one

      const hex = typeof body?.signedTxHex === "string" ? body.signedTxHex.trim().toLowerCase() : "";
      if (!/^(?:[0-9a-f]{2})+$/.test(hex) || hex.length > MAX_TX_HEX) return err(400, "bad_request", "Expected { signedTxHex }");
      const bin = hexToBin(hex);
      const tx = decodeTransaction(bin);
      if (typeof tx === "string") return err(400, "bad_tx", `Could not decode the transaction: ${tx}`);

      const spends = tx.inputs.map((i) => ({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }));
      if (!sameSet(spends, r.inputs)) return err(400, "wrong_inputs", "The transaction must spend exactly this invoice's inputs");
      const lock = hexToBin(r.merchantLockingHex);
      if (!tx.outputs.some((o) => binsAreEqual(o.lockingBytecode, lock) && o.valueSatoshis >= BigInt(r.amountSats))) {
        return err(400, "underpaid", `No output pays ${r.amountSats} sats to ${addressOf(r.merchantLockingHex)}`);
      }
      const opReturns = tx.outputs.filter((o) => o.lockingBytecode[0] === OP_RETURN);
      if (opReturns.length !== 1 || !binsAreEqual(opReturns[0]!.lockingBytecode, encodeInvoiceOpReturn(r.id))) {
        return err(400, "wrong_op_return", "The transaction needs exactly one OP_RETURN output: this invoice's");
      }
      if (tx.outputs.some((o) => o.token)) return err(400, "token_output", "The payment must not create token outputs");

      const txid = hashTransaction(bin);
      const spentElsewhere = () => err(409, "inputs_spent", "This invoice's coins were spent by another transaction that does not pay it");
      let paidTxid: string | null = null;
      let res;
      try {
        res = await chain.broadcast(hex);
      } catch (e) {
        // transport failure: the transaction may or may not have reached the node
        console.error(`broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
        if (await onChain(() => chain.getTransaction(txid))) paidTxid = txid;
        else throw new ChainUnavailable("broadcast did not complete");
      }
      if (res) {
        const kind = res.ok ? "known" : classifyBroadcastError(res.message);
        if (kind === "spent") {
          paidTxid = await findPayment(r, true);
          if (!paidTxid) {
            maybeDead(r);
            return spentElsewhere();
          }
        } else if (await lookup(txid)) {
          paidTxid = txid;
        } else if (res.ok && res.txid === txid) {
          // the node accepted exactly this fully validated tx; hosts just have not indexed it yet
          paidTxid = txid;
        } else {
          const msg = res.ok ? "the node accepted the transaction but does not return it" : nodeMessage(res.message);
          return err(502, "broadcast_failed", `The network refused the payment: ${msg}`);
        }
      }
      if (!markPaid(r, paidTxid!) && fresh(r.id).status !== "paid") return spentElsewhere();
      return { status: 200, body: toApi(fresh(r.id)) };
    },
  };
}
