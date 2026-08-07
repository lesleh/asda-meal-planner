import { describe, expect, test } from "bun:test";
import { VALUE_TIER_PENALTY } from "../src/config";
import { qualityWeight, tierOf } from "../src/planning/quality";

describe("tierOf", () => {
  test("reads ASDA's value tier from the brand, case-insensitively", () => {
    // ASDA ships both casings in the same catalogue.
    expect(tierOf("JUST ESSENTIALS by ASDA")).toBe("value");
    expect(tierOf("Just Essentials by ASDA")).toBe("value");
  });

  test("reads the premium tier", () => {
    expect(tierOf("ASDA Extra Special")).toBe("premium");
  });

  test("everything else is standard", () => {
    expect(tierOf("ASDA")).toBe("standard");
    expect(tierOf("Heinz")).toBe("standard");
    expect(tierOf(null)).toBe("standard");
    expect(tierOf(undefined)).toBe("standard");
  });
});

describe("qualityWeight", () => {
  test("penalises only the value tier", () => {
    expect(qualityWeight("JUST ESSENTIALS by ASDA")).toBeCloseTo(1 + VALUE_TIER_PENALTY, 10);
    expect(qualityWeight("ASDA")).toBe(1);
    expect(qualityWeight("ASDA Extra Special")).toBe(1);
    expect(qualityWeight(null)).toBe(1);
  });

  // The contract the ranking relies on: a value item beats a standard one only
  // when it is cheaper by more than the penalty. These are the two real cases
  // from the snapshot.
  const adjusted = (price: number, brand: string) => price * qualityWeight(brand);

  test("dislodges the value tier when a standard option is close (mince)", () => {
    // Just Essentials mince £3.12 vs ASDA 20% Fat £3.25: only 4% apart, so the
    // standard product wins once the value tier carries its penalty.
    const value = adjusted(3.12, "JUST ESSENTIALS by ASDA");
    const standard = adjusted(3.25, "ASDA");
    expect(standard).toBeLessThan(value);
  });

  test("keeps the value tier when it is cheaper by more than the penalty (beans)", () => {
    // Just Essentials beans £0.28 vs the next tin £0.39: a 28% gap the 30%
    // penalty does not overcome, so the value tier still wins. Soft by design.
    const value = adjusted(0.28, "JUST ESSENTIALS by ASDA");
    const standard = adjusted(0.39, "ASDA");
    expect(value).toBeLessThan(standard);
  });
});
