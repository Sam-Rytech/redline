export interface ServerConfig {
  port: number;
  refreshMs: number;
  timeoutMs: number;
  electrumHost: string | undefined;
  /** domain bound into the login OP_RETURN */
  loginDomain: string;
  dbPath: string;
  /** add `Secure` to the session cookie (NODE_ENV=production) */
  secureCookies: boolean;
}

const positive = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
};

const text = (v: string | undefined, fallback: string): string => (v === undefined || v.trim() === "" ? fallback : v.trim());

export function parseConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    port: positive(env.PORT, 8787),
    refreshMs: positive(env.REFRESH_MS, 60_000, 5000),
    timeoutMs: positive(env.REFRESH_TIMEOUT_MS, 30_000),
    electrumHost: env.ELECTRUM_HOST || undefined,
    loginDomain: text(env.LOGIN_DOMAIN, "localhost"),
    dbPath: text(env.DB_PATH, "./data/redline.db"),
    secureCookies: env.NODE_ENV === "production",
  };
}
