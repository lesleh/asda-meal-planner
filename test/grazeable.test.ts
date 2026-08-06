import { describe, expect, test } from "bun:test";
import { isGrazeable, needsPreparation } from "../src/grazeable";

describe("isGrazeable", () => {
  test("ready-to-eat departments are grazeable", () => {
    for (const d of ["Yogurts & Desserts", "Crisps, Nuts & Popcorn", "Biscuits",
                     "Chocolates & Sweets", "Ice Cream & Ice Lollies", "Fresh Fruit"]) {
      expect(isGrazeable(d)).toBe(true);
    }
  });

  test("cheese, bread and fruit default to grazeable", () => {
    expect(isGrazeable("Cheese")).toBe(true);
    expect(isGrazeable("Bread & Rolls")).toBe(true);
    expect(isGrazeable("Fresh Fruit")).toBe(true);
  });

  test("prep-required staples survive the children", () => {
    for (const d of ["Meat & Poultry", "Fresh Vegetables", "Potatoes",
                     "Rice, Pasta & Noodles", "Tinned Food", "Milk, Butter, Cream & Eggs"]) {
      expect(needsPreparation(d)).toBe(true);
    }
  });

  // Regressions: each of these was misclassified on the first pass.
  test("frozen goods need an oven, so they are not grazeable", () => {
    expect(isGrazeable("Frozen Pizza & Garlic Bread")).toBe(false);
    expect(isGrazeable("Frozen Pies, Bakes & Sausage Rolls")).toBe(false);
  });

  test("but frozen desserts are eaten straight from the freezer", () => {
    expect(isGrazeable("Ice Cream & Ice Lollies")).toBe(true);
  });

  test("hot drinks need a kettle despite matching 'chocolate'", () => {
    expect(isGrazeable("Coffee, Tea & Hot Chocolate")).toBe(false);
  });

  test("ready-to-drink kids cartons are grazeable", () => {
    expect(isGrazeable("Kids & Lunchbox Drinks")).toBe(true);
  });

  test("name-level overrides beat the department default", () => {
    // Cooking cheese survives; a cheese string does not.
    expect(isGrazeable("Cheese", null, "Mature Cooking Cheese Block 500g")).toBe(false);
    expect(isGrazeable("Cheese", null, "Cheese Strings 8 Pack")).toBe(true);
  });
});
