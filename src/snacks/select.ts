/**
 * Snack selection.
 *
 * The delivery minimum is a floor the cart must clear, and the children eat
 * anything grazeable the day it arrives. So the gap between a lean meal plan
 * and the floor is filled deliberately with good-value snacks, chosen the same
 * way the planner chooses everything: real reductions, low unit price, nothing
 * cooked. It is a chosen line, not padding, and it is bought fresh each shop
 * because it will not last.
 */

import type { Database } from "bun:sqlite";
import { isDrink, isGenuineCut, isGrazeable } from "../planning/taxonomy";
import { PREFERENCES, rejectionFor } from "../planning/preferences";

export interface SnackPick {
  cin: string;
  name: string;
  department: string | null;
  shelf: string | null;
  packs: number;
  price: number;
  cost: number;
  onOffer: boolean;
  discountPct: number | null;
  pricePerUom: number | null;
  uom: string | null;
}

interface Row {
  cin: string;
  name: string;
  department: string | null;
  shelf: string | null;
  price: number;
  offer_label: string | null;
  discount_pct: number | null;
  price_per_uom: number | null;
  uom: string | null;
}

export interface SnackOptions {
  /** Stop once the running cart reaches this. Snacks fill up to the floor. */
  targetSpend: number;
  /** Never spend more than this on snacks even to reach the target. */
  maxSpend: number;
  /** CINs already in the basket, so a snack is not double-counted. */
  exclude?: Set<string>;
  /** How many distinct snacks at most; a shop of 30 yoghurt tubs helps nobody. */
  maxItems?: number;
  /** Cap per department, so the allowance isn't spent entirely on cake. */
  maxPerDepartment?: number;
}

/**
 * Pick snacks to fill the cart up to `targetSpend`.
 *
 * Order is weighted-random, not a fixed ranking: better discounts are more
 * likely to come first, but the selection varies run to run so you aren't shown
 * the same snacks every time. The blocklist is what removes things for good;
 * this just stops the acceptable pool from being frozen.
 */
export function selectSnacks(
  db: Database,
  runId: number,
  options: SnackOptions,
  alreadySpent: number,
  /** Randomness source, injectable so tests can be deterministic. */
  random: () => number = Math.random,
): SnackPick[] {
  const { targetSpend, maxSpend, exclude = new Set(), maxItems = 20, maxPerDepartment = 3 } = options;
  const perDept = new Map<string, number>();

  const rows = db
    .query<Row, [number]>(`
      SELECT cin, name, department, shelf, price, offer_label, discount_pct,
             price_per_uom, uom
      FROM products
      WHERE run_id = ?
        AND on_offer = 1
        AND price IS NOT NULL`)
    .all(runId);

  const candidates = rows.filter((row) => {
    if (exclude.has(row.cin)) return false;
    // Snacks are, by definition, the grazeable things the meal pass ignores.
    if (!isGrazeable(row.department, row.shelf, row.name)) return false;
    // Drinks are grazeable but not snacks.
    if (isDrink(row.department, row.shelf, row.name)) return false;
    // Only genuine cuts, not multibuys or list prices.
    if (!isGenuineCut(row.offer_label)) return false;
    // Respect the same household preferences the resolver enforces.
    if (rejectionFor({ name: row.name, shelf: row.shelf }, PREFERENCES)) return false;
    return true;
  });

  // Weighted-random shuffle (Efraimidis-Spirakis): key = random^(1/weight),
  // sorted descending. A deeper discount raises the weight, so good deals tend
  // to surface first without the order ever being fixed.
  candidates
    .map((row) => ({ row, key: random() ** (1 / Math.max(5, row.discount_pct ?? 0)) }))
    .sort((a, b) => b.key - a.key)
    .forEach(({ row }, i) => {
      candidates[i] = row;
    });

  const picks: SnackPick[] = [];
  let snackSpend = 0;
  let cart = alreadySpent;

  for (const row of candidates) {
    if (cart >= targetSpend) break;
    if (picks.length >= maxItems) break;
    if (snackSpend + row.price > maxSpend) continue; // try a cheaper one

    const dept = row.department ?? "other";
    if ((perDept.get(dept) ?? 0) >= maxPerDepartment) continue; // enough of these
    perDept.set(dept, (perDept.get(dept) ?? 0) + 1);

    picks.push({
      cin: row.cin,
      name: row.name,
      department: row.department,
      shelf: row.shelf,
      packs: 1,
      price: row.price,
      cost: row.price,
      onOffer: true,
      discountPct: row.discount_pct,
      pricePerUom: row.price_per_uom,
      uom: row.uom,
    });
    snackSpend += row.price;
    cart += row.price;
  }

  return picks;
}
