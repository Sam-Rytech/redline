import {
  PARYON_APP_URL,
  type LoanStatus,
  type LoanView,
  type RiskBand,
} from "@redline/api-types";

export const LIQUIDATION_CR = 1.1;
export const SMALL_LOAN_PUSD = 100;
export const DUST_SATS = 1000;

export interface RawLoan {
  id: string;
  status: LoanStatus;
  debtPusd: number;
  collateralSats: number;
  interestRatePct: number;
  nextInterestRatePct: number;
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
    if (l.interestRatePct < me.interestRatePct || l.debtPusd < SMALL_LOAN_PUSD) {
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
      interestRatePct: l.interestRatePct,
      nextInterestRatePct: l.nextInterestRatePct,
      pendingRateChange: l.nextInterestRatePct !== l.interestRatePct,
      collateralRatioPct: crPct,
      liquidationPriceUsd: liq,
      distanceToLiquidation: distance,
      risk: riskBand(distance),
      debtAheadPusd: debtAhead(l, raw),
      redemptionInProgress: l.amountBeingRedeemedPusd > 0,
      amountBeingRedeemedPusd: l.amountBeingRedeemedPusd,
      stranded: !hasDebt && l.collateralSats > DUST_SATS,
      paryonUrl: PARYON_APP_URL,
    };
  });
}
