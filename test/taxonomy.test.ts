import { describe, expect, test } from "bun:test";
import { isDrink, isGenuineCut } from "../src/planning/taxonomy";

// tierOf/qualityWeight are covered in quality.test.ts, isGrazeable in
// grazeable.test.ts, isPreparedMeal in ingredients.test.ts. These two gained a
// public home in the taxonomy consolidation and had no direct coverage before.

describe("isDrink", () => {
  test("catches squash, juice, fizzy and water", () => {
    expect(isDrink(null, "Squash & Cordials", "Orange Squash 1L")).toBe(true);
    expect(isDrink(null, null, "Apple Juice 1L")).toBe(true);
    expect(isDrink(null, null, "Sparkling Water 2L")).toBe(true);
  });

  test("catches a bare '... Flavoured Drink' by name", () => {
    expect(isDrink(null, null, "Mango Flavoured Drink 500ml")).toBe(true);
  });

  test("does not flag actual snacks", () => {
    expect(isDrink(null, "Crisps & Snacks", "Ready Salted Crisps")).toBe(false);
    expect(isDrink(null, null, "Salted Popcorn")).toBe(false);
    expect(isDrink("Chilled", "Cheese", "Mature Cheddar 350g")).toBe(false);
  });

  test("'cola' is word-bounded so chocolate is not a drink", () => {
    // Regression: "cola" used to match choCOLAte, wrongly excluding chocolate
    // from the snack picker.
    expect(isDrink("Chocolate & Sweets", "Chocolate Bars", "Dairy Milk 110g")).toBe(false);
    expect(isDrink(null, null, "Chocolate Digestives")).toBe(false);
    // A real cola is still a drink.
    expect(isDrink(null, "Fizzy Drinks", "Cherry Cola 2L")).toBe(true);
  });
});

describe("isGenuineCut", () => {
  test("only a rollback or dropped price is a genuine cut", () => {
    expect(isGenuineCut("Rollback")).toBe(true);
    expect(isGenuineCut("Dropped")).toBe(true);
  });

  test("multibuys and list prices are not", () => {
    expect(isGenuineCut("Any 3 for £12")).toBe(false);
    expect(isGenuineCut("List")).toBe(false);
    expect(isGenuineCut(null)).toBe(false);
    expect(isGenuineCut(undefined)).toBe(false);
  });
});
