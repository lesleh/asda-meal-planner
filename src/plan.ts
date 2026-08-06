/**
 * Costs a meal plan against the snapshot.
 *
 * This is the half a model shouldn't do: aggregate demand across recipes,
 * pick packs, and total it up. The model's job is the recipes and the shelf
 * disambiguation; the arithmetic happens here where it can be trusted.
 *
 *   bun run plan.ts
 */

import { Database } from "bun:sqlite";
import { type Candidate, latestRun, resolveIngredient } from "./ingredients";
import { carryOverKey } from "./leftovers";
import { DB_PATH } from "./config";


export interface RecipeIngredient {
  /** Search term, as a model would name it. */
  term: string;
  quantity: number;
  unit: "g" | "ml" | "ea";
  /** Pins the shelf when the resolver flags ambiguity. */
  shelf?: string;
  /** Assume it's already in the cupboard; costed but flagged. */
  staple?: boolean;
}

export interface Recipe {
  name: string;
  serves: number;
  ingredients: RecipeIngredient[];
}

export interface Line {
  term: string;
  unit: string;
  /** Gross demand across all recipes, before carry-over is applied. */
  needed: number;
  /** Supplied from last week's leftovers, so not bought again. */
  fromCarryOver: number;
  /** Department of the chosen product, for shelf-life purposes. */
  department?: string;
  usedBy: { recipe: string; quantity: number }[];
  /** Cupboard item: costed, but excluded from the per-serving figure. */
  staple: boolean;
  product: Candidate | undefined;
  packs: number;
  bought: number;
  leftover: number;
  cost: number;
  note?: string;
}

/**
 * Leading item count in a product name: "8 Thick Pork Sausages 410g" -> 8.
 * Requires a space and a non-digit after, so "500ml" isn't read as 500 items.
 */
function leadingCount(name: string): number | undefined {
  const match = /^(\d+)\s+\D/.exec(name.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * How much of `unit` one pack supplies, or undefined if it can't be known.
 *
 * Recipes and packaging disagree constantly: a recipe wants 2 onions, the bag
 * is priced by weight; it wants 155g of sauce, the bottle is in millilitres.
 * Returning undefined rather than guessing keeps unpriceable lines visible.
 */
function packSupplies(candidate: Candidate, unit: string): number | undefined {
  if (!candidate.packQuantity) return undefined;
  if (candidate.packUnit === unit) return candidate.packQuantity;
  // Sauces, oils and stocks are near enough 1g per 1ml for shopping purposes.
  if ((candidate.packUnit === "g" && unit === "ml") || (candidate.packUnit === "ml" && unit === "g")) {
    return candidate.packQuantity;
  }
  // A weighed pack whose name counts its contents can still answer "how many".
  if (unit === "ea") return leadingCount(candidate.name);
  // Going the other way needs a per-item weight nothing in the data provides.
  return undefined;
}

/**
 * Aggregate demand across recipes before choosing packs.
 *
 * Costing per recipe would buy a 2kg bag of onions twice; aggregating first is
 * what makes "split ingredients across recipes" fall out for free.
 */
export function costPlan(
  db: Database,
  runId: number,
  recipes: Recipe[],
  /** Quantities already in stock, keyed by `term|unit`. */
  carryOver: Map<string, number> = new Map(),
): Line[] {
  const demand = new Map<string, { unit: string; total: number; shelf?: string; staple: boolean; usedBy: Line["usedBy"] }>();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const key = `${ingredient.term}|${ingredient.unit}`;
      const entry = demand.get(key) ?? {
        unit: ingredient.unit,
        total: 0,
        shelf: ingredient.shelf,
        staple: ingredient.staple ?? false,
        usedBy: [],
      };
      entry.total += ingredient.quantity;
      entry.shelf ??= ingredient.shelf;
      entry.usedBy.push({ recipe: recipe.name, quantity: ingredient.quantity });
      demand.set(key, entry);
    }
  }

  const available = new Map(carryOver);
  const lines: Line[] = [];

  for (const [key, entry] of demand) {
    const term = key.split("|")[0]!;

    // Spend carried stock before buying. Claimed here so a second line with
    // the same term can't spend it twice.
    const stocked = available.get(carryOverKey(term, entry.unit)) ?? 0;
    const fromCarryOver = Math.min(stocked, entry.total);
    if (fromCarryOver > 0) {
      available.set(carryOverKey(term, entry.unit), stocked - fromCarryOver);
    }
    const toBuy = entry.total - fromCarryOver;

    const resolved = resolveIngredient(db, runId, term, { shelf: entry.shelf, limit: 25 });

    // Pick the pack that costs least for the quantity actually needed, not the
    // one with the best unit price. Those differ badly at small quantities: a
    // 7.5kg sack of potatoes wins on £/kg but costs £4 to supply 1.6kg, where
    // two 1kg bags cost less and waste almost nothing. Waste breaks ties.
    const product = resolved.candidates.reduce<Candidate | undefined>((bestSoFar, candidate) => {
      if (packSupplies(candidate, entry.unit) === undefined) return bestSoFar;
      if (!bestSoFar) return candidate;
      const cost = (c: Candidate) => Math.ceil(toBuy / packSupplies(c, entry.unit)!) * c.price;
      const waste = (c: Candidate) =>
        Math.ceil(toBuy / packSupplies(c, entry.unit)!) * packSupplies(c, entry.unit)! - toBuy;
      const delta = cost(candidate) - cost(bestSoFar);
      if (delta < -0.001) return candidate;
      if (delta > 0.001) return bestSoFar;
      return waste(candidate) < waste(bestSoFar) ? candidate : bestSoFar;
    }, undefined) ?? resolved.best;

    if (!product) {
      lines.push({ term, unit: entry.unit, needed: entry.total, fromCarryOver,
        usedBy: entry.usedBy, staple: entry.staple, product: undefined,
        packs: 0, bought: 0, leftover: 0, cost: 0, note: "no match" });
      continue;
    }

    const supplies = packSupplies(product, entry.unit);
    const unitsAgree = supplies !== undefined;
    // Carry-over may already cover the whole line, in which case buy nothing.
    const packs = unitsAgree ? Math.ceil(toBuy / supplies) : toBuy > 0 ? 1 : 0;
    const bought = unitsAgree ? packs * supplies : 0;

    lines.push({
      term,
      unit: entry.unit,
      needed: entry.total,
      fromCarryOver,
      department: product.department ?? undefined,
      usedBy: entry.usedBy,
      staple: entry.staple,
      product,
      packs,
      bought,
      leftover: unitsAgree ? bought + fromCarryOver - entry.total : 0,
      cost: Math.round(packs * product.price * 100) / 100,
      note: unitsAgree
        ? resolved.alternativeShelves.length > 0
          ? `ambiguous: also ${resolved.alternativeShelves.slice(0, 2).map((a) => a.shelf).join(", ")}`
          : undefined
        : `unit mismatch (recipe ${entry.unit}, pack ${product.packUnit ?? "?"}) — assumed 1 pack`,
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Demo: the shape a planning model would emit
// ---------------------------------------------------------------------------

const RECIPES: Recipe[] = [
  {
    name: "Chicken & tomato traybake",
    serves: 4,
    ingredients: [
      { term: "chicken thighs", quantity: 800, unit: "g" },
      { term: "potatoes", quantity: 600, unit: "g", shelf: "White Potatoes" },
      { term: "onions", quantity: 200, unit: "g" },
      { term: "tinned tomatoes", quantity: 400, unit: "g" },
      { term: "olive oil", quantity: 30, unit: "ml", staple: true },
    ],
  },
  {
    name: "Chicken curry",
    serves: 4,
    ingredients: [
      { term: "chicken thighs", quantity: 600, unit: "g" },
      { term: "onions", quantity: 300, unit: "g" },
      { term: "garlic", quantity: 3, unit: "ea" },
      { term: "tinned tomatoes", quantity: 400, unit: "g" },
      { term: "basmati rice", quantity: 300, unit: "g" },
    ],
  },
  {
    name: "Jacket potatoes with cheese",
    serves: 4,
    ingredients: [
      { term: "potatoes", quantity: 1000, unit: "g", shelf: "White Potatoes" },
      { term: "cheddar cheese", quantity: 200, unit: "g" },
    ],
  },
];

if (import.meta.main) {
  const db = new Database(DB_PATH, { readonly: true });
  const runId = latestRun(db);
  const lines = costPlan(db, runId, RECIPES);

  console.log(`meal plan: ${RECIPES.length} recipes, ${RECIPES.reduce((n, r) => n + r.serves, 0)} servings\n`);

  let total = 0;
  let stapleCost = 0;
  for (const line of lines.sort((a, b) => b.cost - a.cost)) {
    total += line.cost;
    if (line.staple) stapleCost += line.cost;
    const product = line.product;
    console.log(
      `£${line.cost.toFixed(2).padStart(6)}  ${line.term}` +
        (product ? `  ->  ${product.name}${product.onOffer ? "  [OFFER]" : ""}` : "  ->  NO MATCH"),
    );
    if (product) {
      const shared = line.usedBy.length > 1
        ? `  shared across ${line.usedBy.map((u) => `${u.recipe} ${u.quantity}${line.unit}`).join(" + ")}`
        : "";
      console.log(
        `         need ${line.needed}${line.unit}, buy ${line.packs} x ${product.packQuantity ?? "?"}${product.packUnit ?? ""} @ £${product.price}` +
          (line.leftover > 0 ? `, ${line.leftover}${line.unit} left over` : "") + shared,
      );
    }
    if (line.note) console.log(`         note: ${line.note}`);
  }

  const servings = RECIPES.reduce((n, r) => n + r.serves, 0);
  console.log(`\ntotal: £${total.toFixed(2)}  (of which £${stapleCost.toFixed(2)} is cupboard staples you likely already have)`);
  console.log(`per serving: £${((total - stapleCost) / servings).toFixed(2)} excluding staples, £${(total / servings).toFixed(2)} including`);
  const offers = lines.filter((l) => l.product?.onOffer).length;
  console.log(`${offers}/${lines.filter((l) => l.product).length} ingredients sourced from promoted lines`);
  db.close();
}
