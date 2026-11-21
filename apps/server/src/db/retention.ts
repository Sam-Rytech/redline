import type { Db } from "./open.js";

const HOUR = 3600;
const DAY = 86_400;
/** About 144 blocks a day, so 30 days of snapshots is 4320 blocks. */
export const SNAPSHOT_KEEP_BLOCKS = 30 * 144;

/**
 * Deletes data past its retention period (docs/DATABASE.md "Retention"). Returns the number of
 * rows removed per table.
 */
export function purgeExpired(db: Db, now: number): Record<string, number> {
  const removed: Record<string, number> = {};
  const run = (table: string, sql: string, ...params: number[]) => {
    removed[table] = Number(db.prepare(sql).run(...params).changes);
  };
  run("sessions", "DELETE FROM sessions WHERE expires_at <= ?", now);
  run(
    "challenges",
    "DELETE FROM challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
    now - HOUR,
    now - HOUR,
  );
  run("telegram_links", "DELETE FROM telegram_links WHERE expires_at <= ? OR used_at IS NOT NULL", now);
  run("alerts_sent", "DELETE FROM alerts_sent WHERE sent_at < ?", now - 90 * DAY);
  const top = (db.prepare("SELECT MAX(block_height) AS h FROM loan_snapshots").get() as { h: number | null }).h;
  if (top !== null) {
    run("loan_snapshots", "DELETE FROM loan_snapshots WHERE block_height < ?", top - SNAPSHOT_KEEP_BLOCKS);
  }
  return removed;
}

/** Runs purgeExpired now and every hour. Returns a stop function. */
export function startRetention(db: Db, log: (m: string) => void = console.log): () => void {
  const tick = () => {
    try {
      purgeExpired(db, Math.floor(Date.now() / 1000));
    } catch (e) {
      log(`retention purge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  tick();
  const timer = setInterval(tick, HOUR * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
