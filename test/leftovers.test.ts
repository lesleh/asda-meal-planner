import { describe, expect, test } from "bun:test";
import { carryOverIndex, shelfLifeDays, type CarryOverItem } from "../src/leftovers";

describe("shelfLifeDays", () => {
  test("fresh meat expires fast", () => {
    expect(shelfLifeDays("Meat & Poultry")).toBe(3);
    expect(shelfLifeDays("Fish & Seafood")).toBe(3);
  });

  test("frozen and ambient keep for months", () => {
    expect(shelfLifeDays("Frozen Chicken & Meat")).toBe(90);
    expect(shelfLifeDays("Tinned Food")).toBe(180);
  });

  test("frozen beats the fresh-meat rule for frozen meat", () => {
    // Both patterns match "Frozen Chicken & Meat"; frozen must win, or the
    // plan throws away a bag of frozen mince after three days.
    expect(shelfLifeDays("Frozen Chicken & Meat")).toBeGreaterThan(shelfLifeDays("Meat & Poultry"));
  });

  test("falls back conservatively for unknown departments", () => {
    expect(shelfLifeDays(undefined)).toBe(10);
    expect(shelfLifeDays("Some New Department")).toBe(10);
  });
});

describe("carryOverIndex", () => {
  test("sums duplicate terms and is case-insensitive", () => {
    const items = [
      { term: "Onions", unit: "g", quantity: 300 },
      { term: "onions", unit: "g", quantity: 200 },
    ] as CarryOverItem[];
    expect(carryOverIndex(items).get("onions|g")).toBe(500);
  });

  test("keeps different units apart", () => {
    const items = [
      { term: "garlic", unit: "ea", quantity: 2 },
      { term: "garlic", unit: "g", quantity: 50 },
    ] as CarryOverItem[];
    const index = carryOverIndex(items);
    expect(index.get("garlic|ea")).toBe(2);
    expect(index.get("garlic|g")).toBe(50);
  });
});
