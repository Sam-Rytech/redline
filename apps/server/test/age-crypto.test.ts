import { describe, expect, it } from "vitest";
import { checkAge, MIN_AGE } from "../src/age.js";
import { createSecrets } from "../src/crypto.js";

describe("checkAge", () => {
  const today = new Date("2026-11-21T10:00:00Z");
  it("is 13 on the 13th birthday and not the day before", () => {
    expect(MIN_AGE).toBe(13);
    expect(checkAge("2013-11-21", today)).toBe("ok");
    expect(checkAge("2013-11-22", today)).toBe("blocked");
    expect(checkAge("2013-12-01", today)).toBe("blocked");
    expect(checkAge("1990-05-04", today)).toBe("ok");
  });
  it("handles a 29 February birthday", () => {
    expect(checkAge("2012-02-29", new Date("2025-02-28T12:00:00Z"))).toBe("blocked");
    expect(checkAge("2012-02-29", new Date("2025-03-01T12:00:00Z"))).toBe("ok");
  });
  it("rejects malformed, impossible, future and pre-1900 dates", () => {
    for (const bad of ["", "2000-1-1", "01/01/2000", "2000-02-30", "2000-13-01", "2027-01-01", "1899-12-31", 20000101, null, undefined]) {
      expect(checkAge(bad, today)).toBe("invalid");
    }
  });
});

describe("secrets", () => {
  const s = createSecrets("a".repeat(32));
  it("seals session keys so only the same session can read them", () => {
    const sealed = s.seal('{"xpubReceive":"xpub1"}', "session-a");
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("xpub1");
    expect(s.open(sealed, "session-a")).toBe('{"xpubReceive":"xpub1"}');
    expect(s.open(sealed, "session-b")).toBeNull(); // moved to another session
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(s.open(tampered, "session-a")).toBeNull();
    expect(createSecrets("b".repeat(32)).open(sealed, "session-a")).toBeNull(); // another secret
  });
  it("signs the age result so the browser cannot forge it", () => {
    expect(s.readAge(s.signAge("ok"))).toBe("ok");
    expect(s.readAge(s.signAge("blocked"))).toBe("blocked");
    const [, sig] = s.signAge("blocked").split(".");
    expect(s.readAge(`ok.${sig}`)).toBeNull();
    expect(s.readAge("ok")).toBeNull();
    expect(s.readAge(createSecrets("b".repeat(32)).signAge("ok"))).toBeNull();
    expect(s.readAge(undefined)).toBeNull();
  });
});
