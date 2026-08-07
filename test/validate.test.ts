import { describe, expect, test } from "bun:test";
import type { Recipe } from "../src/planning/costing";
import { validateRecipes, validateResolution } from "../src/planning/validate";

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  name: "Test",
  serves: 5,
  method: ["Cook it."],
  ingredients: [{ term: "onions", quantity: 100, unit: "g" }],
  ...over,
});

describe("validateRecipes", () => {
  test("accepts a well-formed recipe", () => {
    expect(validateRecipes([recipe()])).toEqual([]);
  });

  test("flags a missing method", () => {
    expect(validateRecipes([recipe({ method: [] })])[0]).toContain("no cooking method");
  });

  // Both observed in real model output.
  test("flags two ingredients mashed into one term", () => {
    const warnings = validateRecipes([
      recipe({ ingredients: [{ term: "carrots and broccoli", quantity: 300, unit: "g" }] }),
    ]);
    expect(warnings[0]).toContain("two ingredients in one term");
  });

  test("flags a duplicated ingredient", () => {
    const warnings = validateRecipes([
      recipe({
        ingredients: [
          { term: "naan bread", quantity: 2, unit: "ea" },
          { term: "naan bread", quantity: 4, unit: "ea" },
        ],
      }),
    ]);
    expect(warnings.some((w) => w.includes("listed 2 times"))).toBe(true);
  });

  test("does not flag legitimate terms containing a separator word", () => {
    // "Sandwich" and "Anderson" contain "and" but not as a separator.
    const warnings = validateRecipes([
      recipe({ ingredients: [{ term: "sandwich thins", quantity: 1, unit: "ea" }] }),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("validateResolution", () => {
  const line = (over: Record<string, unknown> = {}) =>
    ({ term: "fusilli", unit: "g", needed: 500, staple: false, product: undefined,
       usedBy: [], fromCarryOver: 0, packs: 0, bought: 0, leftover: 0, cost: 0, ...over }) as never;

  test("flags a real ingredient that matched nothing", () => {
    const warnings = validateResolution([line()]);
    expect(warnings[0]).toContain("MISSING");
    expect(warnings[0]).toContain("fusilli");
  });

  test("stays quiet about cupboard staples", () => {
    expect(validateResolution([line({ term: "dried mixed herbs", staple: true })])).toEqual([]);
  });

  test("stays quiet when everything resolved", () => {
    expect(validateResolution([line({ product: { name: "Fusilli 500g" } })])).toEqual([]);
  });
});
