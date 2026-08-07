/**
 * Product quality tiers, read from ASDA's own brand labelling.
 *
 * ASDA stamps a value tier ("Just Essentials by Asda", formerly Smart Price)
 * and a premium tier ("Asda Extra Special") into the `brand` field. The value
 * tier is reliably the cheapest per unit, so a resolver that picks purely on
 * price lands on it every time: the cheapest mince, the cheapest beans. We do
 * not ban it (sometimes it is genuinely all there is), but we make the
 * cheapest-wins comparison pay a premium to step off it.
 *
 * This is arithmetic on a label ASDA already assigned, not a quality judgement
 * the code is pretending to make.
 */

import { VALUE_TIER_PENALTY } from "../config";

export type Tier = "value" | "standard" | "premium";

/** Case-insensitive: the brand appears as both "JUST ESSENTIALS by ASDA" and "Just Essentials by ASDA". */
const VALUE = /just essentials/i;
const PREMIUM = /extra special/i;

export function tierOf(brand: string | null | undefined): Tier {
  const b = brand ?? "";
  if (VALUE.test(b)) return "value";
  if (PREMIUM.test(b)) return "premium";
  return "standard";
}

/**
 * Ranking multiplier applied to a candidate's cost when choosing. The value
 * tier is inflated by the configured penalty; everything else is neutral. The
 * real price is never touched, only the comparison.
 */
export function qualityWeight(brand: string | null | undefined): number {
  return tierOf(brand) === "value" ? 1 + VALUE_TIER_PENALTY : 1;
}
