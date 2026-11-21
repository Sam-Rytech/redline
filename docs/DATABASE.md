# Redline database

SQLite through `better-sqlite3`, one file on the server's persistent volume (`DATABASE_PATH`).
This replaces the sketch in `ARCHITECTURE.md` section 4; where they differ, this file wins.

Why SQLite: one always-on server, a few hundred rows of real state, no second process to
run. The chain itself is the source of truth for loans; the database holds only what chain
data cannot: who is watching what, sessions, invoices and alert history.

## Rules

- Migrations are numbered SQL files in `apps/server/migrations/` (`0001_init.sql`, ...),
  applied in order at start-up inside a transaction, recorded in `schema_migrations`. Applied
  files are never edited; a change is a new file.
- `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Timestamps are unix seconds (integers), UTC. IDs generated server side are 128 bit random,
  hex.
- No xpub, signed transaction hex, or full birth date is ever stored (`SECURITY.md`).
- Backups: nightly copy of the file using SQLite's online backup, kept 7 days, on a separate
  volume or storage.

## Tables

```sql
CREATE TABLE schema_migrations (
  name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
);

-- One row per wallet. No keys here.
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,          -- sha256(xpubReceive), hex
  created_at  INTEGER NOT NULL,
  pro_until   INTEGER,                   -- null = free
  age_ok      INTEGER NOT NULL CHECK (age_ok IN (0,1)),  -- result only, never the date
  muted       INTEGER NOT NULL DEFAULT 0
);

-- Single-use sign-in challenges. Purged after 1 hour.
CREATE TABLE challenges (
  nonce       TEXT PRIMARY KEY,          -- 16 bytes hex
  browser_id  TEXT NOT NULL,             -- value of the rl_ch cookie
  outpoint    TEXT NOT NULL,             -- txid:vout
  path        TEXT NOT NULL,             -- e.g. receive/3
  domain      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Holds the wallet's xpubs for the life of the session only.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- random; the cookie holds this
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  keys_enc    BLOB NOT NULL,             -- xpubs, encrypted with a key from SESSION_SECRET
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE telegram_links (
  token_hash  TEXT PRIMARY KEY,          -- sha256 of the one-time token
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE telegram_chats (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  chat_id     TEXT NOT NULL UNIQUE,      -- personal data
  linked_at   INTEGER NOT NULL
);

CREATE TABLE watches (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  loan_id       TEXT NOT NULL,           -- loanTokenId
  rules_json    TEXT NOT NULL,           -- {"liquidation":true,"loanGone":true}
  last_band     TEXT,                    -- safe | watch | danger | critical
  missed_reads  INTEGER NOT NULL DEFAULT 0,  -- consecutive reads without the loan
  created_at    INTEGER NOT NULL,
  UNIQUE (account_id, loan_id)           -- backs the 409 watch_exists
);

-- Idempotency for alerts: the same watch, rule and band is only ever sent once per arming.
CREATE TABLE alerts_sent (
  id          TEXT PRIMARY KEY,
  watch_id    TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  band        TEXT NOT NULL,
  arming      INTEGER NOT NULL,          -- increments each time the rule re-arms
  value       REAL,
  sent_at     INTEGER NOT NULL,
  UNIQUE (watch_id, rule, band, arming)
);

CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset       TEXT NOT NULL CHECK (asset = 'BCH'),
  amount_sats INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,             -- outpoints reused on retry
  txid        TEXT UNIQUE,               -- one payment cannot activate two invoices
  status      TEXT NOT NULL CHECK (status IN ('open','paid','expired')),
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER
);

-- History for the loans screen and for debugging alerts. Keep 30 days.
CREATE TABLE loan_snapshots (
  block_height  INTEGER NOT NULL,
  loan_id       TEXT NOT NULL,
  debt_cents    INTEGER NOT NULL,
  collateral_sats INTEGER NOT NULL,
  rate_raw      INTEGER NOT NULL,
  next_rate_raw INTEGER NOT NULL,
  redeeming_cents INTEGER NOT NULL,
  status        TEXT NOT NULL,
  PRIMARY KEY (block_height, loan_id)
);
```

## Changes from the sketch in ARCHITECTURE.md

| Change | Reason |
|---|---|
| `accounts` has no `xpub_receive` or `xpub_change` | data minimisation; xpubs live only in `sessions.keys_enc` |
| `challenges.browser_id` added | binds a challenge to the browser that asked (relay attack) |
| `accounts.age_ok` added | age screen stores the result only |
| `telegram_links` stores a hash, not the token | a database leak cannot be used to link a chat |
| `watches.missed_reads` added | "loan gone" needs 3 consecutive misses |
| `alerts_sent.band`, `arming`, unique key | alerts cannot repeat after a restart |
| `invoices.txid` unique | one payment cannot activate two invoices |

## Retention

| Data | Kept |
|---|---|
| Expired sessions, used or expired challenges | purged hourly |
| Telegram link tokens | purged after expiry |
| `alerts_sent` | 90 days |
| `loan_snapshots` | 30 days (about 20,000 rows a day at current size) |
| Account and everything under it | until `DELETE /api/me` |
