/**
 * Product taxonomy: how we map ASDA's own department/shelf/brand vocabulary
 * onto the handful of categories this project reasons about.
 *
 * Every rule here is a string-match against ASDA's merchandising taxonomy, and
 * every one earns its place against a real case (noted inline). They live
 * together on purpose: classification is one job, so when a new product slips
 * through, the fix is a one-line addition in an obvious, tested place rather
 * than a hunt across modules. This is deliberately code, not a model call:
 * ASDA's taxonomy already encodes these distinctions, so we map it rather than
 * pay a model to re-derive it on every snapshot.
 */

import { VALUE_TIER_PENALTY } from "../config";

// ---------------------------------------------------------------------------
// Quality tier
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prepared meals (not ingredients)
// ---------------------------------------------------------------------------

/**
 * Departments and shelves that hold finished dishes rather than ingredients. A
 * recipe asks for "macaroni", not a macaroni cheese ready meal, so these are
 * dropped before the shelf is chosen: otherwise the dozen "Macaroni Cheese"
 * ready meals outvote the two bags of dry pasta and the resolver lands on a
 * microwave meal. Deliberately narrow (no bare "instant", which would catch
 * instant coffee) to avoid excluding real ingredients.
 */
const PREPARED_MEAL = /ready meal|microwave|pasta pots?|noodle pots?|pasta & sauce|tinned pasta/i;

export const isPreparedMeal = (product: { department: string | null; shelf: string | null }): boolean =>
  PREPARED_MEAL.test(`${product.department ?? ""} ${product.shelf ?? ""}`);

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

/**
 * Drinks are grazeable but they are not snacks: squash, juice, fizzy, water,
 * coconut water and the like belong in a drinks line of their own, not the
 * snack allowance. Excluded from the snack picker so it never offers three
 * squashes.
 */
const DRINK = new RegExp(
  [
    "squash|cordial",
    "fizzy|cola|lemonade",
    "juice|smoothie",
    "\\bwater\\b|coconut water|tonic|mixer",
    "energy.*drink|sports.*drink|health.*drink|soft drink",
    "milk drink|milkshake|yogurt drink|drinking yogurt",
    "lunchbox drink|kids.*drink",
    "\\bdrink\\b", // catches bare "... Flavoured Drink" names
    "coffee|\\btea\\b",
  ].join("|"),
  "i",
);

export const isDrink = (department: string | null, shelf: string | null, name: string): boolean =>
  DRINK.test(`${department ?? ""} ${shelf ?? ""} ${name}`);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/**
 * A genuine reduction, not a multibuy or a flat list price. `Rollback` and
 * `Dropped` are ASDA's own labels for real cuts; multibuys are excluded because
 * their "saving" is often illusory and needs the whole group to realise.
 */
const GENUINE_CUT = /rollback|dropped/i;

export const isGenuineCut = (offerLabel: string | null | undefined): boolean =>
  GENUINE_CUT.test(offerLabel ?? "");

// ---------------------------------------------------------------------------
// Grazeable vs prep-required
// ---------------------------------------------------------------------------

/**
 * The household's children eat anything ready-to-eat the moment it is home (a
 * pack of 12 yoghurts lasted a day), but will not touch anything that needs
 * cooking. So the axis that matters is not shelf life, it is whether an item is
 * edible without preparation. This drives two things: grazeable items never
 * carry to the next shop, and they are bought fresh each shop as a deliberate
 * snack allowance rather than provisioned to last.
 *
 * Cheese, bread and fresh fruit are grazeable by default: as often grazed as
 * cooked with, and "gone in a day" is the safer assumption for this household.
 * Flip an individual case with `PREP_REQUIRED_OVERRIDES`.
 */
const GRAZEABLE = new RegExp(
  [
    "yogurt|yoghurt|dessert",
    "crisp|nuts|popcorn|snack",
    "chocolate|sweet|treat|confection",
    "biscuit|cookie",
    "ice cream|ice lolli",
    "cake|pastr|doughnut|donut",
    "fizzy|cola|energy.*drink|sports.*drink|juice|smoothie|squash|cordial|water",
    "cereal", // eaten dry by the handful as readily as with milk
    "cheese",
    "bread|roll|bagel|crumpet|muffin|bakery|naan|pitta|wrap|tortilla",
    "cooked meat|deli|ham|charcuterie",
    "fresh fruit|banana|grape|berr",
    "sandwich|dip|party food",
  ].join("|"),
  "i",
);

/**
 * Names that would otherwise be misclassified. Keyed by a lowercased substring
 * of the product name; the first match wins. Kept small on purpose.
 */
const PREP_REQUIRED_OVERRIDES: string[] = [
  "cooking cheese",
  "halloumi", // bought to fry, not graze
  "paneer",
];

const READY_TO_EAT_OVERRIDES: string[] = [
  "cheese string",
  "cheese snack",
];

/**
 * Frozen goods (bar ice cream and lollies) need an oven or hob, so the children
 * leave them alone regardless of what they are. A frozen pizza is not a snack.
 */
const FROZEN_BUT_NOT_DESSERT = /frozen/i;
const FROZEN_DESSERT = /ice cream|ice lolli|lolly|sorbet|gelato/i;

/** Hot drinks need a kettle, so they survive despite matching "chocolate". */
const HOT_DRINK = /coffee|tea|hot chocolate/i;

/** Ready-to-drink cartons the children go straight through. */
const READY_TO_DRINK = /lunchbox|kids.*drink|drink.*kids/i;

/**
 * Is this item eaten without preparation, and therefore gone before it could
 * carry to the next shop?
 *
 * Classified by department and shelf, since product names alone are unreliable
 * ("Chicken" appears in both raw joints and cooked-meat slices).
 */
export function isGrazeable(
  department: string | null | undefined,
  shelf?: string | null,
  name?: string | null,
): boolean {
  const lowerName = (name ?? "").toLowerCase();
  if (READY_TO_EAT_OVERRIDES.some((token) => lowerName.includes(token))) return true;
  if (PREP_REQUIRED_OVERRIDES.some((token) => lowerName.includes(token))) return false;

  const haystack = `${department ?? ""} ${shelf ?? ""}`;

  // Precedence: things that need heat survive even if the name sounds snacky.
  if (READY_TO_DRINK.test(haystack)) return true;
  if (FROZEN_BUT_NOT_DESSERT.test(haystack) && !FROZEN_DESSERT.test(haystack)) return false;
  if (HOT_DRINK.test(haystack)) return false;

  return GRAZEABLE.test(haystack);
}

/** The inverse: needs cooking or assembling, so it survives the children. */
export const needsPreparation = (
  department: string | null | undefined,
  shelf?: string | null,
  name?: string | null,
): boolean => !isGrazeable(department, shelf, name);

// ---------------------------------------------------------------------------
// Shelf life
// ---------------------------------------------------------------------------

/**
 * Days a leftover stays usable, by department keyword. Deliberately
 * conservative: over-estimating shelf life silently plans meals around food
 * that has gone off, which is worse than buying a second bag of onions.
 */
const SHELF_LIFE_DAYS: [RegExp, number][] = [
  [/frozen/i, 90],
  [/tinned|rice, pasta|condiments|home baking|cooking sauces|jams|cereal/i, 180],
  [/meat|poultry|fish|seafood/i, 3],
  [/vegetables|fruit|salad|bakery|bread/i, 5],
  [/milk|cheese|yogurt|cooked meat|dairy|eggs/i, 7],
];

const DEFAULT_SHELF_LIFE_DAYS = 10;

export function shelfLifeDays(department: string | undefined): number {
  if (!department) return DEFAULT_SHELF_LIFE_DAYS;
  for (const [pattern, days] of SHELF_LIFE_DAYS) {
    if (pattern.test(department)) return days;
  }
  return DEFAULT_SHELF_LIFE_DAYS;
}
