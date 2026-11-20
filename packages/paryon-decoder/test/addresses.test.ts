import { describe, expect, it } from "vitest";
import { PARYON_ADDRESSES } from "../src/addresses.js";

describe("PARYON_ADDRESSES", () => {
  it("matches mainnet-v1", () => {
    expect(PARYON_ADDRESSES.loan).toBe("bitcoincash:pv8zrfxplp50apvppy5ku5mjp3gqgkp94dvwf82lg0st4ptk5agfyrtpjvf8a");
    expect(PARYON_ADDRESSES.loanSidecar).toBe("bitcoincash:pdugdfdd9p84460sntu8rhmj75g8k7uaee699wzj5489l3n99h7s7f49drdgu");
    expect(PARYON_ADDRESSES.price).toBe("bitcoincash:pdws0e456rwhzuxahv5jduryn493prvjrmu6ksegq052m5g048jp2tl4l6chh");
  });
});
