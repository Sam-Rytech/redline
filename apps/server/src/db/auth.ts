// Data access for accounts, sign-in challenges and sessions (docs/DATABASE.md).
import type { StoredChallenge } from "@redline/wizard-login/server";
import type { Db } from "./open.js";

export interface AccountRow {
  id: string;
  createdAt: number;
  proUntil: number | null;
  ageOk: boolean;
  muted: boolean;
}

export interface SessionRow {
  id: string;
  accountId: string;
  keysEnc: Uint8Array;
  createdAt: number;
  expiresAt: number;
}

export function insertChallenge(db: Db, c: StoredChallenge): void {
  db.prepare(
    `INSERT INTO challenges (nonce, browser_id, outpoint, path, domain, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.nonceHex, c.browserIdHash, `${c.outpoint.txid}:${c.outpoint.vout}`, `${c.path[0]}/${c.path[1]}`, c.domain, c.expiry, c.usedAt);
}

export function getChallenge(db: Db, nonceHex: string): StoredChallenge | null {
  const r = db.prepare("SELECT * FROM challenges WHERE nonce = ?").get(nonceHex) as
    | { nonce: string; browser_id: string; outpoint: string; path: string; domain: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!r) return null;
  const [txid, vout] = r.outpoint.split(":");
  const [pathName, index] = r.path.split("/");
  if (!txid || vout === undefined || pathName !== "receive" || index === undefined) return null;
  return {
    nonceHex: r.nonce,
    browserIdHash: r.browser_id,
    outpoint: { txid, vout: Number(vout) },
    path: ["receive", Number(index)],
    domain: r.domain,
    expiry: r.expires_at,
    usedAt: r.used_at,
  };
}

/** Atomic: true only for the first caller. */
export function markChallengeUsed(db: Db, nonceHex: string, now: number): boolean {
  return Number(db.prepare("UPDATE challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(now, nonceHex).changes) === 1;
}

/** Creates the account on first sign-in; later sign-ins keep its plan and history. */
export function upsertAccount(db: Db, id: string, now: number): void {
  db.prepare(
    `INSERT INTO accounts (id, created_at, pro_until, age_ok, muted) VALUES (?, ?, NULL, 1, 0)
     ON CONFLICT(id) DO UPDATE SET age_ok = 1`,
  ).run(id, now);
}

export function getAccount(db: Db, id: string): AccountRow | null {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | { id: string; created_at: number; pro_until: number | null; age_ok: number; muted: number }
    | undefined;
  return r ? { id: r.id, createdAt: r.created_at, proUntil: r.pro_until, ageOk: r.age_ok === 1, muted: r.muted === 1 } : null;
}

/** Removes the account; foreign keys cascade to sessions, watches, alerts, invoices and Telegram rows. */
export function deleteAccount(db: Db, id: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertSession(db: Db, s: SessionRow): void {
  db.prepare("INSERT INTO sessions (id, account_id, keys_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    s.id, s.accountId, s.keysEnc, s.createdAt, s.expiresAt,
  );
}

export function getSession(db: Db, id: string, now: number): SessionRow | null {
  const r = db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(id, now) as
    | { id: string; account_id: string; keys_enc: Uint8Array; created_at: number; expires_at: number }
    | undefined;
  return r ? { id: r.id, accountId: r.account_id, keysEnc: r.keys_enc, createdAt: r.created_at, expiresAt: r.expires_at } : null;
}

export function deleteSession(db: Db, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function isTelegramLinked(db: Db, accountId: string): boolean {
  return db.prepare("SELECT 1 FROM telegram_chats WHERE account_id = ?").get(accountId) !== undefined;
}
