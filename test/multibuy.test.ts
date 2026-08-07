import { describe, expect, test } from "bun:test";
import {
  type BasketItem, type MultibuyRule, isStockpilable, parseMechanic, priceBasket,
} from "../src/planning/multibuy";

describe("parseMechanic", () => {
  test("parses fixed-price multibuys", () => {
    expect(parseMechanic("Any 3 for £12")).toEqual({ kind: "fixed-price", count: 3, price: 12 });
    expect(parseMechanic("Any 2 for £3.50")).toEqual({ kind: "fixed-price", count: 2, price: 3.5 });
    expect(parseMechanic("Buy 2 For £3.50")).toEqual({ kind: "fixed-price", count: 2, price: 3.5 });
  });

  test("parses cheapest-free multibuys", () => {
    expect(parseMechanic("Any 3 for 2")).toEqual({ kind: "cheapest-free", count: 3, payFor: 2 });
  });

  // Meal deals are pick-one-from-each-group; their structure isn't in the
  // data, so pricing them would invent a discount that may not exist.
  test("refuses meal-deal style promotions", () => {
    expect(parseMechanic("Meal Deal")).toBeUndefined();
    expect(parseMechanic("Bistro Dine In £12")).toBeUndefined();
    expect(parseMechanic("Medium Pizza Deal £7")).toBeUndefined();
  });

  test("refuses a nonsensical pay-for count", () => {
    expect(parseMechanic("Any 2 for 3")).toBeUndefined();
  });
});

const rules = (mechanic: MultibuyRule["mechanic"]): Map<string, MultibuyRule> =>
  new Map([["P1", { promoId: "P1", promoName: "test", mechanic }]]);

const item = (cin: string, price: number, packs: number): BasketItem =>
  ({ cin, name: cin, price, packs, promoIds: ["P1"] });

describe("priceBasket", () => {
  test("applies a fixed-price group across different products", () => {
    const result = priceBasket(
      [item("a", 5.93, 1), item("b", 5.28, 1), item("c", 5.1, 1)],
      rules({ kind: "fixed-price", count: 3, price: 12 }),
    );
    expect(result.naiveTotal).toBeCloseTo(16.31, 2);
    expect(result.total).toBeCloseTo(12, 2);
    expect(result.saving).toBeCloseTo(4.31, 2);
  });

  test("leaves an incomplete group at full price and reports the near miss", () => {
    const result = priceBasket([item("a", 6, 2)], rules({ kind: "fixed-price", count: 3, price: 12 }));
    expect(result.saving).toBe(0);
    expect(result.nearMisses[0]!.need).toBe(1);
    // £12 for three when you already hold £12 of two: the third is free.
    expect(result.nearMisses[0]!.extraCost).toBeCloseTo(0, 2);
  });

  test("prices two complete groups", () => {
    const result = priceBasket([item("a", 5, 6)], rules({ kind: "fixed-price", count: 3, price: 12 }));
    expect(result.naiveTotal).toBe(30);
    expect(result.total).toBe(24);
    expect(result.applied[0]!.qualifying).toBe(6);
  });

  test("gives away the cheapest in a three-for-two", () => {
    const result = priceBasket(
      [item("a", 3, 1), item("b", 2, 1), item("c", 1, 1)],
      rules({ kind: "cheapest-free", count: 3, payFor: 2 }),
    );
    expect(result.total).toBe(5);
    expect(result.saving).toBe(1);
  });

  test("ignores products outside the group", () => {
    const outside: BasketItem = { cin: "z", name: "z", price: 4, packs: 1, promoIds: [] };
    const result = priceBasket(
      [item("a", 5, 3), outside],
      rules({ kind: "fixed-price", count: 3, price: 12 }),
    );
    expect(result.total).toBe(16);
  });
});

describe("isStockpilable", () => {
  test("ambient and frozen goods keep", () => {
    expect(isStockpilable("Tinned Food", false)).toBe(true);
    expect(isStockpilable("Frozen Chicken & Meat", false)).toBe(true);
  });

  // The guard against buying 2kg of fresh chicken for a household that eats
  // 700g a week.
  test("fresh protein only counts if the household will freeze it", () => {
    expect(isStockpilable("Meat & Poultry", false)).toBe(false);
    expect(isStockpilable("Meat & Poultry", true)).toBe(true);
  });

  test("fresh produce never counts, freezing or not", () => {
    expect(isStockpilable("Fresh Vegetables", true)).toBe(false);
  });
});

describe("stockpiling in costPlan", () => {
  test("buys up to a multibuy threshold and books the surplus as inventory", async () => {
    const { Database } = await import("bun:sqlite");
    const { DB_PATH } = await import("../src/config");
    const { latestRun } = await import("../src/planning/ingredients");
    const { costPlan } = await import("../src/planning/costing");

    const db = new Database(DB_PATH, { readonly: true });
    const line = costPlan(db, latestRun(db), [
      { name: "x", serves: 5, ingredients: [{ term: "chicken breast slices", quantity: 180, unit: "g" }] },
    ])[0]!;

    expect(line.packs).toBe(3);
    expect(line.stockpiled).toBeGreaterThan(0);
    // Deliberate surplus must not be counted as waste, or it fights the
    // planner's waste-revision loop.
    expect(line.leftover).toBe(0);
    db.close();
  });

  test("declines to stockpile fresh produce however good the offer", async () => {
    const { isStockpilable } = await import("../src/planning/multibuy");
    expect(isStockpilable("Fresh Vegetables", true)).toBe(false);
  });
});
