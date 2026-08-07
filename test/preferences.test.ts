import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { DB_PATH } from "../src/config";
import { latestRun, resolveIngredient } from "../src/planning/ingredients";
import { PREFERENCES, rejectionFor } from "../src/planning/preferences";

describe("rejectionFor", () => {
  const rejected = (name: string) => Boolean(rejectionFor({ name }));

  test("rejects bone-in cuts", () => {
    expect(rejected("Succulent Chicken Drumsticks 2kg")).toBe(true);
    expect(rejected("Chicken Wings 1.1kg")).toBe(true);
    expect(rejected("Succulent Chicken Leg Quarters 1.1kg")).toBe(true);
    expect(rejected("Succulent Chicken Thighs 2kg")).toBe(true);
  });

  // The allow pattern is checked first, or the reject pattern for "thigh"
  // would also remove the boneless thigh fillets that satisfy the preference.
  test("allows boneless equivalents despite matching the reject pattern", () => {
    expect(rejected("Succulent Boneless Chicken Thigh Fillets 1kg")).toBe(false);
    expect(rejected("Chicken Thigh Fillets 600g")).toBe(false);
  });

  test("leaves unrelated products alone", () => {
    expect(rejected("Just Essentials Chopped Tomatoes 400g")).toBe(false);
    expect(rejected("Chicken Breast Fillets 1kg")).toBe(false);
  });

  test("matches against the shelf as well as the name", () => {
    expect(Boolean(rejectionFor({ name: "Corn Fed Bird", shelf: "Whole Chickens" }))).toBe(true);
  });

  test("every preference has a description for the prompt", () => {
    for (const preference of PREFERENCES) {
      expect(preference.description.length).toBeGreaterThan(10);
    }
  });
});

describe("resolveIngredient with preferences", () => {
  const db = new Database(DB_PATH, { readonly: true });
  let runId: number;
  beforeAll(() => { runId = latestRun(db); });

  test("never returns a bone-in cut for chicken thighs", () => {
    const result = resolveIngredient(db, runId, "chicken thighs");
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(rejectionFor({ name: candidate.name, shelf: candidate.shelf })).toBeUndefined();
    }
  });

  test("records what was ruled out, so the cost is visible", () => {
    const result = resolveIngredient(db, runId, "chicken thighs");
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected[0]!.preferenceId).toBe("no-bones");
  });

  test("ignorePreferences restores the cheaper bone-in options", () => {
    const withPref = resolveIngredient(db, runId, "chicken thighs");
    const without = resolveIngredient(db, runId, "chicken thighs", { ignorePreferences: true });
    expect(without.best!.pricePerUom!).toBeLessThan(withPref.best!.pricePerUom!);
  });
});

describe("preference premium", () => {
  const db2 = new Database(DB_PATH, { readonly: true });

  test("charges the premium when a generic term would have resolved to a rejected product", async () => {
    const { costPlan } = await import("../src/planning/costing");
    const line = costPlan(db2, latestRun(db2), [
      { name: "x", serves: 5, ingredients: [{ term: "chicken thighs", quantity: 800, unit: "g" }] },
    ])[0]!;
    expect(line.preferencePremium).toBeGreaterThan(0);
    expect(line.preferenceId).toBe("no-bones");
  });

  // When the model already asks for a compliant product the cheap option is
  // never a candidate, so there is nothing to charge for.
  test("charges nothing when the term never matched a rejected product", async () => {
    const { costPlan } = await import("../src/planning/costing");
    const line = costPlan(db2, latestRun(db2), [
      { name: "x", serves: 5, ingredients: [{ term: "chicken thigh fillets", quantity: 600, unit: "g" }] },
    ])[0]!;
    expect(line.preferencePremium).toBe(0);
  });
});
