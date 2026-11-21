import { describe, expect, it } from "vitest";
import { computeLoanViews, riskBand, type RawLoan } from "../src/index.js";

const base: RawLoan = {
  id: "aa",
  status: "mature",
  debtPusd: 1000,
  collateralSats: 2_00000000, // 2 BCH
  rateRaw: 274, // 1.00 % a year
  nextRateRaw: 274,
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
      { ...base, id: "me", rateRaw: 548, debtPusd: 1000 },
      { ...base, id: "low", rateRaw: 274, debtPusd: 500 },
      { ...base, id: "high", rateRaw: 822, debtPusd: 700 },
      { ...base, id: "small", rateRaw: 1370, debtPusd: 50 },
    ];
    const me = computeLoanViews(loans, 700).find((l) => l.id === "me")!;
    expect(me.debtAheadPusd).toBe(550);
  });

  it("orders the redemption queue by the raw on-chain rate, not the rounded percentage", () => {
    // 1958 and 1960 both display as 7.15 % but are different rates on chain.
    const loans: RawLoan[] = [
      { ...base, id: "me", rateRaw: 1960, debtPusd: 1000 },
      { ...base, id: "lower", rateRaw: 1958, debtPusd: 400 },
      { ...base, id: "same", rateRaw: 1960, debtPusd: 300 },
    ];
    const views = computeLoanViews(loans, 700);
    const me = views.find((l) => l.id === "me")!;
    expect(me.interestRatePct).toBe(7.15);
    expect(views.find((l) => l.id === "lower")!.interestRatePct).toBe(7.15);
    expect(me.debtAheadPusd).toBe(400);
  });

  it("flags a pending rate change from the raw rates even when the rounded values match", () => {
    const [v] = computeLoanViews([{ ...base, rateRaw: 1960, nextRateRaw: 1958 }], 700);
    expect(v!.interestRatePct).toBe(v!.nextInterestRatePct);
    expect(v!.pendingRateChange).toBe(true);
  });

  it("flags stranded, redeeming and pending rate change", () => {
    const loans: RawLoan[] = [
      { ...base, id: "s", debtPusd: 0, collateralSats: 5_000_000 },
      { ...base, id: "r", amountBeingRedeemedPusd: 200, nextRateRaw: 548 },
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

  it("gives stranded loans a claim link to the Paryon app, and no other loan one", () => {
    const [s, active] = computeLoanViews(
      [
        { ...base, id: "s", debtPusd: 0, collateralSats: 5_000_000 },
        { ...base, id: "a" },
      ],
      700,
    );
    expect(s!.claimUrl).toBe("https://paryonusd.com/app");
    expect(active!.claimUrl).toBeNull();
  });
});

describe("summarize", () => {
  it("summarises loans incl. stranded", async () => {
    const { summarize, computeLoanViews } = await import("../src/index.js");
    const views = computeLoanViews(
      [
        { ...base, id: "a", debtPusd: 100, collateralSats: 1_00000000 }, // liq 110, distance ~0.42
        { ...base, id: "b", debtPusd: 100, collateralSats: 5500_0000 }, // liq 200 > price, within 20pct
        { ...base, id: "c", debtPusd: 0, collateralSats: 3_00000000 }, // stranded
      ],
      190,
    );
    expect(summarize(views)).toEqual({
      total: 3,
      activeCount: 2,
      activeCollateralBch: 1 + 0.55,
      within20pct: 1,
      totalCollateralBch: 1 + 0.55 + 3,
      totalDebtPusd: 200,
      strandedCount: 1,
      strandedBch: 3,
    });
  });
});
