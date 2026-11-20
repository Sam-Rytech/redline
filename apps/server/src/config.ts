export interface ServerConfig {
  port: number;
  refreshMs: number;
  timeoutMs: number;
  electrumHost: string | undefined;
}

const positive = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
};

export function parseConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    port: positive(env.PORT, 8787),
    refreshMs: positive(env.REFRESH_MS, 60_000, 5000),
    timeoutMs: positive(env.REFRESH_TIMEOUT_MS, 30_000),
    electrumHost: env.ELECTRUM_HOST || undefined,
  };
}
