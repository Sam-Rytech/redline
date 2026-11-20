export interface ServerConfig {
  port: number;
  refreshMs: number;
  timeoutMs: number;
  electrumHost: string | undefined;
  /** domain bound into the login OP_RETURN */
  loginDomain: string;
  dbPath: string;
  /**
   * add `Secure` to cookies. Default true (browsers accept Secure cookies on http://localhost);
   * COOKIE_SECURE=false only for plain-http testing on a non-localhost host.
   */
  secureCookies: boolean;
  /** behind a proxy that appends the real client IP to x-forwarded-for (TRUST_PROXY=true|1) */
  trustProxy: boolean;
  /** when set, POSTs must carry exactly this Origin header (PUBLIC_ORIGIN) */
  publicOrigin: string | undefined;
}

const positive = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
};

const text = (v: string | undefined, fallback: string): string => (v === undefined || v.trim() === "" ? fallback : v.trim());

export function parseConfig(env: Record<string, string | undefined>): ServerConfig {
  const origin = env.PUBLIC_ORIGIN?.trim();
  return {
    port: positive(env.PORT, 8787),
    refreshMs: positive(env.REFRESH_MS, 60_000, 5000),
    timeoutMs: positive(env.REFRESH_TIMEOUT_MS, 30_000),
    electrumHost: env.ELECTRUM_HOST || undefined,
    loginDomain: text(env.LOGIN_DOMAIN, "localhost"),
    dbPath: text(env.DB_PATH, "./data/redline.db"),
    secureCookies: env.COOKIE_SECURE?.trim().toLowerCase() !== "false",
    trustProxy: ["true", "1"].includes(env.TRUST_PROXY?.trim().toLowerCase() ?? ""),
    publicOrigin: origin ? origin.replace(/\/+$/, "") : undefined,
  };
}
