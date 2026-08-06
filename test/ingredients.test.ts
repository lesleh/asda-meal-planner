import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { DB_PATH } from "../src/config";
import { TERM_SHELF_HINTS, latestRun, resolveIngredient } from "../src/ingredients";

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
