// Data access for Telegram linking and per-account mute (docs/DATABASE.md, docs/SECURITY.md "Telegram").
import type { Db } from "./open.js";

export function insertLinkToken(db: Db, tokenHash: string, accountId: string, expiresAt: number): void {
  db.prepare("INSERT INTO telegram_links (token_hash, account_id, expires_at, used_at) VALUES (?, ?, ?, NULL)").run(tokenHash, accountId, expiresAt);
}

/** Atomic single use: the account the token belongs to, or null if unknown, used or expired. */
export function consumeLinkToken(db: Db, tokenHash: string, now: number): string | null {
  const r = db
    .prepare("UPDATE telegram_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id")
    .get(now, tokenHash, now) as { account_id: string } | undefined;
  return r?.account_id ?? null;
}

/**
 * Links `chatId` to the account. One chat per account and one account per chat: the chat moves
 * to this account (it presented this account's token) and the account's previous chat is replaced.
 */
export function linkChat(db: Db, accountId: string, chatId: string, now: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM telegram_chats WHERE chat_id = ? OR account_id = ?").run(chatId, accountId);
    db.prepare("INSERT INTO telegram_chats (account_id, chat_id, linked_at) VALUES (?, ?, ?)").run(accountId, chatId, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function unlinkAccount(db: Db, accountId: string): void {
  db.prepare("DELETE FROM telegram_chats WHERE account_id = ?").run(accountId);
}

export function accountForChat(db: Db, chatId: string): string | null {
  return (db.prepare("SELECT account_id FROM telegram_chats WHERE chat_id = ?").get(chatId) as { account_id: string } | undefined)?.account_id ?? null;
}

export function setMuted(db: Db, accountId: string, muted: boolean): void {
  db.prepare("UPDATE accounts SET muted = ? WHERE id = ?").run(muted ? 1 : 0, accountId);
}

export function isMuted(db: Db, accountId: string): boolean {
  return (db.prepare("SELECT muted FROM accounts WHERE id = ?").get(accountId) as { muted: number } | undefined)?.muted === 1;
}
