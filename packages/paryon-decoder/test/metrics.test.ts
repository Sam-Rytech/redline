import { describe, expect, it } from "vitest";
import { computeLoanViews, riskBand, type RawLoan } from "../src/index.js";

const base: RawLoan = {
  id: "aa",
  status: "mature",
  debtPusd: 1000,
  collateralSats: 2_00000000, // 2 BCH
  interestRatePct: 1,
  nextInterestRatePct: 1,
  amountBeingRedeemedPusd: 0,
};

describe("riskBand", () => {
  it("maps distance to bands", () => {
    expect(riskBand(0.3)).toBe("safe");
    expect(riskBand(0.25)).toBe("safe");
    expect(riskBand(0.2)).toBe("watch");
    expect(riskBand(0.1)).toBe("danger");
    expect(riskBand(0.05)).toBe("critical");
    expect(riskBand(-0.01)).toBe("critical");
    expect(riskBand(null)).toBe("safe");
  });
});

describe("computeLoanViews", () => {
  it("computes CR, liquidation price and distance", () => {
    // 2 BCH × $700 = $1400 collateral, $1000 debt → CR 140%
    const [v] = computeLoanViews([base], 700);
    expect(v!.collateralBch).toBe(2);
    expect(v!.collateralRatioPct).toBeCloseTo(140, 6);
    expect(v!.liquidationPriceUsd).toBeCloseTo(550, 6); // 1000/2*1.1
    expect(v!.distanceToLiquidation).toBeCloseTo(1 - 550 / 700, 6);
    expect(v!.risk).toBe("watch"); // distance 0.214
  });

  it("sums debt ahead from lower-rate loans and small loans, excluding self", () => {
    const loans: RawLoan[] = [
      { ...base, id: "me", interestRatePct: 2, debtPusd: 1000 },
      { ...base, id: "low", interestRatePct: 1, debtPusd: 500 },
      { ...base, id: "high", interestRatePct: 3, debtPusd: 700 },
      { ...base, id: "small", interestRatePct: 5, debtPusd: 50 },
    ];
    const me = computeLoanViews(loans, 700).find((l) => l.id === "me")!;
    expect(me.debtAheadPusd).toBe(550);
  });

  it("flags stranded, redeeming and pending rate change", () => {
    const loans: RawLoan[] = [
      { ...base, id: "s", debtPusd: 0, collateralSats: 5_000_000 },
      { ...base, id: "r", amountBeingRedeemedPusd: 200, nextInterestRatePct: 2 },
    ];
    const [s, r] = computeLoanViews(loans, 700);
    expect(s!.stranded).toBe(true);
    expect(s!.collateralRatioPct).toBeNull();
    expect(s!.liquidationPriceUsd).toBeNull();
    expect(s!.distanceToLiquidation).toBeNull();
    expect(r!.redemptionInProgress).toBe(true);
    expect(r!.pendingRateChange).toBe(true);
    expect(r!.stranded).toBe(false);
  });
});
