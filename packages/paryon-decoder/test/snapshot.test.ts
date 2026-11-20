import { describe, expect, it } from "vitest";
import { buildSnapshot, computeLoanViews, MAINNET_V1, type ChainUtxo } from "../src/index.js";

const CAT = MAINNET_V1.paryonTokenId;
const SIDE = "aa".repeat(32);
const hex = (n: number, bytes: number) => {
  let s = "";
  for (let i = 0; i < bytes; i++) s += (Math.floor(n / 2 ** (8 * i)) % 256).toString(16).padStart(2, "0");
  return s;
};
const loanCommit = (cents: number, rate: number, next: number) =>
  "01" + hex(cents, 6) + "000000000000" + "02" + hex(18, 4) + hex(rate, 2) + hex(next, 2) + "00" + "0000" + "ffff";
const loanUtxo = (txid: string, vout: number, sats: number, commitment: string, category: string = CAT): ChainUtxo => ({
  txid, vout, satoshis: sats,
  token: { category, amount: "0", nft: { capability: "mutable", commitment } },
});
const sidecar = (txid: string, vout: number, category: string): ChainUtxo => ({
  txid, vout, satoshis: 1000,
  token: { category, amount: "0", nft: { capability: "none", commitment: "" } },
});
const price = (seq: number, cents: number): ChainUtxo => ({
  txid: "p".repeat(1) + seq, vout: 0, satoshis: 1000,
  token: { category: CAT, amount: "0", nft: { capability: "mutable", commitment: "00" + hex(seq, 4) + hex(cents, 4) } },
});
// price commitment is 9 bytes: 00 | seq(4) | price(4)
const priceUtxo = price;

describe("buildSnapshot", () => {
  it("golden loan matches stats.paryonusd.com", () => {
    const snap = buildSnapshot({
      loanUtxos: [loanUtxo("t1", 0, 1898581599, loanCommit(315000, 1959, 0))],
      sidecarUtxos: [sidecar("t1", 1, SIDE)],
      priceUtxos: [priceUtxo(1, 19028)],
    });
    expect(snap.priceUsd).toBe(190.28);
    expect(snap.skipped).toBe(0);
    expect(snap.loans[0]!.id).toBe(SIDE);
    const [v] = computeLoanViews(snap.loans, snap.priceUsd);
    expect(v!.debtPusd).toBe(3150);
    expect(v!.collateralBch).toBeCloseTo(18.98581599, 8);
    expect(v!.interestRatePct).toBe(7.15);
    expect(v!.nextInterestRatePct).toBe(0);
    expect(v!.status).toBe("mature");
    expect(v!.collateralRatioPct!).toBeCloseTo(114.69, 2);
    expect(v!.liquidationPriceUsd!).toBeCloseTo(182.507, 2);
  });

  it("carries amountBeingRedeemed through to the view", () => {
    // debt 200000 cents, redeeming 50000 cents
    const c = "01" + hex(200000, 6) + hex(50000, 6) + "02" + hex(18, 4) + hex(1959, 2) + hex(1959, 2) + "00" + "0000" + "ffff";
    const snap = buildSnapshot({
      loanUtxos: [loanUtxo("t1", 0, 2_000_000_000, c)],
      sidecarUtxos: [sidecar("t1", 1, SIDE)],
      priceUtxos: [priceUtxo(1, 19028)],
    });
    expect(snap.loans[0]!.amountBeingRedeemedPusd).toBe(500);
    const [v] = computeLoanViews(snap.loans, snap.priceUsd);
    expect(v!.amountBeingRedeemedPusd).toBe(500);
    expect(v!.redemptionInProgress).toBe(true);
  });

  it("debt-0 loan is stranded", () => {
    const snap = buildSnapshot({
      loanUtxos: [loanUtxo("t1", 0, 50_000_000, loanCommit(0, 100, 100))],
      sidecarUtxos: [sidecar("t1", 1, SIDE)],
      priceUtxos: [priceUtxo(1, 19028)],
    });
    expect(snap.loans).toHaveLength(1);
    expect(computeLoanViews(snap.loans, snap.priceUsd)[0]!.stranded).toBe(true);
  });

  it("skips loans without sidecar and counts them", () => {
    const snap = buildSnapshot({
      loanUtxos: [loanUtxo("t1", 0, 1, loanCommit(100, 1, 1)), loanUtxo("t2", 0, 1, loanCommit(100, 1, 1))],
      sidecarUtxos: [sidecar("t2", 1, SIDE), sidecar("t1", 2, "bb".repeat(32))],
      priceUtxos: [priceUtxo(1, 19028)],
    });
    expect(snap.loans.map((l) => l.id)).toEqual([SIDE]);
    expect(snap.skipped).toBe(1);
  });

  it("ignores non-Paryon, non-mutable and undecodable UTXOs", () => {
    const junk: ChainUtxo[] = [
      { txid: "j1", vout: 0, satoshis: 546 },
      loanUtxo("j2", 0, 546, loanCommit(100, 1, 1), "cc".repeat(32)),
      { txid: "j3", vout: 0, satoshis: 546, token: { category: CAT, amount: "0", nft: { capability: "none", commitment: loanCommit(100, 1, 1) } } },
      loanUtxo("j4", 0, 546, "deadbeef"),
    ];
    const snap = buildSnapshot({
      loanUtxos: junk,
      sidecarUtxos: junk.map((u) => sidecar(u.txid, 1, SIDE)),
      priceUtxos: [priceUtxo(1, 19028)],
    });
    expect(snap.loans).toHaveLength(0);
    expect(snap.skipped).toBe(0);
  });

  it("takes the highest-sequence price", () => {
    const snap = buildSnapshot({
      loanUtxos: [], sidecarUtxos: [],
      priceUtxos: [priceUtxo(5, 20000), priceUtxo(9, 21000), priceUtxo(7, 22000)],
    });
    expect(snap.priceUsd).toBe(210);
    expect(snap.priceSequence).toBe(9);
  });

  it("throws without a price UTXO", () => {
    expect(() => buildSnapshot({ loanUtxos: [], sidecarUtxos: [], priceUtxos: [] })).toThrow("No price contract UTXO");
  });
});
