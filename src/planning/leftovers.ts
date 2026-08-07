/**
 * Leftovers and carry-over.
 *
 * Buying a 1kg bag of onions to use 250g isn't waste if next week's plan knows
 * about the other 750g. This records what a plan leaves behind and offers it
 * back to the following run as free stock, with a shelf life so a plan never
 * counts on chicken bought a fortnight ago.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CARRYOVER_PATH, DATA_DIR } from "../config";
import { shelfLifeDays } from "./taxonomy";

export interface CarryOverItem {
  term: string;
  unit: string;
  quantity: number;
  /** ISO date the item was recorded. */
  recordedAt: string;
  /** ISO date after which it is assumed inedible and dropped. */
  expiresAt: string;
  department?: string;
}

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 86_400_000);

export const carryOverKey = (term: string, unit: string): string =>
  `${term.trim().toLowerCase()}|${unit}`;

/** Read the store, dropping anything past its expiry. */
export function loadCarryOver(now: Date = new Date()): CarryOverItem[] {
  if (!existsSync(CARRYOVER_PATH)) return [];
  try {
    const items = JSON.parse(readFileSync(CARRYOVER_PATH, "utf8")) as CarryOverItem[];
    return items.filter((item) => new Date(item.expiresAt) > now && item.quantity > 0);
  } catch {
    // A corrupt store should cost a week's leftovers, not the whole run.
    return [];
  }
}

/** Quantities available per `term|unit`, for offsetting demand. */
export function carryOverIndex(items: CarryOverItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const item of items) {
    const key = carryOverKey(item.term, item.unit);
    index.set(key, (index.get(key) ?? 0) + item.quantity);
  }
  return index;
}

export interface LeftoverInput {
  term: string;
  unit: string;
  /** Quantity left after the plan is cooked. */
  quantity: number;
  department?: string;
  /** True when nothing new was bought, so the stock is as old as it was. */
  carriedOnly: boolean;
  /** Existing expiry, preserved when nothing new was bought. */
  previousExpiry?: string;
}

export function saveCarryOver(
  leftovers: LeftoverInput[],
  now: Date = new Date(),
): CarryOverItem[] {
  const items: CarryOverItem[] = leftovers
    .filter((leftover) => leftover.quantity > 0)
    .map((leftover) => ({
      term: leftover.term,
      unit: leftover.unit,
      quantity: Math.round(leftover.quantity * 100) / 100,
      recordedAt: now.toISOString(),
      // Nothing new bought means the stock hasn't got any fresher.
      expiresAt:
        leftover.carriedOnly && leftover.previousExpiry
          ? leftover.previousExpiry
          : addDays(now, shelfLifeDays(leftover.department)).toISOString(),
      department: leftover.department,
    }));

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CARRYOVER_PATH, JSON.stringify(items, null, 2));
  return items;
}
