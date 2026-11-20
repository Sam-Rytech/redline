import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses defaults", () => {
    expect(parseConfig({})).toEqual({
      port: 8787, refreshMs: 60_000, timeoutMs: 30_000, electrumHost: undefined,
      loginDomain: "localhost", dbPath: "./data/redline.db", secureCookies: true, trustProxy: false, publicOrigin: undefined,
    });
  });
  it("reads valid values", () => {
    expect(
      parseConfig({
        PORT: "9000", REFRESH_MS: "10000", REFRESH_TIMEOUT_MS: "1000", ELECTRUM_HOST: "h",
        LOGIN_DOMAIN: "redline.app", DB_PATH: "/var/lib/redline.db", COOKIE_SECURE: "false", TRUST_PROXY: "true",
        PUBLIC_ORIGIN: "https://redline.app",
      }),
    ).toEqual({
      port: 9000, refreshMs: 10_000, timeoutMs: 1000, electrumHost: "h",
      loginDomain: "redline.app", dbPath: "/var/lib/redline.db", secureCookies: false, trustProxy: true,
      publicOrigin: "https://redline.app",
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
  it("cookies are Secure unless COOKIE_SECURE=false; TRUST_PROXY only when true/1", () => {
    expect(parseConfig({ NODE_ENV: "development" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "true" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "0" }).secureCookies).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: "false" }).secureCookies).toBe(false);
    expect(parseConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(parseConfig({ TRUST_PROXY: "yes" }).trustProxy).toBe(false);
  });
  it("PUBLIC_ORIGIN is trimmed of a trailing slash; blank strings fall back", () => {
    expect(parseConfig({ PUBLIC_ORIGIN: "https://redline.app/" }).publicOrigin).toBe("https://redline.app");
    expect(parseConfig({ PUBLIC_ORIGIN: " " }).publicOrigin).toBeUndefined();
    expect(parseConfig({ LOGIN_DOMAIN: " ", DB_PATH: "" })).toMatchObject({ loginDomain: "localhost", dbPath: "./data/redline.db" });
  });
});
