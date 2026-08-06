/**
 * Grazeable vs prep-required.
 *
 * The household's children eat anything ready-to-eat the moment it is home (a
 * pack of 12 yoghurts lasted a day), but will not touch anything that needs
 * cooking. So the axis that matters is not shelf life, it is whether an item is
 * edible without preparation.
 *
 * This drives two things: grazeable items never carry to next week (assume
 * gone), and they are bought fresh each shop as a deliberate snack allowance
 * rather than provisioned to last.
 */

/**
 * Departments and shelves whose contents are eaten as-is.
 *
 * Cheese, bread and fresh fruit are included by default: they are as often
 * grazed as cooked with, and "gone in a day" is the safer assumption for this
 * household. Flip an individual case with `PREP_REQUIRED_OVERRIDES` if a block
 * of cooking cheese genuinely survives.
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
 * carry to next week?
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
