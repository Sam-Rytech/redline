import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup } from "node:sqlite";
import type { Db } from "./open.js";

const KEEP = 7;
const NAME = /^redline-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Copies the live database to `<dir>/redline-YYYY-MM-DD.db` with SQLite's online backup, then
 * keeps only the newest 7 copies. Returns the file written.
 */
export async function backupDatabase(db: Db, dir: string, now = new Date()): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `redline-${now.toISOString().slice(0, 10)}.db`);
  rmSync(file, { force: true });
  await backup(db, file);
  const copies = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - KEEP))) rmSync(join(dir, old), { force: true });
  return file;
}

/** Backs up once a day. Returns a stop function. */
export function startBackups(db: Db, dir: string, log: (m: string) => void = console.log): () => void {
  const tick = () => {
    backupDatabase(db, dir).then(
      (f) => log(`database backup written: ${f}`),
      (e: unknown) => log(`database backup failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  const timer = setInterval(tick, 24 * 3600 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
