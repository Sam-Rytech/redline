import { randomBytes } from "node:crypto";

export interface ServerConfig {
  port: number;
  refreshMs: number;
  timeoutMs: number;
  electrumHost: string | undefined;
  /** SQLite file (docs/DATABASE.md). ":memory:" is allowed for tests. */
  databasePath: string;
  /** Key material for encrypting session data. At least 32 characters. */
  sessionSecret: string;
  /** Where nightly backups go; backups are off when unset. */
  backupDir: string | undefined;
  production: boolean;
  /** Non-fatal problems to log at start-up. */
  warnings: string[];
}

const MIN_SECRET_LENGTH = 32;

const positive = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
};

export function parseConfig(env: Record<string, string | undefined>): ServerConfig {
  const production = env.NODE_ENV === "production";
  const warnings: string[] = [];

  let sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret === "") {
    if (production) throw new Error("SESSION_SECRET is required in production");
    sessionSecret = randomBytes(32).toString("hex");
    warnings.push("SESSION_SECRET is not set; using a random one, so sessions end when the server restarts");
  } else if (sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  return {
    port: positive(env.PORT, 8787),
    refreshMs: positive(env.REFRESH_MS, 60_000, 5000),
    timeoutMs: positive(env.REFRESH_TIMEOUT_MS, 30_000),
    electrumHost: env.ELECTRUM_HOST || undefined,
    databasePath: env.DATABASE_PATH || "./data/redline.db",
    sessionSecret,
    backupDir: env.BACKUP_DIR || undefined,
    production,
    warnings,
  };
}
