import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const SECRET = "x".repeat(32);

describe("parseConfig", () => {
  it("uses defaults outside production", () => {
    const c = parseConfig({});
    expect(c).toMatchObject({
      port: 8787,
      refreshMs: 60_000,
      timeoutMs: 30_000,
      electrumHost: undefined,
      databasePath: "./data/redline.db",
      backupDir: undefined,
      loginDomain: "localhost",
      publicOrigin: "http://localhost:5173",
      trustProxyHops: 0,
      logXff: false,
      production: false,
    });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(c.warnings.join(" ")).toMatch(/SESSION_SECRET/);
  });
  it("reads valid values", () => {
    expect(
      parseConfig({
        PORT: "9000", REFRESH_MS: "10000", REFRESH_TIMEOUT_MS: "1000", ELECTRUM_HOST: "h",
        DATABASE_PATH: "/data/redline.db", SESSION_SECRET: SECRET, BACKUP_DIR: "/backups",
      }),
    ).toMatchObject({
      port: 9000, refreshMs: 10_000, timeoutMs: 1000, electrumHost: "h",
      databasePath: "/data/redline.db", sessionSecret: SECRET, backupDir: "/backups", warnings: [],
    });
  });
  it("falls back on non-finite or non-positive values", () => {
    const c = parseConfig({ PORT: "abc", REFRESH_MS: "-5", REFRESH_TIMEOUT_MS: "0" });
    expect(c).toMatchObject({ port: 8787, refreshMs: 60_000, timeoutMs: 30_000 });
    expect(parseConfig({ PORT: "Infinity" }).port).toBe(8787);
  });
  it("enforces REFRESH_MS >= 5000", () => {
    expect(parseConfig({ REFRESH_MS: "1000" }).refreshMs).toBe(60_000);
    expect(parseConfig({ REFRESH_MS: "5000" }).refreshMs).toBe(5000);
  });
  it("requires a SESSION_SECRET of at least 32 characters and PUBLIC_ORIGIN in production", () => {
    const prod = { NODE_ENV: "production", PUBLIC_ORIGIN: "https://redline.example" };
    expect(() => parseConfig({ ...prod })).toThrow(/SESSION_SECRET/);
    expect(() => parseConfig({ ...prod, SESSION_SECRET: "short" })).toThrow(/32/);
    expect(() => parseConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET })).toThrow(/PUBLIC_ORIGIN/);
    expect(parseConfig({ ...prod, SESSION_SECRET: SECRET })).toMatchObject({
      production: true, publicOrigin: "https://redline.example", warnings: [],
    });
  });
  it("reads the sign-in settings", () => {
    expect(
      parseConfig({ LOGIN_DOMAIN: "redline.example", PUBLIC_ORIGIN: "https://redline.example", TRUST_PROXY_HOPS: "2", LOG_XFF: "1" }),
    ).toMatchObject({ loginDomain: "redline.example", publicOrigin: "https://redline.example", trustProxyHops: 2, logXff: true });
  });
  it("rejects a malformed PUBLIC_ORIGIN or TRUST_PROXY_HOPS", () => {
    expect(() => parseConfig({ PUBLIC_ORIGIN: "https://redline.example/app" })).toThrow(/origin/);
    for (const v of ["-1", "1.5", "abc"]) expect(() => parseConfig({ TRUST_PROXY_HOPS: v })).toThrow(/TRUST_PROXY_HOPS/);
  });
  it("rejects a short SESSION_SECRET outside production too", () => {
    expect(() => parseConfig({ SESSION_SECRET: "short" })).toThrow(/32/);
  });
});
