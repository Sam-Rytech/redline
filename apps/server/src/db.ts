// SQLite persistence via Node's built-in node:sqlite. (Node prints a one-line
// ExperimentalWarning the first time it is loaded; harmless.)
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InvoiceStatus, Outpoint, RiskBand, WatchRules } from "@redline/api-types";
import type { StoredChallenge } from "@redline/wizard-login/server";

export interface AccountRow {
  id: string;
  xpubReceive: string;
  xpubChange: string;
  createdAt: number;
  proUntil: number | null;
}

/** a watch's last evaluated state: a risk band, or "gone" once the loan disappeared */
export type StoredBand = RiskBand | "gone";

export interface WatchRow {
  id: string;
  accountId: string;
  loanId: string;
  rules: WatchRules;
  lastBand: StoredBand | null;
  mutedUntil: number | null;
  createdAt: number;
}

export interface TelegramChatRow {
  accountId: string;
  chatId: string;
  linkedAt: number;
  mutedUntil: number | null;
}

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
  /** as stored: an "open" row past expiresAt is expired in the API */
  status: InvoiceStatus;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
}

export interface Db {
  insertChallenge(c: StoredChallenge): void;
  getChallenge(nonceHex: string): StoredChallenge | null;
  /** atomic: true only for the first caller */
  markChallengeUsed(nonceHex: string, now: number): boolean;
  /** delete challenges, sessions and Telegram link tokens whose expiry has passed */
  purgeExpired(now: number): void;
  upsertAccount(a: { id: string; xpubReceive: string; xpubChange: string; now: number }): void;
  getAccount(id: string): AccountRow | null;
  setProUntil(id: string, proUntil: number | null): void;
  createSession(id: string, accountId: string, expiresAt: number): void;
  /** null when missing or expired (expires_at <= now) */
  getSession(id: string, now: number): { accountId: string } | null;
  deleteSession(id: string): void;

  /** false when the account already watches that loan */
  insertWatch(w: { id: string; accountId: string; loanId: string; rules: WatchRules; createdAt: number }): boolean;
  getWatch(id: string): WatchRow | null;
  listWatches(accountId: string): WatchRow[];
  countWatches(accountId: string): number;
  allWatches(): WatchRow[];
  /** owner only; false when no such watch for that account */
  updateWatchRules(id: string, accountId: string, rules: WatchRules): boolean;
  deleteWatch(id: string, accountId: string): boolean;
  setWatchBand(id: string, band: StoredBand | null): void;

  insertLinkToken(tokenHash: string, accountId: string, createdAt: number, expiresAt: number): void;
  /** atomic: the account id for a valid (unexpired, unused) token, marking it used; else null */
  consumeLinkToken(tokenHash: string, now: number): string | null;
  /** one chat per account and one account per chat */
  linkTelegramChat(accountId: string, chatId: string, now: number): void;
  getTelegramChat(accountId: string): TelegramChatRow | null;
  accountForChat(chatId: string): string | null;
  setChatMute(chatId: string, mutedUntil: number | null): void;
  unlinkTelegram(accountId: string): boolean;

  insertInvoice(i: Omit<InvoiceRow, "txid" | "status" | "paidAt">): void;
  getInvoice(id: string): InvoiceRow | null;
  /** newest first */
  listInvoices(accountId: string): InvoiceRow[];
  /** open → expired; false when it was not open */
  expireInvoice(id: string): boolean;
  /**
   * Atomic: mark a not-yet-paid invoice paid and extend its account's Pro to
   * max(paidAt, pro_until) + proSeconds. False (and nothing changes) when it was already paid.
   * Throws when `txid` already paid another invoice.
   */
  markInvoicePaid(id: string, txid: string, paidAt: number, proSeconds: number): boolean;

  recordAlert(watchId: string, rule: string, value: string, sentAt: number): void;
  alertsFor(watchId: string): Array<{ watchId: string; rule: string; value: string; sentAt: number }>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, xpub_receive TEXT, xpub_change TEXT, created_at INTEGER, pro_until INTEGER
);
CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY, outpoint_txid TEXT, outpoint_vout INTEGER, path_name TEXT, path_index INTEGER,
  xpub_receive TEXT, xpub_change TEXT, domain TEXT, expiry INTEGER, used_at INTEGER, binding_hash TEXT
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY, account_id TEXT, loan_id TEXT, rule_liquidation INTEGER, rule_loan_gone INTEGER,
  last_band TEXT NULL, muted_until INTEGER NULL, created_at INTEGER, UNIQUE(account_id, loan_id)
);
CREATE TABLE IF NOT EXISTS telegram_links (
  token_hash TEXT PRIMARY KEY, account_id TEXT, created_at INTEGER, expires_at INTEGER, used_at INTEGER NULL
);
CREATE TABLE IF NOT EXISTS telegram_chats (
  account_id TEXT PRIMARY KEY, chat_id TEXT, linked_at INTEGER, muted_until INTEGER NULL
);
CREATE INDEX IF NOT EXISTS telegram_chats_chat ON telegram_chats(chat_id);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, account_id TEXT, asset TEXT, amount_sats INTEGER, merchant_locking_hex TEXT, inputs_json TEXT,
  txid TEXT NULL UNIQUE, status TEXT, created_at INTEGER, expires_at INTEGER, paid_at INTEGER NULL
);
CREATE INDEX IF NOT EXISTS invoices_account ON invoices(account_id, created_at);
CREATE TABLE IF NOT EXISTS alerts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT, rule TEXT, value TEXT, sent_at INTEGER
);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const BANDS: ReadonlySet<string> = new Set(["safe", "watch", "danger", "critical", "gone"]);

const toWatch = (r: Row): WatchRow => ({
  id: str(r.id),
  accountId: str(r.account_id),
  loanId: str(r.loan_id),
  rules: { liquidation: num(r.rule_liquidation) === 1, loanGone: num(r.rule_loan_gone) === 1 },
  lastBand: typeof r.last_band === "string" && BANDS.has(r.last_band) ? (r.last_band as StoredBand) : null,
  mutedUntil: numOrNull(r.muted_until),
  createdAt: num(r.created_at),
});

const STATUSES: ReadonlySet<string> = new Set(["open", "paid", "expired"]);

const toInvoice = (r: Row): InvoiceRow => {
  const inputs = JSON.parse(str(r.inputs_json)) as Outpoint[];
  return {
    id: str(r.id),
    accountId: str(r.account_id),
    asset: "BCH",
    amountSats: num(r.amount_sats),
    merchantLockingHex: str(r.merchant_locking_hex),
    inputs: inputs.map((o) => ({ txid: String(o.txid), vout: Number(o.vout) })),
    txid: r.txid === null || r.txid === undefined ? null : str(r.txid),
    status: STATUSES.has(str(r.status)) ? (str(r.status) as InvoiceStatus) : "expired",
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    paidAt: numOrNull(r.paid_at),
  };
};

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // databases created before challenge binding lack the column
  const cols = (db.prepare("PRAGMA table_info(challenges)").all() as Row[]).map((r) => String(r.name));
  if (!cols.includes("binding_hash")) db.exec("ALTER TABLE challenges ADD COLUMN binding_hash TEXT");

  const q = {
    insertChallenge: db.prepare(
      `INSERT INTO challenges (nonce, outpoint_txid, outpoint_vout, path_name, path_index, xpub_receive, xpub_change, domain, expiry, used_at, binding_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getChallenge: db.prepare(`SELECT * FROM challenges WHERE nonce = ?`),
    markUsed: db.prepare(`UPDATE challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL`),
    purgeChallenges: db.prepare(`DELETE FROM challenges WHERE expiry < ?`),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),
    upsertAccount: db.prepare(
      `INSERT INTO accounts (id, xpub_receive, xpub_change, created_at, pro_until) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET xpub_change = excluded.xpub_change`,
    ),
    getAccount: db.prepare(`SELECT * FROM accounts WHERE id = ?`),
    setProUntil: db.prepare(`UPDATE accounts SET pro_until = ? WHERE id = ?`),
    createSession: db.prepare(`INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)`),
    getSession: db.prepare(`SELECT account_id FROM sessions WHERE id = ? AND expires_at > ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
    insertWatch: db.prepare(
      `INSERT INTO watches (id, account_id, loan_id, rule_liquidation, rule_loan_gone, last_band, muted_until, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?) ON CONFLICT(account_id, loan_id) DO NOTHING`,
    ),
    getWatch: db.prepare(`SELECT * FROM watches WHERE id = ?`),
    listWatches: db.prepare(`SELECT * FROM watches WHERE account_id = ? ORDER BY created_at, rowid`),
    countWatches: db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE account_id = ?`),
    allWatches: db.prepare(`SELECT * FROM watches ORDER BY created_at, rowid`),
    updateRules: db.prepare(`UPDATE watches SET rule_liquidation = ?, rule_loan_gone = ? WHERE id = ? AND account_id = ?`),
    deleteWatch: db.prepare(`DELETE FROM watches WHERE id = ? AND account_id = ?`),
    setBand: db.prepare(`UPDATE watches SET last_band = ? WHERE id = ?`),
    insertLink: db.prepare(
      `INSERT INTO telegram_links (token_hash, account_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)`,
    ),
    consumeLink: db.prepare(
      `UPDATE telegram_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id`,
    ),
    purgeLinks: db.prepare(`DELETE FROM telegram_links WHERE expires_at <= ?`),
    deleteOtherChat: db.prepare(`DELETE FROM telegram_chats WHERE chat_id = ? AND account_id <> ?`),
    upsertChat: db.prepare(
      `INSERT INTO telegram_chats (account_id, chat_id, linked_at, muted_until) VALUES (?, ?, ?, NULL)
       ON CONFLICT(account_id) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at, muted_until = NULL`,
    ),
    getChat: db.prepare(`SELECT * FROM telegram_chats WHERE account_id = ?`),
    chatAccount: db.prepare(`SELECT account_id FROM telegram_chats WHERE chat_id = ?`),
    setChatMute: db.prepare(`UPDATE telegram_chats SET muted_until = ? WHERE chat_id = ?`),
    deleteChat: db.prepare(`DELETE FROM telegram_chats WHERE account_id = ?`),
    insertInvoice: db.prepare(
      `INSERT INTO invoices (id, account_id, asset, amount_sats, merchant_locking_hex, inputs_json, txid, status, created_at, expires_at, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, NULL)`,
    ),
    getInvoice: db.prepare(`SELECT * FROM invoices WHERE id = ?`),
    listInvoices: db.prepare(`SELECT * FROM invoices WHERE account_id = ? ORDER BY created_at DESC, rowid DESC`),
    expireInvoice: db.prepare(`UPDATE invoices SET status = 'expired' WHERE id = ? AND status = 'open'`),
    payInvoice: db.prepare(
      `UPDATE invoices SET status = 'paid', txid = ?, paid_at = ? WHERE id = ? AND status <> 'paid' RETURNING account_id`,
    ),
    extendPro: db.prepare(`UPDATE accounts SET pro_until = MAX(?, COALESCE(pro_until, 0)) + ? WHERE id = ?`),
    recordAlert: db.prepare(`INSERT INTO alerts_sent (watch_id, rule, value, sent_at) VALUES (?, ?, ?, ?)`),
    alertsFor: db.prepare(`SELECT * FROM alerts_sent WHERE watch_id = ? ORDER BY id`),
  };

  return {
    insertChallenge(c) {
      q.insertChallenge.run(
        c.nonceHex, c.outpoint.txid, c.outpoint.vout, c.path[0], c.path[1],
        c.xpubReceive, c.xpubChange, c.domain, c.expiry, c.usedAt, c.bindingHash,
      );
    },
    getChallenge(nonceHex) {
      const r = q.getChallenge.get(nonceHex) as Row | undefined;
      if (!r) return null;
      // sign-in only ever proves the receive xpub; anything else (legacy rows) is unusable
      if (str(r.path_name) !== "receive" || typeof r.binding_hash !== "string") return null;
      return {
        nonceHex: str(r.nonce),
        expiry: num(r.expiry),
        domain: str(r.domain),
        outpoint: { txid: str(r.outpoint_txid), vout: num(r.outpoint_vout) },
        path: ["receive", num(r.path_index)],
        xpubReceive: str(r.xpub_receive),
        xpubChange: str(r.xpub_change),
        bindingHash: r.binding_hash,
        usedAt: r.used_at === null ? null : num(r.used_at),
      };
    },
    markChallengeUsed(nonceHex, now) {
      return Number(q.markUsed.run(now, nonceHex).changes) === 1;
    },
    purgeExpired(now) {
      q.purgeChallenges.run(now);
      q.purgeSessions.run(now);
      q.purgeLinks.run(now);
    },
    upsertAccount(a) {
      // the account id is sha256(xpub_receive), so an existing row can never legitimately differ
      const existing = q.getAccount.get(a.id) as Row | undefined;
      if (existing && str(existing.xpub_receive) !== a.xpubReceive) throw new Error("account xpub_receive mismatch");
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
    insertWatch(w) {
      const r = q.insertWatch.run(w.id, w.accountId, w.loanId, w.rules.liquidation ? 1 : 0, w.rules.loanGone ? 1 : 0, w.createdAt);
      return Number(r.changes) === 1;
    },
    getWatch(id) {
      const r = q.getWatch.get(id) as Row | undefined;
      return r ? toWatch(r) : null;
    },
    listWatches(accountId) {
      return (q.listWatches.all(accountId) as Row[]).map(toWatch);
    },
    countWatches(accountId) {
      return num((q.countWatches.get(accountId) as Row).n);
    },
    allWatches() {
      return (q.allWatches.all() as Row[]).map(toWatch);
    },
    updateWatchRules(id, accountId, rules) {
      return Number(q.updateRules.run(rules.liquidation ? 1 : 0, rules.loanGone ? 1 : 0, id, accountId).changes) === 1;
    },
    deleteWatch(id, accountId) {
      return Number(q.deleteWatch.run(id, accountId).changes) === 1;
    },
    setWatchBand(id, band) {
      q.setBand.run(band, id);
    },
    insertLinkToken(tokenHash, accountId, createdAt, expiresAt) {
      q.insertLink.run(tokenHash, accountId, createdAt, expiresAt);
    },
    consumeLinkToken(tokenHash, now) {
      const r = q.consumeLink.get(now, tokenHash, now) as Row | undefined;
      return r ? str(r.account_id) : null;
    },
    linkTelegramChat(accountId, chatId, now) {
      db.exec("BEGIN");
      try {
        q.deleteOtherChat.run(chatId, accountId);
        q.upsertChat.run(accountId, chatId, now);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getTelegramChat(accountId) {
      const r = q.getChat.get(accountId) as Row | undefined;
      return r
        ? { accountId: str(r.account_id), chatId: str(r.chat_id), linkedAt: num(r.linked_at), mutedUntil: numOrNull(r.muted_until) }
        : null;
    },
    accountForChat(chatId) {
      const r = q.chatAccount.get(chatId) as Row | undefined;
      return r ? str(r.account_id) : null;
    },
    setChatMute(chatId, mutedUntil) {
      q.setChatMute.run(mutedUntil, chatId);
    },
    unlinkTelegram(accountId) {
      return Number(q.deleteChat.run(accountId).changes) === 1;
    },
    insertInvoice(i) {
      q.insertInvoice.run(i.id, i.accountId, i.asset, i.amountSats, i.merchantLockingHex, JSON.stringify(i.inputs), i.createdAt, i.expiresAt);
    },
    getInvoice(id) {
      const r = q.getInvoice.get(id) as Row | undefined;
      return r ? toInvoice(r) : null;
    },
    listInvoices(accountId) {
      return (q.listInvoices.all(accountId) as Row[]).map(toInvoice);
    },
    expireInvoice(id) {
      return Number(q.expireInvoice.run(id).changes) === 1;
    },
    markInvoicePaid(id, txid, paidAt, proSeconds) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = q.payInvoice.get(txid, paidAt, id) as Row | undefined;
        if (r) q.extendPro.run(paidAt, proSeconds, str(r.account_id));
        db.exec("COMMIT");
        return r !== undefined;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordAlert(watchId, rule, value, sentAt) {
      q.recordAlert.run(watchId, rule, value, sentAt);
    },
    alertsFor(watchId) {
      return (q.alertsFor.all(watchId) as Row[]).map((r) => ({
        watchId: str(r.watch_id),
        rule: str(r.rule),
        value: str(r.value),
        sentAt: num(r.sent_at),
      }));
    },
    close() {
      db.close();
    },
  };
}
