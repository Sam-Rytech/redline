import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses defaults", () => {
    expect(parseConfig({})).toEqual({ port: 8787, refreshMs: 60_000, timeoutMs: 30_000, electrumHost: undefined });
  });
  it("reads valid values", () => {
    expect(parseConfig({ PORT: "9000", REFRESH_MS: "10000", REFRESH_TIMEOUT_MS: "1000", ELECTRUM_HOST: "h" })).toEqual({
      port: 9000, refreshMs: 10_000, timeoutMs: 1000, electrumHost: "h",
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
});
