import type { RawLoan } from "@redline/paryon-decoder";

export const MOCK_PRICE_USD = 210;
export const MOCK_BLOCK_HEIGHT = 951_200;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexId(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 64; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/** Build a loan whose CR is exactly `crPct` at MOCK_PRICE_USD. */
function loanAtCr(rand: () => number, crPct: number, debtPusd: number, ratePct: number): RawLoan {
  const collateralBch = (debtPusd * crPct) / 100 / MOCK_PRICE_USD;
  return {
    id: hexId(rand),
    status: "mature",
    debtPusd,
    collateralSats: Math.round(collateralBch * 1e8),
    interestRatePct: ratePct,
    nextInterestRatePct: ratePct,
    amountBeingRedeemedPusd: 0,
  };
}

/**
 * 40 deterministic loans. Indices 0–2 are "my loans" in the mock:
 * 0 = critical (CR 115%), 1 = watch (CR 135%), 2 = stranded (debt 0).
 */
export function makeRawLoans(seed = 42): RawLoan[] {
  const rand = mulberry32(seed);
  const loans: RawLoan[] = [
    loanAtCr(rand, 115, 2_400, 0.5),
    loanAtCr(rand, 135, 850, 1.0),
    { ...loanAtCr(rand, 200, 1, 2.0), debtPusd: 0, collateralSats: 3_120_000 },
    loanAtCr(rand, 126, 5_200, 0.25), // danger
    { ...loanAtCr(rand, 150, 1_300, 0.75), amountBeingRedeemedPusd: 420 },
    { ...loanAtCr(rand, 180, 9_000, 1.5), nextInterestRatePct: 2.5, status: "single-period" },
    { ...loanAtCr(rand, 400, 60, 4.0), status: "new" }, // small loan (< 100 PUSD)
  ];
  while (loans.length < 40) {
    const cr = 120 + Math.floor(rand() * 260); // 120–379%
    const debt = Math.round((200 + rand() * 20_000) * 100) / 100;
    const rate = Math.round(rand() * 60) * 0.05 + 0.05; // 0.05–3.05% in 0.05 steps
    loans.push(loanAtCr(rand, cr, debt, Math.round(rate * 100) / 100));
  }
  return loans;
}
