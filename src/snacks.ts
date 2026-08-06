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
import { isGrazeable } from "./grazeable";
import { PREFERENCES, rejectionFor } from "./preferences";

export interface SnackPick {
  cin: string;
  name: string;
  department: string | null;
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
}

/**
 * A genuine reduction, not a multibuy or a flat list price. `Rollback` and
 * `Dropped` are ASDA's own labels for real cuts; multibuys are excluded because
 * their "saving" is often illusory and needs the whole group to realise.
 */
const GENUINE_CUT = /rollback|dropped/i;

/**
 * Pick snacks to fill the cart up to `targetSpend`.
 *
 * Ranked by discount then unit price, so the best-value real reductions go in
 * first. One pack of each: variety over a pallet of one thing.
 */
export function selectSnacks(
  db: Database,
  runId: number,
  options: SnackOptions,
  alreadySpent: number,
): SnackPick[] {
  const { targetSpend, maxSpend, exclude = new Set(), maxItems = 12 } = options;

  const rows = db
    .query<Row, [number]>(`
      SELECT cin, name, department, shelf, price, offer_label, discount_pct,
             price_per_uom, uom
      FROM products
      WHERE run_id = ?
        AND on_offer = 1
        AND price IS NOT NULL
      ORDER BY COALESCE(discount_pct, 0) DESC, price_per_uom`)
    .all(runId);

  const candidates = rows.filter((row) => {
    if (exclude.has(row.cin)) return false;
    // Snacks are, by definition, the grazeable things the meal pass ignores.
    if (!isGrazeable(row.department, row.shelf, row.name)) return false;
    // Only genuine cuts, not multibuys or list prices.
    if (!GENUINE_CUT.test(row.offer_label ?? "")) return false;
    // Respect the same household preferences the resolver enforces.
    if (rejectionFor({ name: row.name, shelf: row.shelf }, PREFERENCES)) return false;
    return true;
  });

  const picks: SnackPick[] = [];
  let snackSpend = 0;
  let cart = alreadySpent;

  for (const row of candidates) {
    if (cart >= targetSpend) break;
    if (picks.length >= maxItems) break;
    if (snackSpend + row.price > maxSpend) continue; // try a cheaper one

    picks.push({
      cin: row.cin,
      name: row.name,
      department: row.department,
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
