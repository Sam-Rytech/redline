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
  /**
   * Number of trusted proxy hops in front of the server (TRUST_PROXY_HOPS, default 0).
   * 0: client IP = socket address. N>0: the Nth entry from the RIGHT of x-forwarded-for.
   * Legacy TRUST_PROXY=true|1 means 1 hop.
   */
  trustProxyHops: number;
  /** LOG_XFF=1: log the raw x-forwarded-for of the first 5 /api/auth requests (to verify the hop count) */
  logXff: boolean;
  /** when set, POSTs must carry exactly this Origin header (PUBLIC_ORIGIN) */
  publicOrigin: string | undefined;
  /** TELEGRAM_BOT_TOKEN from @BotFather; the bot and alerts run only when set. Never log it. */
  telegramBotToken: string | undefined;
  /** BOT_USERNAME (without @); when unset the bot asks Telegram (getMe) at startup */
  botUsername: string | undefined;
}

const positive = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
};

const text = (v: string | undefined, fallback: string): string => (v === undefined || v.trim() === "" ? fallback : v.trim());

function parseHops(env: Record<string, string | undefined>): number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (raw !== undefined && raw !== "") {
    if (!/^\d+$/.test(raw)) throw new Error(`TRUST_PROXY_HOPS must be an integer >= 0, got "${raw}"`);
    return Number(raw);
  }
  return ["true", "1"].includes(env.TRUST_PROXY?.trim().toLowerCase() ?? "") ? 1 : 0;
}

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
    trustProxyHops: parseHops(env),
    logXff: ["1", "true"].includes(env.LOG_XFF?.trim().toLowerCase() ?? ""),
    publicOrigin: origin ? origin.replace(/\/+$/, "") : undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    botUsername: env.BOT_USERNAME?.trim().replace(/^@/, "") || undefined,
  };
}
