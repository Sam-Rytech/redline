// Data access for Pro pass invoices (docs/DATABASE.md table `invoices` plus migration 0002).
import type { InvoiceStatus, Outpoint } from "@redline/api-types";
import type { Db } from "./open.js";

/** "dead" = stored as status 'expired' with abandoned = 1: coins spent elsewhere, no payment found, never rechecked */
export type StoredInvoiceStatus = InvoiceStatus | "dead";

export interface InvoiceRow {
  /** 16 random bytes, hex */
  id: string;
  accountId: string;
  asset: "BCH";
  amountSats: number;
  /** where the payment must go (fixed at creation, so a later MERCHANT_ADDRESS change cannot break it) */
  merchantLockingHex: string;
  /** the inputs the paying transaction must spend, exactly */
  inputs: Outpoint[];
  txid: string | null;
  /** as stored; an "open" row past expiresAt is expired in the API */
  status: StoredInvoiceStatus;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
}

/** The operations the payment logic needs; `invoiceStore(db)` implements them on SQLite. */
export interface InvoiceStore {
  insertInvoice(i: Omit<InvoiceRow, "txid" | "status" | "paidAt">): void;
  getInvoice(id: string): InvoiceRow | null;
  /** newest first */
  listInvoices(accountId: string): InvoiceRow[];
  /** open → expired; false if it was not open */
  expireInvoice(id: string): boolean;
  /** open or expired → abandoned (never rechecked); false otherwise */
  markInvoiceDead(id: string): boolean;
  /**
   * Atomic: mark a not-yet-paid invoice paid and extend its account's Pro to
   * max(now, pro_until) + proSeconds. False when it was already paid, or when `txid` already paid
   * another invoice (then it is not this invoice's payment).
   */
  markInvoicePaid(id: string, txid: string, paidAt: number, proSeconds: number): boolean;
}

interface Raw {
  id: string;
  account_id: string;
  asset: string;
  amount_sats: number;
  inputs_json: string;
  txid: string | null;
  status: string;
  created_at: number;
  paid_at: number | null;
  merchant_locking_hex: string;
  expires_at: number;
  abandoned: number;
}

const fromRaw = (r: Raw): InvoiceRow => {
  let inputs: Outpoint[] = [];
  try {
    inputs = JSON.parse(r.inputs_json) as Outpoint[];
  } catch {
    // a malformed row can never match a payment
  }
  const status: StoredInvoiceStatus =
    r.status === "paid" ? "paid" : r.abandoned === 1 ? "dead" : r.status === "open" ? "open" : "expired";
  return {
    id: r.id,
    accountId: r.account_id,
    asset: "BCH",
    amountSats: r.amount_sats,
    merchantLockingHex: r.merchant_locking_hex,
    inputs,
    txid: r.txid,
    status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    paidAt: r.paid_at,
  };
};

export function invoiceStore(db: Db): InvoiceStore {
  return {
    insertInvoice(i) {
      db.prepare(
        `INSERT INTO invoices (id, account_id, asset, amount_sats, inputs_json, txid, status, created_at, paid_at, merchant_locking_hex, expires_at, abandoned)
         VALUES (?, ?, 'BCH', ?, ?, NULL, 'open', ?, NULL, ?, ?, 0)`,
      ).run(i.id, i.accountId, i.amountSats, JSON.stringify(i.inputs), i.createdAt, i.merchantLockingHex, i.expiresAt);
    },
    getInvoice(id) {
      const r = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Raw | undefined;
      return r ? fromRaw(r) : null;
    },
    listInvoices(accountId) {
      return (db.prepare("SELECT * FROM invoices WHERE account_id = ? ORDER BY created_at DESC, rowid DESC").all(accountId) as unknown as Raw[]).map(fromRaw);
    },
    expireInvoice(id) {
      return Number(db.prepare("UPDATE invoices SET status = 'expired' WHERE id = ? AND status = 'open'").run(id).changes) === 1;
    },
    markInvoiceDead(id) {
      return (
        Number(
          db.prepare("UPDATE invoices SET status = 'expired', abandoned = 1 WHERE id = ? AND status IN ('open', 'expired') AND abandoned = 0").run(id).changes,
        ) === 1
      );
    },
    markInvoicePaid(id, txid, paidAt, proSeconds) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM invoices WHERE txid = ? AND id <> ?").get(txid, id)) {
          db.exec("ROLLBACK");
          return false;
        }
        const paid = db
          .prepare("UPDATE invoices SET status = 'paid', txid = ?, paid_at = ?, abandoned = 0 WHERE id = ? AND status <> 'paid' RETURNING account_id")
          .get(txid, paidAt, id) as { account_id: string } | undefined;
        if (!paid) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("UPDATE accounts SET pro_until = max(coalesce(pro_until, 0), ?) + ? WHERE id = ?").run(paidAt, proSeconds, paid.account_id);
        db.exec("COMMIT");
        return true;
      } catch (e) {
        db.exec("ROLLBACK");
        if (e instanceof Error && /UNIQUE/i.test(e.message)) return false;
        throw e;
      }
    },
  };
}
