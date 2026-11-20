import { describe, expect, it } from "vitest";
import { decodeLoanCommitment, decodePriceCommitment, rawRateToAnnualPct } from "../src/commitment.js";

const REAL = "01000000000000000000000000021200000056045604000000ff7f";

describe("decodeLoanCommitment", () => {
  it("decodes a real mature debt-0 loan", () => {
    expect(decodeLoanCommitment(REAL)).toMatchObject({
      borrowedCents: 0,
      redeemingCents: 0,
      status: "mature",
      lastPeriodInterestPaid: 18,
      currentRateRaw: 1110,
      nextRateRaw: 1110,
      maxRateManager: 0x7fff,
    });
  });
  it("decodes a hand-built 6-byte LE debt", () => {
    // 315000 = 0x04CE78 -> 78 ce 04 00 00 00
    const hex = "01" + "78ce04000000" + "000000000000" + "02" + "12000000" + "a707" + "0000" + "00" + "0000" + "ffff";
    const d = decodeLoanCommitment(hex)!;
    expect(d.borrowedCents).toBe(315000);
    expect(d.currentRateRaw).toBe(1959);
    expect(d.nextRateRaw).toBe(0);
  });
  it("decodes every field at its own offset (all distinct, non-zero)", () => {
    // debt 0x010203040506 LE, redeeming 0x0a0b0c0d0e0f LE, status 2, last 0x11121314 LE,
    // cur 0x2122, next 0x3132, mgr 0x41, min 0x5152, max 0x6162 (all LE)
    const hex = "01" + "060504030201" + "0f0e0d0c0b0a" + "02" + "14131211" + "2221" + "3231" + "41" + "5251" + "6261";
    expect(hex).toHaveLength(54);
    expect(decodeLoanCommitment(hex)).toEqual({
      borrowedCents: 0x010203040506,
      redeemingCents: 0x0a0b0c0d0e0f,
      status: "mature",
      lastPeriodInterestPaid: 0x11121314,
      currentRateRaw: 0x2122,
      nextRateRaw: 0x3132,
      interestManager: 0x41,
      minRateManager: 0x5152,
      maxRateManager: 0x6162,
    });
  });
  it("decodes status 00 and 01", () => {
    expect(decodeLoanCommitment(REAL.slice(0, 26) + "00" + REAL.slice(28))!.status).toBe("new");
    expect(decodeLoanCommitment(REAL.slice(0, 26) + "01" + REAL.slice(28))!.status).toBe("single-period");
  });
  it("rejects bad input", () => {
    expect(decodeLoanCommitment(REAL.slice(0, -2))).toBeNull();
    expect(decodeLoanCommitment("00" + REAL.slice(2))).toBeNull();
    expect(decodeLoanCommitment(REAL.slice(0, 26) + "07" + REAL.slice(28))).toBeNull();
  });
});

describe("rawRateToAnnualPct", () => {
  it("converts", () => {
    expect(rawRateToAnnualPct(32767)).toBe(119.6);
    expect(rawRateToAnnualPct(1959)).toBe(7.15);
    expect(rawRateToAnnualPct(0)).toBe(0);
  });
});

describe("decodePriceCommitment", () => {
  it("decodes the real example", () => {
    expect(decodePriceCommitment("00b0861d00544a0000")).toEqual({ sequence: 1935024, priceUsd: 190.28 });
  });
  it("rejects bad input", () => {
    expect(decodePriceCommitment("00b0861d00544a")).toBeNull();
    expect(decodePriceCommitment("01b0861d00544a0000")).toBeNull();
  });
});
