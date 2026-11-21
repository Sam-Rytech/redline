import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RawLoan } from "@redline/paryon-decoder";
import { applyMigrations, openDatabase as open, MIGRATIONS_DIR, type Db } from "../src/db/open.js";
import { purgeExpired } from "../src/db/retention.js";
import { recordSnapshot } from "../src/db/snapshots.js";
import { backupDatabase } from "../src/db/backup.js";

const dirs: string[] = [];
const opened: Db[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "redline-db-"));
  dirs.push(d);
  return d;
};
// Every database is closed before its folder is removed (Windows keeps open files locked).
const openDatabase = (...args: Parameters<typeof open>): Db => {
  const db = open(...args);
  opened.push(db);
  return db;
};
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tables = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe("openDatabase", () => {
  it("creates every table from DATABASE.md and records the migration", () => {
    const db = openDatabase(":memory:");
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        "accounts", "alerts_sent", "challenges", "invoices", "loan_snapshots", "schema_migrations",
        "sessions", "telegram_chats", "telegram_links", "watches",
      ]),
    );
    const applied = db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
    expect(applied.map((r) => r.name)).toContain("0001_init.sql");
  });

  it("sets WAL, foreign keys and busy timeout on a file database", () => {
    const db = openDatabase(join(tmp(), "nested", "redline.db"));
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
  });

  it("applies each migration once, in order, and never re-runs an applied one", () => {
    const dir = tmp();
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (y INTEGER);");
    const db = openDatabase(":memory:", { migrationsDir: dir });
    expect(tables(db)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(() => applyMigrations(db, dir)).not.toThrow(); // second run is a no-op
    const names = (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("rolls back a failing migration completely", () => {
    const dir = tmp();
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ok (x INTEGER);");
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE half (x INTEGER); THIS IS NOT SQL;");
    expect(() => openDatabase(":memory:", { migrationsDir: dir })).toThrow();
    const db = openDatabase(":memory:", { migrationsDir: (() => {
      const d = tmp();
      writeFileSync(join(d, "0001_ok.sql"), "CREATE TABLE ok (x INTEGER);");
      return d;
    })() });
    expect(tables(db)).not.toContain("half");
  });

  it("enforces foreign keys: deleting an account removes its sessions and watches", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, created_at, age_ok) VALUES ('acc', 1, 1)").run();
    db.prepare("INSERT INTO sessions (id, account_id, keys_enc, created_at, expires_at) VALUES ('s', 'acc', x'00', 1, 2)").run();
    db.prepare("INSERT INTO watches (id, account_id, loan_id, rules_json, created_at) VALUES ('w', 'acc', 'l', '{}', 1)").run();
    db.prepare("DELETE FROM accounts WHERE id = 'acc'").run();
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM watches").get()).toEqual({ n: 0 });
  });

  it("ships the real migrations directory with the package", () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain("0001_init.sql");
  });
});

describe("purgeExpired", () => {
  const DAY = 86_400;
  it("removes expired sessions and challenges, used or expired link tokens, old alerts and old snapshots", () => {
    const db = openDatabase(":memory:");
    const now = 100 * DAY;
    db.prepare("INSERT INTO accounts (id, created_at, age_ok) VALUES ('acc', 1, 1)").run();
    const s = db.prepare("INSERT INTO sessions (id, account_id, keys_enc, created_at, expires_at) VALUES (?, 'acc', x'00', 1, ?)");
    s.run("old", now - 1);
    s.run("live", now + 60);
    const c = db.prepare(
      "INSERT INTO challenges (nonce, browser_id, outpoint, path, domain, expires_at, used_at) VALUES (?, 'b', 'tx:0', 'receive/0', 'd', ?, ?)",
    );
    c.run("expired", now - 3700, null); // expired more than an hour ago
    c.run("used", now + 200, now - 3700); // used more than an hour ago
    c.run("fresh", now + 200, null);
    const t = db.prepare("INSERT INTO telegram_links (token_hash, account_id, expires_at, used_at) VALUES (?, 'acc', ?, ?)");
    t.run("t-old", now - 1, null);
    t.run("t-used", now + 600, now - 10);
    t.run("t-live", now + 600, null);
    db.prepare("INSERT INTO watches (id, account_id, loan_id, rules_json, created_at) VALUES ('w', 'acc', 'l', '{}', 1)").run();
    const a = db.prepare("INSERT INTO alerts_sent (id, watch_id, rule, band, arming, sent_at) VALUES (?, 'w', 'liquidation', 'danger', ?, ?)");
    a.run("a-old", 1, now - 91 * DAY);
    a.run("a-new", 2, now - 89 * DAY);
    // 30 days of blocks is 30 x 144 = 4320 below the newest snapshot
    const snap = db.prepare(
      "INSERT INTO loan_snapshots (block_height, loan_id, debt_cents, collateral_sats, rate_raw, next_rate_raw, redeeming_cents, status) VALUES (?, 'l', 1, 1, 1, 1, 0, 'mature')",
    );
    snap.run(10_000 - 4321);
    snap.run(10_000 - 4320);
    snap.run(10_000);

    purgeExpired(db, now);

    const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id);
    expect(ids("SELECT id FROM sessions")).toEqual(["live"]);
    expect(ids("SELECT nonce AS id FROM challenges ORDER BY nonce")).toEqual(["fresh"]);
    expect(ids("SELECT token_hash AS id FROM telegram_links")).toEqual(["t-live"]);
    expect(ids("SELECT id FROM alerts_sent")).toEqual(["a-new"]);
    expect(ids("SELECT CAST(block_height AS TEXT) AS id FROM loan_snapshots ORDER BY block_height")).toEqual(["5680", "10000"]);
  });
});

describe("recordSnapshot", () => {
  const loan = (id: string, over: Partial<RawLoan> = {}): RawLoan => ({
    id, status: "mature", debtPusd: 3150, collateralSats: 1898581599, rateRaw: 1959, nextRateRaw: 0,
    amountBeingRedeemedPusd: 5.5, ...over,
  });
  it("writes one row per loan per block, in integer units, and ignores a repeat of the same block", () => {
    const db = openDatabase(":memory:");
    expect(recordSnapshot(db, { blockHeight: 978300, loans: [loan("a"), loan("b", { debtPusd: 0.01 })] })).toBe(2);
    expect(recordSnapshot(db, { blockHeight: 978300, loans: [loan("a")] })).toBe(0);
    const rows = db.prepare("SELECT * FROM loan_snapshots ORDER BY loan_id").all();
    expect(rows).toEqual([
      { block_height: 978300, loan_id: "a", debt_cents: 315000, collateral_sats: 1898581599, rate_raw: 1959, next_rate_raw: 0, redeeming_cents: 550, status: "mature" },
      { block_height: 978300, loan_id: "b", debt_cents: 1, collateral_sats: 1898581599, rate_raw: 1959, next_rate_raw: 0, redeeming_cents: 550, status: "mature" },
    ]);
  });
});

describe("backupDatabase", () => {
  it("writes a dated copy that opens with the same data and keeps only the newest 7", () => {
    const dir = tmp();
    const db = openDatabase(join(dir, "redline.db"));
    db.prepare("INSERT INTO accounts (id, created_at, age_ok) VALUES ('acc', 1, 1)").run();
    const out = join(dir, "backups");
    mkdirSync(out);
    for (let d = 1; d <= 8; d++) writeFileSync(join(out, `redline-2026-11-0${d}.db`), "old");
    return backupDatabase(db, out, new Date("2026-11-21T03:00:00Z")).then((file) => {
      expect(file).toBe(join(out, "redline-2026-11-21.db"));
      const copy = openDatabase(file, { migrationsDir: null });
      expect(copy.prepare("SELECT id FROM accounts").all()).toEqual([{ id: "acc" }]);
      copy.close();
      const left = readdirSync(out).sort();
      expect(left).toHaveLength(7);
      expect(left.at(-1)).toBe("redline-2026-11-21.db");
      expect(left).not.toContain("redline-2026-11-01.db");
    });
  });
});
