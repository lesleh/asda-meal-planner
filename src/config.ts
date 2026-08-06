/** Project-wide configuration and filesystem layout. */

import { mkdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;

/** Snapshot database. Gitignored: it is rebuilt by `bun run snapshot`. */
export const DB_PATH = `${ROOT}data/snapshot.db`;
/** Most recent generated meal plan. */
export const PLAN_PATH = `${ROOT}data/plan.json`;
/** Same plan, rendered to read, cook and shop from. */
export const PLAN_MD_PATH = `${ROOT}data/plan.md`;
/** Directory holding all generated state. */
export const DATA_DIR = `${ROOT}data`;
/**
 * Recipe history. The only state here that cannot be regenerated, so it is
 * tracked in git rather than ignored with the rest of `data/`.
 */
export const HISTORY_PATH = `${ROOT}data/history.json`;
/** Leftovers carried from the previous plan. */
export const CARRYOVER_PATH = `${ROOT}data/carryover.json`;
/** Snacks the household rejected. Gitignored: personal taste, kept local. */
export const BLOCKLIST_PATH = `${ROOT}data/blocklist.json`;
/** The approved snack list, its own file so the cart can add it alone. */
export const SNACKS_PATH = `${ROOT}data/snacks.json`;

/**
 * Create `data/` if it is missing. It is gitignored in full, so a fresh clone
 * has no such directory and the first snapshot would otherwise fail.
 */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export const HOUSEHOLD = {
  adults: 2,
  children: 3,
  /** A child eats roughly this fraction of an adult portion. */
  childPortion: 0.6,
  /** What a meal should aim to cost per head. Guidance, not a hard ceiling. */
  budgetPerPortion: 2.0,
};

/** People at the table. */
export const PEOPLE = HOUSEHOLD.adults + HOUSEHOLD.children;
/** Portions to actually cook. */
export const ADULT_EQUIVALENT =
  HOUSEHOLD.adults + HOUSEHOLD.children * HOUSEHOLD.childPortion;

/**
 * Shop budget.
 *
 * `deliveryMinimum` is a floor, not a ceiling: ASDA won't let you check out
 * below it, so a lean meal plan that comes to less is useless.
 *
 * `snackAllowance` is a deliberate spend on snacks every shop, not just
 * gap-filling. The children graze heavily, so snacks are a real line the plan
 * always buys; the pass spends at least this, and more if the meals leave the
 * cart short of the floor. `maxSnackSpend` is the absolute ceiling on it.
 *
 * `cap` is the real "we're spending too much" limit on the whole shop.
 */
export const BUDGET = {
  deliveryMinimum: 40,
  snackAllowance: 15,
  maxSnackSpend: 22,
  cap: 70,
};

/** ASDA store to price against. Governs stock and shelf availability. */
export const STORE_ID = "4618";

/** Whether the household will freeze surplus fresh meat and fish. */
export const WILL_FREEZE = true;

/**
 * Minimum improvement in effective unit price before a multibuy is worth
 * stockpiling for. A 5% saving does not justify tying up cash and freezer
 * space in three packs when one would do.
 */
export const MIN_STOCKPILE_SAVING = 0.15;

/**
 * Assumed already in the cupboard, so not costed. Matched on the recipe's
 * search term, to stop a plan buying a litre of oil to use 45ml of it.
 */
export const PANTRY = [
  "vegetable oil", "olive oil", "sunflower oil", "oil", "salt", "pepper",
  "black pepper", "plain flour", "self raising flour", "flour", "sugar",
  "caster sugar", "cornflour", "stock cubes", "chicken stock",
  "vegetable stock", "dried mixed herbs", "mixed herbs", "oregano", "thyme",
  "paprika", "cumin", "ground cumin", "coriander", "turmeric",
  "chilli powder", "curry powder", "garam masala", "cinnamon", "bay leaves",
  "soy sauce", "vinegar", "white wine vinegar", "balsamic vinegar",
  "tomato puree", "mustard", "honey", "worcestershire sauce",
];

export const isPantry = (term: string): boolean =>
  PANTRY.includes(term.trim().toLowerCase());
