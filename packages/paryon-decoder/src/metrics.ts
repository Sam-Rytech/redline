import {
  PARYON_APP_URL,
  type LoanStatus,
  type LoanView,
  type LoansSummary,
  type RiskBand,
} from "@redline/api-types";
import { rawRateToAnnualPct } from "./commitment.js";

export const LIQUIDATION_CR = 1.1;
export const SMALL_LOAN_PUSD = 100;
export const DUST_SATS = 1000;

export interface RawLoan {
  id: string;
  status: LoanStatus;
  debtPusd: number;
  collateralSats: number;
  /** On-chain interest rate (per 10,000,000 per period). Comparisons use this, never the rounded percentage. */
  rateRaw: number;
  nextRateRaw: number;
  amountBeingRedeemedPusd: number;
}

export function riskBand(distance: number | null): RiskBand {
  if (distance === null) return "safe";
  if (distance >= 0.25) return "safe";
  if (distance >= 0.15) return "watch";
  if (distance >= 0.08) return "danger";
  return "critical";
}

function debtAhead(me: RawLoan, all: RawLoan[]): number {
  let sum = 0;
  for (const l of all) {
    if (l.id === me.id || l.debtPusd <= 0) continue;
    if (l.rateRaw < me.rateRaw || l.debtPusd < SMALL_LOAN_PUSD) {
      sum += l.debtPusd;
    }
  }
  return Math.round(sum * 100) / 100;
}

export function computeLoanViews(raw: RawLoan[], priceUsd: number): LoanView[] {
  return raw.map((l) => {
    const collateralBch = l.collateralSats / 1e8;
    const hasDebt = l.debtPusd > 0;
    const crPct = hasDebt ? ((collateralBch * priceUsd) / l.debtPusd) * 100 : null;
    const liq = hasDebt ? (l.debtPusd / collateralBch) * LIQUIDATION_CR : null;
    const distance = liq === null ? null : (priceUsd - liq) / priceUsd;
    return {
      id: l.id,
      status: l.status,
      debtPusd: l.debtPusd,
      collateralSats: l.collateralSats,
      collateralBch,
      interestRatePct: rawRateToAnnualPct(l.rateRaw),
      nextInterestRatePct: rawRateToAnnualPct(l.nextRateRaw),
      pendingRateChange: l.nextRateRaw !== l.rateRaw,
      collateralRatioPct: crPct,
      liquidationPriceUsd: liq,
      distanceToLiquidation: distance,
      risk: riskBand(distance),
      debtAheadPusd: debtAhead(l, raw),
      redemptionInProgress: l.amountBeingRedeemedPusd > 0,
      amountBeingRedeemedPusd: l.amountBeingRedeemedPusd,
      stranded: !hasDebt && l.collateralSats > DUST_SATS,
      paryonUrl: PARYON_APP_URL,
      // the owner releases leftover BCH by closing the loan with its loan key in the Paryon app (gate GL2)
      claimUrl: !hasDebt && l.collateralSats > DUST_SATS ? PARYON_APP_URL : null,
    };
  });
}

export function summarize(loans: LoanView[]): LoansSummary {
  const stranded = loans.filter((l) => l.stranded);
  const active = loans.filter((l) => l.debtPusd > 0);
  return {
    total: loans.length,
    activeCount: active.length,
    activeCollateralBch: active.reduce((a, l) => a + l.collateralBch, 0),
    within20pct: loans.filter((l) => l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2).length,
    totalCollateralBch: loans.reduce((a, l) => a + l.collateralBch, 0),
    totalDebtPusd: loans.reduce((a, l) => a + l.debtPusd, 0),
    strandedCount: stranded.length,
    strandedBch: stranded.reduce((a, l) => a + l.collateralBch, 0),
  };
}
