import type { RawLoan } from "./metrics.js";
import { MAINNET_V1 } from "./deployment.js";
import { decodeLoanCommitment, decodePriceCommitment, rawRateToAnnualPct } from "./commitment.js";

export interface ChainUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  token?: {
    category: string;
    amount: string;
    nft?: { capability: "none" | "mutable" | "minting"; commitment: string };
  };
}

export interface Snapshot {
  priceUsd: number;
  priceSequence: number;
  /** includes debt-0 (stranded) loans */
  loans: RawLoan[];
  /** loan UTXOs with no matching sidecar */
  skipped: number;
}

const isParyonMutable = (u: ChainUtxo): u is ChainUtxo & { token: { nft: NonNullable<NonNullable<ChainUtxo["token"]>["nft"]> } } =>
  u.token?.category === MAINNET_V1.paryonTokenId && u.token.nft?.capability === "mutable";

export function buildSnapshot(input: {
  loanUtxos: ChainUtxo[];
  sidecarUtxos: ChainUtxo[];
  priceUtxos: ChainUtxo[];
}): Snapshot {
  let best: { sequence: number; priceUsd: number } | null = null;
  for (const u of input.priceUtxos) {
    if (!isParyonMutable(u)) continue;
    const p = decodePriceCommitment(u.token.nft.commitment);
    if (p && (!best || p.sequence > best.sequence)) best = p;
  }
  if (!best) throw new Error("No price contract UTXO");

  const sidecars = new Map<string, ChainUtxo>();
  for (const s of input.sidecarUtxos) sidecars.set(`${s.txid}:${s.vout}`, s);

  const loans: RawLoan[] = [];
  let skipped = 0;
  for (const u of input.loanUtxos) {
    if (!isParyonMutable(u)) continue;
    const d = decodeLoanCommitment(u.token.nft.commitment);
    if (!d) continue;
    const side = sidecars.get(`${u.txid}:${u.vout + 1}`);
    if (!side?.token) {
      skipped++;
      continue;
    }
    loans.push({
      id: side.token.category,
      status: d.status,
      debtPusd: d.borrowedCents / 100,
      collateralSats: u.satoshis,
      interestRatePct: rawRateToAnnualPct(d.currentRateRaw),
      nextInterestRatePct: rawRateToAnnualPct(d.nextRateRaw),
      amountBeingRedeemedPusd: d.redeemingCents / 100,
    });
  }
  return { priceUsd: best.priceUsd, priceSequence: best.sequence, loans, skipped };
}
