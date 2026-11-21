// Data access for watches (docs/DATABASE.md).
import type { RiskBand, Watch, WatchRules } from "@redline/api-types";
import type { Db } from "./open.js";

/** A watch's alert state. "gone" marks a loan already reported closed. */
export type WatchBand = RiskBand | "gone";

export interface WatchRow {
  id: string;
  accountId: string;
  loanId: string;
  rules: WatchRules;
  lastBand: WatchBand | null;
  missedReads: number;
  createdAt: number;
}

export const DEFAULT_RULES: WatchRules = { liquidation: true, loanGone: true };

interface Raw {
  id: string;
  account_id: string;
  loan_id: string;
  rules_json: string;
  last_band: string | null;
  missed_reads: number;
  created_at: number;
}

const fromRaw = (r: Raw): WatchRow => {
  let rules = DEFAULT_RULES;
  try {
    rules = { ...DEFAULT_RULES, ...(JSON.parse(r.rules_json) as Partial<WatchRules>) };
  } catch {
    // a malformed row keeps the defaults
  }
  return {
    id: r.id,
    accountId: r.account_id,
    loanId: r.loan_id,
    rules,
    lastBand: r.last_band as WatchBand | null,
    missedReads: r.missed_reads,
    createdAt: r.created_at,
  };
};

/** The API shape. "gone" is internal bookkeeping; the API only knows risk bands. */
export const toWatch = (w: WatchRow): Watch => ({
  id: w.id,
  loanId: w.loanId,
  rules: w.rules,
  lastBand: w.lastBand === "gone" ? null : w.lastBand,
  createdAt: new Date(w.createdAt * 1000).toISOString(),
});

export function listWatches(db: Db, accountId: string): WatchRow[] {
  return (db.prepare("SELECT * FROM watches WHERE account_id = ? ORDER BY created_at, id").all(accountId) as unknown as Raw[]).map(fromRaw);
}

export function allWatches(db: Db): WatchRow[] {
  return (db.prepare("SELECT * FROM watches ORDER BY created_at, id").all() as unknown as Raw[]).map(fromRaw);
}

export function getWatch(db: Db, accountId: string, id: string): WatchRow | null {
  const r = db.prepare("SELECT * FROM watches WHERE id = ? AND account_id = ?").get(id, accountId) as Raw | undefined;
  return r ? fromRaw(r) : null;
}

export function countWatches(db: Db, accountId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM watches WHERE account_id = ?").get(accountId) as { n: number }).n;
}

/** false when the account already watches this loan (UNIQUE account_id, loan_id). */
export function insertWatch(db: Db, w: { id: string; accountId: string; loanId: string; rules: WatchRules; createdAt: number }): boolean {
  try {
    db.prepare(
      "INSERT INTO watches (id, account_id, loan_id, rules_json, last_band, missed_reads, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)",
    ).run(w.id, w.accountId, w.loanId, JSON.stringify(w.rules), w.createdAt);
    return true;
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return false;
    throw e;
  }
}

export function updateWatchRules(db: Db, accountId: string, id: string, rules: WatchRules): void {
  db.prepare("UPDATE watches SET rules_json = ? WHERE id = ? AND account_id = ?").run(JSON.stringify(rules), id, accountId);
}

export function deleteWatch(db: Db, accountId: string, id: string): boolean {
  return Number(db.prepare("DELETE FROM watches WHERE id = ? AND account_id = ?").run(id, accountId).changes) === 1;
}

export function setWatchState(db: Db, id: string, lastBand: WatchBand | null, missedReads: number): void {
  db.prepare("UPDATE watches SET last_band = ?, missed_reads = ? WHERE id = ?").run(lastBand, missedReads, id);
}
