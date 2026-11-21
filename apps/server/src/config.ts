import { randomBytes } from "node:crypto";
import { cashAddressToLockingBytecode } from "@bitauth/libauth";

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
  /** domain the login transaction's OP_RETURN must carry (the web app's host) */
  loginDomain: string;
  /** the only Origin allowed on state-changing requests (docs/SECURITY.md CSRF rule) */
  publicOrigin: string;
  /** how many proxies append to x-forwarded-for in front of us; 0 = use the TCP peer */
  trustProxyHops: number;
  /**
   * Header the front proxy sets to the visitor's IP (Vercel: x-real-ip; Vercel does not always
   * overwrite a value the visitor sent, so peerIpHeader is the backstop). Used as the per-visitor
   * rate-limit key; empty = use trustProxyHops.
   */
  clientIpHeader: string | undefined;
  /**
   * Header the host's edge sets to whoever connected to it (Fly: fly-client-ip). That connection
   * gets a looser cap too, so a request that skips the front proxy and fakes clientIpHeader is
   * still limited by its real address.
   */
  peerIpHeader: string | undefined;
  /** log the raw x-forwarded-for of the first 5 /api/auth requests, to set trustProxyHops */
  logXff: boolean;
  /** Telegram bot token from @BotFather; alerts and linking are off when unset. Never logged. */
  telegramBotToken: string | undefined;
  /** where Pro pass payments go: a mainnet bitcoincash: address (token-aware z... preferred); payments are off when unset */
  merchantAddress: string | undefined;
  production: boolean;
  /** Non-fatal problems to log at start-up. */
  warnings: string[];
}

const MIN_SECRET_LENGTH = 32;

function parseMerchant(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const d = v.startsWith("bitcoincash:") ? cashAddressToLockingBytecode(v) : "missing the bitcoincash: prefix";
  if (typeof d === "string") throw new Error(`MERCHANT_ADDRESS must be a mainnet bitcoincash: address (${d})`);
  return v;
}

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

  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  if (publicOrigin === "" && production) throw new Error("PUBLIC_ORIGIN is required in production");
  if (publicOrigin !== "" && !/^https?:\/\/[^/\s]+$/.test(publicOrigin)) {
    throw new Error("PUBLIC_ORIGIN must be an origin like https://redline.example (no path)");
  }

  const hops = env.TRUST_PROXY_HOPS ?? "";
  if (hops !== "" && !/^\d+$/.test(hops)) throw new Error("TRUST_PROXY_HOPS must be a whole number (0 or more)");
  const headerName = (name: string, v: string | undefined): string | undefined => {
    if (!v) return undefined;
    if (!/^[A-Za-z0-9-]+$/.test(v)) throw new Error(`${name} must be a header name like x-real-ip`);
    return v.toLowerCase();
  };

  return {
    port: positive(env.PORT, 8787),
    refreshMs: positive(env.REFRESH_MS, 60_000, 5000),
    timeoutMs: positive(env.REFRESH_TIMEOUT_MS, 30_000),
    electrumHost: env.ELECTRUM_HOST || undefined,
    databasePath: env.DATABASE_PATH || "./data/redline.db",
    sessionSecret,
    backupDir: env.BACKUP_DIR || undefined,
    loginDomain: env.LOGIN_DOMAIN || "localhost",
    publicOrigin: publicOrigin || "http://localhost:5173",
    trustProxyHops: hops === "" ? 0 : Number(hops),
    clientIpHeader: headerName("CLIENT_IP_HEADER", env.CLIENT_IP_HEADER),
    peerIpHeader: headerName("PEER_IP_HEADER", env.PEER_IP_HEADER),
    logXff: env.LOG_XFF === "1",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    merchantAddress: parseMerchant(env.MERCHANT_ADDRESS),
    production,
    warnings,
  };
}
