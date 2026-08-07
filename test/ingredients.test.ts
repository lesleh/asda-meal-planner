import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { DB_PATH } from "../src/config";
import { TERM_SHELF_HINTS, latestRun, resolveIngredient } from "../src/planning/ingredients";
import { isPreparedMeal } from "../src/planning/taxonomy";

const db = new Database(DB_PATH, { readonly: true });
let runId: number;
let shelves: Set<string>;

beforeAll(() => {
  runId = latestRun(db);
  shelves = new Set(
    db.query<{ shelf: string }, [number]>(
      `SELECT DISTINCT shelf FROM products WHERE run_id = ? AND shelf IS NOT NULL`,
    ).all(runId).map((row) => row.shelf),
  );
});

describe("TERM_SHELF_HINTS", () => {
  // A hint naming a shelf that doesn't exist silently resolves to nothing,
  // which is worse than having no hint at all.
  test("every hint points at a shelf present in the snapshot", () => {
    const missing = Object.entries(TERM_SHELF_HINTS)
      .filter(([, shelf]) => !shelves.has(shelf))
      .map(([term, shelf]) => `${term} -> ${shelf}`);
    expect(missing).toEqual([]);
  });

  test("every hint resolves to at least one product", () => {
    const empty = Object.keys(TERM_SHELF_HINTS)
      .filter((term) => !resolveIngredient(db, runId, term).best);
    expect(empty).toEqual([]);
  });
});

describe("resolveIngredient", () => {
  // Each of these picked the wrong shelf at some point during development.
  const expected: [string, string][] = [
    ["onions", "Onions & Leeks"],
    ["garlic", "Garlic & Ginger"],
    ["tinned tomatoes", "Tinned Tomatoes"],
    ["chicken thighs", "Chicken Thighs & Drumsticks"],
    ["milk", "Whole Milk"],
    ["butter", "Block Butter"],
    ["potatoes", "White Potatoes"],
  ];

  for (const [term, shelf] of expected) {
    test(`${term} resolves to ${shelf}`, () => {
      expect(resolveIngredient(db, runId, term).shelf).toBe(shelf);
    });
  }

  test("flags ambiguity rather than silently guessing", () => {
    expect(resolveIngredient(db, runId, "onions").alternativeShelves.length).toBeGreaterThan(0);
  });

  test("returns no-matches for nonsense instead of throwing", () => {
    const result = resolveIngredient(db, runId, "zzzznotafood");
    expect(result.reason).toBe("no-matches");
    expect(result.best).toBeUndefined();
  });
});

describe("query invariance", () => {
  // The resolver's SQL used to be assembled conditionally, so each option
  // combination produced a different prepared statement. Repeated and varied
  // calls must give identical results for the same inputs.
  test("repeated identical calls return identical results", () => {
    const runs = Array.from({ length: 20 }, () => resolveIngredient(db, runId, "onion").best?.cin);
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toBeDefined();
  });

  test("interleaving option combinations does not disturb the plain call", () => {
    const baseline = resolveIngredient(db, runId, "garden peas").best?.cin;
    expect(baseline).toBeDefined();
    for (let i = 0; i < 10; i++) {
      resolveIngredient(db, runId, "garden peas", { onOfferOnly: true });
      resolveIngredient(db, runId, "garden peas", { shelf: "Frozen Peas" });
      resolveIngredient(db, runId, "garden peas", { diet: ["vegan"] });
      resolveIngredient(db, runId, "garden peas", { ignorePreferences: true });
      expect(resolveIngredient(db, runId, "garden peas").best?.cin).toBe(baseline);
    }
  });

  test("common ingredients always resolve", () => {
    for (const term of ["onion", "garden peas", "fusilli", "potatoes", "milk", "chicken breast"]) {
      expect(resolveIngredient(db, runId, term).best).toBeDefined();
    }
  });
});

describe("prepared meals are not ingredients", () => {
  test("isPreparedMeal flags ready meals and prepared pots, not raw shelves", () => {
    expect(isPreparedMeal({ department: "Ready Meals", shelf: "Italian & Mediterranean" })).toBe(true);
    expect(isPreparedMeal({ department: "Frozen Ready Meals", shelf: "Frozen Italian Meals" })).toBe(true);
    expect(isPreparedMeal({ department: "Tinned Food", shelf: "Tinned Pasta" })).toBe(true);
    expect(isPreparedMeal({ department: "Rice, Pasta & Noodles", shelf: "Microwave Pasta" })).toBe(true);
    expect(isPreparedMeal({ department: "Rice, Pasta & Noodles", shelf: "Pasta Tubes, Shells & Spirals" })).toBe(false);
    // Narrow on purpose: "instant" alone must not catch instant coffee.
    expect(isPreparedMeal({ department: "Coffee, Tea & Hot Chocolate", shelf: "Regular Instant Coffee" })).toBe(false);
  });

  test("macaroni resolves to dry pasta, not a macaroni cheese ready meal", () => {
    const result = resolveIngredient(db, runId, "macaroni");
    expect(result.best).toBeDefined();
    expect(result.best!.name).not.toMatch(/cheese/i);
    expect(result.best!.department ?? "").not.toMatch(/ready meal/i);
  });
});
