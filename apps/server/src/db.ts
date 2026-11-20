// SQLite persistence via Node's built-in node:sqlite. (Node prints a one-line
// ExperimentalWarning the first time it is loaded; harmless.)
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredChallenge } from "@redline/wizard-login/server";

export interface AccountRow {
  id: string;
  xpubReceive: string;
  xpubChange: string;
  createdAt: number;
  proUntil: number | null;
}

export interface Db {
  insertChallenge(c: StoredChallenge): void;
  getChallenge(nonceHex: string): StoredChallenge | null;
  /** atomic: true only for the first caller */
  markChallengeUsed(nonceHex: string, now: number): boolean;
  /** delete challenges and sessions whose expiry has passed */
  purgeExpired(now: number): void;
  upsertAccount(a: { id: string; xpubReceive: string; xpubChange: string; now: number }): void;
  getAccount(id: string): AccountRow | null;
  setProUntil(id: string, proUntil: number | null): void;
  createSession(id: string, accountId: string, expiresAt: number): void;
  /** null when missing or expired (expires_at <= now) */
  getSession(id: string, now: number): { accountId: string } | null;
  deleteSession(id: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, xpub_receive TEXT, xpub_change TEXT, created_at INTEGER, pro_until INTEGER
);
CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY, outpoint_txid TEXT, outpoint_vout INTEGER, path_name TEXT, path_index INTEGER,
  xpub_receive TEXT, xpub_change TEXT, domain TEXT, expiry INTEGER, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT, expires_at INTEGER);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const q = {
    insertChallenge: db.prepare(
      `INSERT INTO challenges (nonce, outpoint_txid, outpoint_vout, path_name, path_index, xpub_receive, xpub_change, domain, expiry, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getChallenge: db.prepare(`SELECT * FROM challenges WHERE nonce = ?`),
    markUsed: db.prepare(`UPDATE challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL`),
    purgeChallenges: db.prepare(`DELETE FROM challenges WHERE expiry < ?`),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),
    upsertAccount: db.prepare(
      `INSERT INTO accounts (id, xpub_receive, xpub_change, created_at, pro_until) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET xpub_receive = excluded.xpub_receive, xpub_change = excluded.xpub_change`,
    ),
    getAccount: db.prepare(`SELECT * FROM accounts WHERE id = ?`),
    setProUntil: db.prepare(`UPDATE accounts SET pro_until = ? WHERE id = ?`),
    createSession: db.prepare(`INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)`),
    getSession: db.prepare(`SELECT account_id FROM sessions WHERE id = ? AND expires_at > ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
  };

  return {
    insertChallenge(c) {
      q.insertChallenge.run(
        c.nonceHex, c.outpoint.txid, c.outpoint.vout, c.path[0], c.path[1],
        c.xpubReceive, c.xpubChange, c.domain, c.expiry, c.usedAt,
      );
    },
    getChallenge(nonceHex) {
      const r = q.getChallenge.get(nonceHex) as Row | undefined;
      if (!r) return null;
      const pathName = str(r.path_name);
      if (pathName !== "receive" && pathName !== "change") return null;
      return {
        nonceHex: str(r.nonce),
        expiry: num(r.expiry),
        domain: str(r.domain),
        outpoint: { txid: str(r.outpoint_txid), vout: num(r.outpoint_vout) },
        path: [pathName, num(r.path_index)],
        xpubReceive: str(r.xpub_receive),
        xpubChange: str(r.xpub_change),
        usedAt: r.used_at === null ? null : num(r.used_at),
      };
    },
    markChallengeUsed(nonceHex, now) {
      return Number(q.markUsed.run(now, nonceHex).changes) === 1;
    },
    purgeExpired(now) {
      q.purgeChallenges.run(now);
      q.purgeSessions.run(now);
    },
    upsertAccount(a) {
      q.upsertAccount.run(a.id, a.xpubReceive, a.xpubChange, a.now);
    },
    getAccount(id) {
      const r = q.getAccount.get(id) as Row | undefined;
      if (!r) return null;
      return {
        id: str(r.id),
        xpubReceive: str(r.xpub_receive),
        xpubChange: str(r.xpub_change),
        createdAt: num(r.created_at),
        proUntil: r.pro_until === null ? null : num(r.pro_until),
      };
    },
    setProUntil(id, proUntil) {
      q.setProUntil.run(proUntil, id);
    },
    createSession(id, accountId, expiresAt) {
      q.createSession.run(id, accountId, expiresAt);
    },
    getSession(id, now) {
      const r = q.getSession.get(id, now) as Row | undefined;
      return r ? { accountId: str(r.account_id) } : null;
    },
    deleteSession(id) {
      q.deleteSession.run(id);
    },
    close() {
      db.close();
    },
  };
}
