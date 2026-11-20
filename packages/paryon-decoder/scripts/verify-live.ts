import { computeLoanViews, fetchSnapshot } from "../src/index.js";

const snap = await fetchSnapshot();
const views = computeLoanViews(snap.loans, snap.priceUsd);
const active = views.filter((l) => l.debtPusd > 0);
const stranded = views.filter((l) => l.stranded);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

console.log(`price: $${snap.priceUsd} (seq ${snap.priceSequence})`);
console.log(`active loans: ${active.length}`);
console.log(`total debt: ${sum(active.map((l) => l.debtPusd)).toFixed(2)} PUSD`);
console.log(`active collateral: ${sum(active.map((l) => l.collateralBch)).toFixed(4)} BCH`);
console.log(`stranded: ${stranded.length} loans, ${sum(stranded.map((l) => l.collateralBch)).toFixed(4)} BCH`);
console.log(`skipped (no sidecar): ${snap.skipped}`);
console.log("5 lowest-CR loans:");
for (const l of [...active].sort((a, b) => a.collateralRatioPct! - b.collateralRatioPct!).slice(0, 5)) {
  console.log(
    `  ${l.id.slice(0, 12)}  debt ${l.debtPusd}  coll ${l.collateralBch.toFixed(4)} BCH  CR ${l.collateralRatioPct!.toFixed(2)}%  liq $${l.liquidationPriceUsd!.toFixed(2)}  rate ${l.interestRatePct}%`,
  );
}
