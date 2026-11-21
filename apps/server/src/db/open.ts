import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** apps/server/migrations, resolved from this file so it works from any working directory. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/**
 * Opens the database, applies the pragmas from docs/DATABASE.md and runs pending migrations.
 * Pass `migrationsDir: null` to open without migrating (e.g. reading a backup).
 */
export function openDatabase(path: string, opts: { migrationsDir?: string | null } = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const dir = opts.migrationsDir === undefined ? MIGRATIONS_DIR : opts.migrationsDir;
  if (dir !== null) {
    try {
      applyMigrations(db, dir);
    } catch (e) {
      db.close();
      throw e;
    }
  }
  return db;
}

/**
 * Applies every `NNNN_name.sql` file in `dir` that is not yet in schema_migrations, in name
 * order, each inside its own transaction. Applied files are never re-run.
 */
export function applyMigrations(db: Db, dir: string, now = () => Math.floor(Date.now() / 1000)): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push(file);
  }
  return applied;
}
