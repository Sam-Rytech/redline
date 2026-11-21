import { describe, expect, it } from "vitest";
import { heat, lampLit, ratioToAngle } from "../src/lib/gauge";

describe("ratioToAngle", () => {
  it("hits the printed numerals", () => {
    expect(ratioToAngle(200)).toBe(0);
    expect(ratioToAngle(110)).toBe(99);
    expect(ratioToAngle(150)).toBe(45);
  });
  it("interpolates between numerals", () => {
    expect(ratioToAngle(175)).toBeCloseTo(22.5);
  });
  it("is monotonic: lower ratio, further clockwise", () => {
    let prev = -Infinity;
    for (let r = 320; r >= 90; r -= 5) {
      const a = ratioToAngle(r);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
  it("parks at the left stop when there is no debt", () => {
    expect(ratioToAngle(null)).toBe(-132);
  });
});

describe("lamp and heat", () => {
  it("lights the lamp near the line only", () => {
    expect(lampLit(150)).toBe(false);
    expect(lampLit(120)).toBe(true);
  });
  it("heat runs 0 to 1", () => {
    expect(heat(250)).toBe(0);
    expect(heat(110)).toBe(1);
    expect(heat(145)).toBeCloseTo(0.5);
  });
});
