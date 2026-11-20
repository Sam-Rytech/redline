import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses defaults", () => {
    expect(parseConfig({})).toEqual({
      port: 8787, refreshMs: 60_000, timeoutMs: 30_000, electrumHost: undefined,
      loginDomain: "localhost", dbPath: "./data/redline.db", secureCookies: true, trustProxyHops: 0, logXff: false, publicOrigin: undefined,
      telegramBotToken: undefined, botUsername: undefined,
    });
  });
  it("reads valid values", () => {
    expect(
      parseConfig({
        PORT: "9000", REFRESH_MS: "10000", REFRESH_TIMEOUT_MS: "1000", ELECTRUM_HOST: "h",
        LOGIN_DOMAIN: "redline.app", DB_PATH: "/var/lib/redline.db", COOKIE_SECURE: "false", TRUST_PROXY_HOPS: "2", LOG_XFF: "1",
        PUBLIC_ORIGIN: "https://redline.app", TELEGRAM_BOT_TOKEN: " 123:abc ", BOT_USERNAME: "@RedlineBot",
      }),
    ).toEqual({
      port: 9000, refreshMs: 10_000, timeoutMs: 1000, electrumHost: "h",
      loginDomain: "redline.app", dbPath: "/var/lib/redline.db", secureCookies: false, trustProxyHops: 2, logXff: true,
      publicOrigin: "https://redline.app", telegramBotToken: "123:abc", botUsername: "RedlineBot",
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
  it("cookies are Secure unless COOKIE_SECURE=false", () => {
    expect(parseConfig({ NODE_ENV: "development" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "true" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "0" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "false" }).secureCookies).toBe(false);
  });
  it("TRUST_PROXY_HOPS is an integer >= 0 (default 0); legacy TRUST_PROXY=true|1 means 1 hop", () => {
    expect(parseConfig({}).trustProxyHops).toBe(0);
    expect(parseConfig({ TRUST_PROXY_HOPS: "0" }).trustProxyHops).toBe(0);
    expect(parseConfig({ TRUST_PROXY_HOPS: " 3 " }).trustProxyHops).toBe(3);
    expect(parseConfig({ TRUST_PROXY: "true" }).trustProxyHops).toBe(1);
    expect(parseConfig({ TRUST_PROXY: "1" }).trustProxyHops).toBe(1);
    expect(parseConfig({ TRUST_PROXY: "yes" }).trustProxyHops).toBe(0);
    expect(parseConfig({ TRUST_PROXY: "false" }).trustProxyHops).toBe(0);
    expect(parseConfig({ TRUST_PROXY: "true", TRUST_PROXY_HOPS: "2" }).trustProxyHops).toBe(2);
    expect(parseConfig({ TRUST_PROXY: "true", TRUST_PROXY_HOPS: "" }).trustProxyHops).toBe(1);
  });
  it("rejects an invalid TRUST_PROXY_HOPS instead of silently trusting nothing", () => {
    for (const bad of ["-1", "1.5", "abc", "true", "1e2"]) {
      expect(() => parseConfig({ TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });
  it("LOG_XFF is on only for 1/true", () => {
    expect(parseConfig({ LOG_XFF: "1" }).logXff).toBe(true);
    expect(parseConfig({ LOG_XFF: "true" }).logXff).toBe(true);
    expect(parseConfig({ LOG_XFF: "0" }).logXff).toBe(false);
    expect(parseConfig({}).logXff).toBe(false);
  });
  it("PUBLIC_ORIGIN is trimmed of a trailing slash; blank strings fall back", () => {
    expect(parseConfig({ PUBLIC_ORIGIN: "https://redline.app/" }).publicOrigin).toBe("https://redline.app");
    expect(parseConfig({ PUBLIC_ORIGIN: " " }).publicOrigin).toBeUndefined();
    expect(parseConfig({ LOGIN_DOMAIN: " ", DB_PATH: "" })).toMatchObject({ loginDomain: "localhost", dbPath: "./data/redline.db" });
  });
  it("MERCHANT_ADDRESS: a mainnet cashaddr (z/q/p/r), trimmed; anything else throws", () => {
    const z = "bitcoincash:zq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygyzxn9ta6";
    const q = "bitcoincash:qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygrg4dtdzf";
    const r = "bitcoincash:rqenxvenxvenxvenxvenxvenxvenxvenxvr96ydd40";
    expect(parseConfig({ MERCHANT_ADDRESS: ` ${z} ` }).merchantAddress).toBe(z);
    expect(parseConfig({ MERCHANT_ADDRESS: q }).merchantAddress).toBe(q);
    expect(parseConfig({ MERCHANT_ADDRESS: r }).merchantAddress).toBe(r);
    expect(parseConfig({ MERCHANT_ADDRESS: " " }).merchantAddress).toBeUndefined();
    for (const bad of ["zq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygyzxn9ta6", "bitcoincash:zq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygyzxn9ta7", "bchtest:qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygrg4dtdzf", "hello"]) {
      expect(() => parseConfig({ MERCHANT_ADDRESS: bad }), bad).toThrow(/MERCHANT_ADDRESS/);
    }
  });
});
