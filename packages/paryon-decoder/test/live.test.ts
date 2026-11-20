import { describe, expect, it } from "vitest";
import { fetchSnapshot } from "../src/index.js";

describe.skipIf(!process.env.LIVE)("live mainnet", () => {
  it("fetches a real snapshot", async () => {
    const snap = await fetchSnapshot();
    const active = snap.loans.filter((l) => l.debtPusd > 0).length;
    console.log(`live: price=${snap.priceUsd} loans=${snap.loans.length} skipped=${snap.skipped} active=${active}`);
    expect(snap.priceUsd).toBeGreaterThan(10);
    expect(snap.blockHeight).toBeGreaterThan(948406);
    expect(snap.loans.length).toBeGreaterThan(100);
    expect(snap.skipped).toBe(0);
    expect(active).toBeGreaterThanOrEqual(100);
  }, 60_000);
});
