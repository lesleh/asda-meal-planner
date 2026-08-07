/**
 * Multibuy promotions.
 *
 * ASDA encodes the mechanic in the promotion's display name, so "Any 3 for
 * £12" has to be parsed rather than looked up. Two mechanics cover 84% of
 * promoted products; the rest ("Meal Deal", "Bistro Dine In £12") are
 * pick-one-from-each-group constructs whose structure isn't in the data at
 * all, and are deliberately left unpriced.
 *
 * Pricing happens at the basket, not the line, because groups are mix-and-
 * match: three different products in one "Any 3 for £12" group trigger it
 * together.
 */

import type { Database } from "bun:sqlite";
import { shelfLifeDays } from "./leftovers";

export type MultibuyMechanic =
  /** N items for a fixed total, e.g. "Any 3 for £12". */
  | { kind: "fixed-price"; count: number; price: number }
  /** N items for the price of M, e.g. "Any 3 for 2" — cheapest are free. */
  | { kind: "cheapest-free"; count: number; payFor: number };

export interface MultibuyRule {
  promoId: string;
  promoName: string;
  mechanic: MultibuyMechanic;
}

/**
 * Parse a promotion's display name into a mechanic.
 *
 * Returns undefined for meal-deal style promotions. Guessing at those would
 * price a basket of three sandwiches as a meal deal.
 */
export function parseMechanic(promoName: string): MultibuyMechanic | undefined {
  const fixed = /^(?:any|buy)\s+(\d+)\s+for\s+£\s*([\d.]+)$/i.exec(promoName.trim());
  if (fixed) {
    return { kind: "fixed-price", count: Number(fixed[1]), price: Number(fixed[2]) };
  }
  const cheapest = /^(?:any|buy)\s+(\d+)\s+for\s+(\d+)$/i.exec(promoName.trim());
  if (cheapest) {
    const count = Number(cheapest[1]);
    const payFor = Number(cheapest[2]);
    if (payFor < count) return { kind: "cheapest-free", count, payFor };
  }
  return undefined;
}

export function loadRules(db: Database, runId: number): Map<string, MultibuyRule> {
  const rows = db
    .query<{ promo_id: string; promo_name: string }, [number]>(
      `SELECT DISTINCT promo_id, promo_name FROM promos WHERE run_id = ?`,
    )
    .all(runId);

  const rules = new Map<string, MultibuyRule>();
  for (const row of rows) {
    const mechanic = parseMechanic(row.promo_name);
    if (mechanic) {
      rules.set(row.promo_id, { promoId: row.promo_id, promoName: row.promo_name, mechanic });
    }
  }
  return rules;
}

/** Promotion ids a product belongs to. */
export function promoIdsFor(db: Database, runId: number, cin: string): string[] {
  return db
    .query<{ promo_id: string }, [number, string]>(
      `SELECT promo_id FROM promos WHERE run_id = ? AND cin = ?`,
    )
    .all(runId, cin)
    .map((row) => row.promo_id);
}

/**
 * Whether surplus of this product is worth stockpiling.
 *
 * The guard that stops a multibuy buying 2kg of fresh chicken for a household
 * that eats 700g a week. Ambient and frozen goods keep; fresh protein only
 * counts if the household is willing to freeze it.
 */
export function isStockpilable(
  department: string | undefined,
  willFreeze: boolean,
): boolean {
  if (shelfLifeDays(department) >= 30) return true;
  return willFreeze && /meat|poultry|fish|seafood/i.test(department ?? "");
}

export interface BasketItem {
  cin: string;
  name: string;
  /** Packs being bought. */
  packs: number;
  /** Price of one pack. */
  price: number;
  promoIds: string[];
}

export interface AppliedPromo {
  promoId: string;
  promoName: string;
  /** Packs that qualified. */
  qualifying: number;
  saving: number;
}

export interface NearMiss {
  promoId: string;
  promoName: string;
  /** Packs currently in the basket from this group. */
  have: number;
  /** More packs needed to trigger the next group. */
  need: number;
  /** Extra spend to top up. */
  extraCost: number;
  /** Value of the extra items at their normal price. */
  extraValue: number;
}

export interface BasketPricing {
  /** Total with multibuys applied. */
  total: number;
  /** Total at single-item prices. */
  naiveTotal: number;
  saving: number;
  applied: AppliedPromo[];
  nearMisses: NearMiss[];
}

/**
 * Price a basket, applying each multibuy across all qualifying packs.
 *
 * Packs are sorted most expensive first and taken in chunks, which maximises
 * the discount: the dearest items should be the ones inside a fixed-price
 * group, and the cheapest should be the ones given away.
 */
export function priceBasket(
  items: BasketItem[],
  rules: Map<string, MultibuyRule>,
): BasketPricing {
  const naiveTotal = items.reduce((sum, item) => sum + item.packs * item.price, 0);

  // Each pack can only be discounted once, so track which are already spent.
  const remaining = new Map<string, number>(items.map((item) => [item.cin, item.packs]));
  const priceOf = new Map<string, number>(items.map((item) => [item.cin, item.price]));

  const applied: AppliedPromo[] = [];
  const nearMisses: NearMiss[] = [];
  let discount = 0;

  for (const [promoId, rule] of rules) {
    const members = items.filter((item) => item.promoIds.includes(promoId));
    if (members.length === 0) continue;

    // Expand to individual packs, dearest first.
    const packs: string[] = [];
    for (const member of members) {
      for (let i = 0; i < (remaining.get(member.cin) ?? 0); i++) packs.push(member.cin);
    }
    packs.sort((a, b) => (priceOf.get(b) ?? 0) - (priceOf.get(a) ?? 0));

    const { count } = rule.mechanic;
    const complete = Math.floor(packs.length / count);

    if (complete > 0) {
      let saving = 0;
      for (let group = 0; group < complete; group++) {
        const chunk = packs.slice(group * count, (group + 1) * count);
        const full = chunk.reduce((sum, cin) => sum + (priceOf.get(cin) ?? 0), 0);
        const discounted =
          rule.mechanic.kind === "fixed-price"
            ? rule.mechanic.price
            : // Cheapest in the chunk are free.
              chunk
                .map((cin) => priceOf.get(cin) ?? 0)
                .sort((a, b) => b - a)
                .slice(0, rule.mechanic.payFor)
                .reduce((sum, price) => sum + price, 0);
        saving += full - discounted;
      }

      if (saving > 0.001) {
        applied.push({
          promoId,
          promoName: rule.promoName,
          qualifying: complete * count,
          saving: Math.round(saving * 100) / 100,
        });
        discount += saving;
      }

      // Consume the packs so a second promotion can't discount them again.
      for (const cin of packs.slice(0, complete * count)) {
        remaining.set(cin, (remaining.get(cin) ?? 0) - 1);
      }
    }

    const leftover = packs.length - complete * count;
    if (leftover > 0) {
      const need = count - leftover;
      const cheapest = Math.min(...members.map((member) => member.price));
      const held = packs
        .slice(complete * count)
        .reduce((sum, cin) => sum + (priceOf.get(cin) ?? 0), 0);
      const extraCost =
        rule.mechanic.kind === "fixed-price"
          ? Math.round((rule.mechanic.price - held) * 100) / 100
          : Math.round(need * cheapest * 100) / 100;
      // Only a near miss if topping up is actually cheap relative to what it adds.
      if (extraCost < need * cheapest) {
        nearMisses.push({
          promoId,
          promoName: rule.promoName,
          have: leftover,
          need,
          extraCost,
          extraValue: Math.round(need * cheapest * 100) / 100,
        });
      }
    }
  }

  return {
    total: Math.round((naiveTotal - discount) * 100) / 100,
    naiveTotal: Math.round(naiveTotal * 100) / 100,
    saving: Math.round(discount * 100) / 100,
    applied: applied.sort((a, b) => b.saving - a.saving),
    nearMisses: nearMisses.sort((a, b) => a.extraCost - b.extraCost),
  };
}
