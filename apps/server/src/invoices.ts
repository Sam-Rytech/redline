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
import { MAX_INVOICE_INPUTS, PAYMENT_FEE_HEADROOM_SATS, encodeInvoiceOpReturn, invoiceOpReturnHex, proPassSats } from "@redline/wizard-login";
import { p2pkhForXpub } from "@redline/wizard-login/server";
import type { AccountRow, Db, InvoiceRow } from "./db.js";
import type { PaymentChain } from "./electrum.js";

export const QUOTE_SECONDS = 5 * 60;
export const INVOICE_SECONDS = 30 * 60;
/** inputs must sit on receive/change index 0..19 of the account's xpubs */
export const INVOICE_ADDRESS_COUNT = 20;
/** how many recent merchant-address transactions find-payment looks at */
export const FIND_PAYMENT_LIMIT = 50;
/** before a new invoice: earlier unpaid invoices younger than this are checked for an on-chain payment */
const PAID_CHECK_SECONDS = 24 * 3600;
const PAID_CHECK_MAX = 3;
const MAX_TX_HEX = 30_000;
const PRO_SECONDS = PRO_PASS_DAYS * 86_400;
const TXID = /^[0-9a-f]{64}$/;
const OP_RETURN = 0x6a;

/** an Electrum call failed (connect, timeout, transport) → 503 chain_unavailable */
export class ChainUnavailable extends Error {}

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

const err = (status: InvoiceResult["status"], code: string, message: string): InvoiceResult => ({ status, body: { error: { code, message } } });
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
}

export function createInvoices(deps: InvoiceDeps) {
  const { db, chain, now } = deps;
  const decoded = cashAddressToLockingBytecode(deps.merchantAddress);
  if (typeof decoded === "string") throw new Error(`Invalid merchant address: ${decoded}`);
  const merchantLock = decoded.bytecode;
  const merchantLockHex = binToHex(merchantLock);

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
  const statusOf = (r: InvoiceRow) => (r.status === "open" && r.expiresAt <= now() ? "expired" : r.status);
  const toApi = (r: InvoiceRow): Invoice => ({
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
  });
  const fresh = (id: string): InvoiceRow => {
    const r = db.getInvoice(id);
    if (!r) throw new Error("invoice vanished");
    return r;
  };

  /** does `tx` pay invoice `r`: spends one of its inputs, carries its OP_RETURN, pays ≥ amount to its merchant */
  const pays = (tx: TransactionCommon, r: InvoiceRow): boolean => {
    const mine = new Set(r.inputs.map(outKey));
    const lock = hexToBin(r.merchantLockingHex);
    const opReturn = encodeInvoiceOpReturn(r.id);
    return (
      tx.inputs.some((i) => mine.has(outKey({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }))) &&
      tx.outputs.some((o) => binsAreEqual(o.lockingBytecode, opReturn)) &&
      tx.outputs.some((o) => binsAreEqual(o.lockingBytecode, lock) && o.valueSatoshis >= BigInt(r.amountSats))
    );
  };

  /** the txid of a transaction on the network that pays `r` (merchant-address history), or null */
  const findPayment = async (r: InvoiceRow): Promise<string | null> => {
    const txs = await onChain(() => chain.recentTransactions(hexToBin(r.merchantLockingHex), FIND_PAYMENT_LIMIT));
    for (const bin of txs) {
      const tx = decodeTransaction(bin);
      if (typeof tx !== "string" && pays(tx, r)) return hashTransaction(bin);
    }
    return null;
  };

  /** if any of an unpaid invoice's inputs is spent, look for its payment; true when it is now paid */
  const reconcile = async (r: InvoiceRow): Promise<boolean> => {
    const outs = await onChain(() => chain.getOutputs(r.inputs));
    if (!outs.some((o) => o !== null && !o.unspent)) return false;
    const txid = await findPayment(r);
    if (!txid) return false;
    db.markInvoicePaid(r.id, txid, now(), PRO_SECONDS);
    return true;
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
      const openSame = () => db.listInvoices(a.id).find((r) => r.status === "open" && r.expiresAt > t && sameSet(r.inputs, inputs));
      const existing = openSame();
      if (existing) return { status: 200, body: toApi(existing) };

      // never sell a second pass by accident: an earlier invoice may have been paid by a broadcast whose
      // submit never arrived (lost tab, lost storage). Its inputs being spent tells us to look.
      const earlier = db
        .listInvoices(a.id)
        .filter((r) => r.status !== "paid" && r.createdAt > t - PAID_CHECK_SECONDS)
        .slice(0, PAID_CHECK_MAX);
      for (const r of earlier) {
        if (await reconcile(r)) {
          const paid = fresh(r.id);
          return err(409, "already_paid", `Already paid ✓ invoice ${paid.id}, txid ${paid.txid}. Your Pro pass is active.`);
        }
      }

      const outs = await onChain(() => chain.getOutputs(inputs));
      const mine = ownLocks(a);
      let total = 0n;
      for (const [i, o] of outs.entries()) {
        const op = `${inputs[i]!.txid}:${inputs[i]!.vout}`;
        if (!o) return err(400, "input_not_found", `Coin ${op} does not exist`);
        if (!mine.has(binToHex(o.output.lockingBytecode))) {
          return err(400, "foreign_input", `Coin ${op} is not on one of this wallet's first ${INVOICE_ADDRESS_COUNT} receive/change addresses`);
        }
        if (o.output.token) return err(400, "token_input", `Coin ${op} carries CashTokens; pay with plain BCH coins`);
        if (!o.unspent) return err(400, "input_spent", `Coin ${op} is already spent`);
        total += o.output.valueSatoshis;
      }
      const need = BigInt(amountSats + PAYMENT_FEE_HEADROOM_SATS);
      if (total < need) return err(400, "insufficient_inputs", `Coins hold ${total} sats; need at least ${need} (price + fee)`);

      // synchronous from here: no other request can interleave
      const raced = openSame();
      if (raced) return { status: 200, body: toApi(raced) };
      for (const r of db.listInvoices(a.id)) if (r.status === "open") db.expireInvoice(r.id);
      const id = randomBytes(16).toString("hex");
      db.insertInvoice({ id, accountId: a.id, asset: "BCH", amountSats, merchantLockingHex: merchantLockHex, inputs, createdAt: t, expiresAt: t + INVOICE_SECONDS });
      return { status: 201, body: toApi(fresh(id)) };
    },

    async get(a: AccountRow, id: string): Promise<InvoiceResult> {
      const r = db.getInvoice(id);
      if (!r || r.accountId !== a.id) return err(404, "not_found", "No such invoice");
      if (r.status !== "paid") {
        try {
          await reconcile(r);
        } catch (e) {
          // best effort: answer with what we know
          if (!(e instanceof ChainUnavailable)) throw e;
          console.error(`invoice re-check failed: ${e.message}`);
        }
      }
      return { status: 200, body: toApi(fresh(id)) };
    },

    async submit(a: AccountRow, id: string, body: Record<string, unknown> | null): Promise<InvoiceResult> {
      const r = db.getInvoice(id);
      if (!r || r.accountId !== a.id) return err(404, "not_found", "No such invoice");
      if (r.status === "paid") return { status: 200, body: toApi(r) };
      // an expired invoice is still accepted: the price was fixed and the coins are pinned, so a late
      // payment is one payment, never a second one

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
      const known = () => onChain(() => chain.getTransaction(txid)).then((t) => t !== null);
      let paidTxid: string | null = null;
      let res;
      try {
        res = await chain.broadcast(hex);
      } catch (e) {
        // transport failure: the transaction may or may not have reached the node
        console.error(`broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
        if (await known()) paidTxid = txid;
        else throw new ChainUnavailable("broadcast did not complete");
      }
      if (res) {
        const kind = res.ok ? "known" : classifyBroadcastError(res.message);
        if (kind === "spent") {
          paidTxid = await findPayment(r);
          if (!paidTxid) return err(409, "inputs_spent", "This invoice's coins were spent by another transaction that does not pay it");
        } else if (await known()) {
          paidTxid = txid;
        } else {
          const msg = res.ok ? "the node accepted the transaction but does not return it" : nodeMessage(res.message);
          return err(502, "broadcast_failed", `The network refused the payment: ${msg}`);
        }
      }
      db.markInvoicePaid(r.id, paidTxid!, now(), PRO_SECONDS);
      return { status: 200, body: toApi(fresh(r.id)) };
    },
  };
}
