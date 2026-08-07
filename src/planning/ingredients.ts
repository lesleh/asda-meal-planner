/**
 * Ingredient resolution: turn "onions" into the product you should actually buy.
 *
 * The hard part isn't finding matches, it's rejecting them. A name search for
 * "onion" hits onion gravy, pickled onions, onion rings and cheese & onion
 * crisps. ASDA's shelf taxonomy is the disambiguator: the real vegetable lives
 * on `Onions & Leeks`, so candidates are clustered by shelf and the shelf
 * whose own name matches the ingredient wins.
 *
 *   bun run ingredients.ts onions carrots "chicken thighs"
 */

import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import { PREFERENCES, type Preference, rejectionFor } from "./preferences";


export interface Candidate {
  cin: string;
  name: string;
  shelf: string | null;
  department: string | null;
  price: number;
  wasPrice: number | null;
  discountPct: number | null;
  packQuantity: number | null;
  packUnit: string | null;
  pricePerUom: number | null;
  uom: string | null;
  onOffer: boolean;
  vegan: boolean;
  vegetarian: boolean;
  noGluten: boolean;
  /** FTS relevance; lower is better. */
  rank: number;
}

export interface ResolvedIngredient {
  term: string;
  /** The shelf the resolver settled on, if it found a confident one. */
  shelf: string | null;
  /** Why that shelf, for auditing a plan after the fact. */
  reason: "shelf-name-match" | "most-matches" | "no-shelf-signal" | "no-matches";
  best: Candidate | undefined;
  /** Cheapest on-offer candidate, when one exists and isn't already `best`. */
  bestOnOffer: Candidate | undefined;
  candidates: Candidate[];
  /**
   * Candidates a household preference removed, cheapest first. Empty when no
   * preference applied. Retained so the cost of a preference can be reported
   * rather than silently absorbed.
   */
  rejected: { candidate: Candidate; preferenceId: string }[];
  /**
   * Other shelves that scored as well or nearly as well. Non-empty means the
   * taxonomy alone can't decide — "potatoes" scores `White Potatoes` and
   * `Sweet Potatoes` identically — and the caller should pick using knowledge
   * the data doesn't contain. Re-run with `{ shelf }` to commit to one.
   */
  alternativeShelves: { shelf: string; score: number; count: number }[];
}

export interface ResolveOptions {
  /** Skip household preference filtering. Off by default. */
  ignorePreferences?: boolean;
  /** Override the active preference list, mainly for tests. */
  preferences?: Preference[];
  /** Only consider products flagged as on offer. */
  onOfferOnly?: boolean;
  /** Restrict to a shelf directly, skipping the disambiguation heuristic. */
  shelf?: string;
  /** Dietary constraints; each must hold. */
  diet?: ("vegan" | "vegetarian" | "gluten-free")[];
  limit?: number;
}

interface Row {
  cin: string;
  name: string;
  shelf: string | null;
  department: string | null;
  price: number;
  was_price: number | null;
  discount_pct: number | null;
  pack_quantity: number | null;
  pack_unit: string | null;
  price_per_uom: number | null;
  uom: string | null;
  on_offer: number;
  vegan: number | null;
  vegetarian: number | null;
  no_gluten: number | null;
  rank: number;
}

/**
 * Build an FTS5 MATCH expression across name and shelf.
 *
 * Deliberately unscoped, because product names omit words their shelf
 * supplies: everything on `Tinned Tomatoes` is named "Chopped Tomatoes 400g",
 * so requiring "tinned" in the name would exclude the entire shelf. The name
 * is re-applied as a filter after the shelf is chosen.
 */
function toMatchExpression(term: string): string {
  const tokens = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

const toCandidate = (row: Row): Candidate => ({
  cin: row.cin,
  name: row.name,
  shelf: row.shelf,
  department: row.department,
  price: row.price,
  wasPrice: row.was_price,
  discountPct: row.discount_pct,
  packQuantity: row.pack_quantity,
  packUnit: row.pack_unit,
  pricePerUom: row.price_per_uom,
  uom: row.uom,
  onOffer: row.on_offer === 1,
  vegan: row.vegan === 1,
  vegetarian: row.vegetarian === 1,
  noGluten: row.no_gluten === 1,
  rank: row.rank,
});

/**
 * Normalised token set. Crude plural stripping is enough here because both
 * sides go through it: "tomatoes" and "Tomatoes" both become "tomatoe", which
 * is wrong as English but consistent as a key.
 */
const tokensOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)),
  );

/**
 * Score how well a shelf name matches an ingredient.
 *
 * Coverage (how much of the ingredient the shelf accounts for) dominates, with
 * specificity (how little else the shelf is about) as the tie-break. That
 * ordering is what separates `Onions & Leeks` from `Pickled Onions &
 * Vegetables` — both cover "onions", but the second is mostly about other
 * things.
 */
function scoreShelf(shelfName: string, termTokens: Set<string>): number {
  const shelfTokens = tokensOf(shelfName);
  let matched = 0;
  for (const token of termTokens) if (shelfTokens.has(token)) matched++;
  if (matched === 0) return 0;
  const coverage = matched / termTokens.size;
  const specificity = matched / shelfTokens.size;
  return coverage * 2 + specificity;
}

/**
 * Shelves for staples whose bare name is genuinely ambiguous.
 *
 * Scoring can't separate these: "milk" scores `Whole Milk` and `Milk Drinks`
 * identically (both cover the term, both are half about something else), so
 * the tie-break falls to shelf size and picks the wrong one — banana milkshake
 * for milk, peanut butter for butter. Which one a recipe means is world
 * knowledge, so it's recorded rather than inferred. An explicit `shelf` option
 * always wins over this.
 */
export const TERM_SHELF_HINTS: Record<string, string> = {
  milk: "Whole Milk",
  "whole milk": "Whole Milk",
  "semi skimmed milk": "Semi Skimmed Milk",
  butter: "Block Butter",
  "butter spread": "Spreadable Butter",
  "spreadable butter": "Spreadable Butter",
  potatoes: "White Potatoes",
  potato: "White Potatoes",
  eggs: "Free Range Eggs",
  egg: "Free Range Eggs",
  yoghurt: "Natural & Greek Yogurts",
  yogurt: "Natural & Greek Yogurts",
  flour: "Plain Flour",
  "plain flour": "Plain Flour",
  rice: "Long Grain & Basmati Rice",
  oil: "Cooking Oil",
  "vegetable oil": "Cooking Oil",
};

export function resolveIngredient(
  db: Database,
  runId: number,
  term: string,
  options: ResolveOptions = {},
): ResolvedIngredient {
  options = options.shelf
    ? options
    : { ...options, shelf: TERM_SHELF_HINTS[term.trim().toLowerCase()] };
  const { onOfferOnly = false, limit = 8 } = options;
  const diet = new Set(options.diet ?? []);

  // One statement text and one parameter set on every call, always. Building
  // the SQL conditionally produced a different prepared statement per option
  // combination while still passing every parameter, and intermittently
  // returned no rows for ingredients that plainly exist. Filters are
  // expressed as no-op comparisons instead so the query never varies.
  const rows = db
    .query<
      Row,
      {
        $run: number; $match: string; $shelf: string | null;
        $onOfferOnly: number; $vegan: number; $vegetarian: number; $glutenFree: number;
      }
    >(`
      SELECT p.cin, p.name, p.shelf, p.department, p.price, p.was_price,
             p.discount_pct, p.pack_quantity, p.pack_unit, p.price_per_uom,
             p.uom, p.on_offer, p.vegan, p.vegetarian, p.no_gluten,
             bm25(product_search) AS rank
      FROM product_search
      JOIN products p ON p.cin = product_search.cin AND p.run_id = product_search.run_id
      WHERE product_search MATCH $match
        AND product_search.run_id = $run
        AND ($onOfferOnly = 0 OR p.on_offer = 1)
        AND ($shelf IS NULL OR p.shelf = $shelf)
        AND ($vegan = 0 OR p.vegan = 1)
        AND ($vegetarian = 0 OR p.vegetarian = 1)
        AND ($glutenFree = 0 OR p.no_gluten = 1)
      ORDER BY rank
      LIMIT 400`)
    .all({
      $run: runId,
      $match: toMatchExpression(term),
      $shelf: options.shelf ?? null,
      $onOfferOnly: onOfferOnly ? 1 : 0,
      $vegan: diet.has("vegan") ? 1 : 0,
      $vegetarian: diet.has("vegetarian") ? 1 : 0,
      $glutenFree: diet.has("gluten-free") ? 1 : 0,
    });

  if (rows.length === 0) {
    return { term, shelf: null, reason: "no-matches", best: undefined, bestOnOffer: undefined, candidates: [], rejected: [], alternativeShelves: [] };
  }

  const all = rows.map(toCandidate);

  // Cluster by shelf, preserving best (lowest) FTS rank per shelf.
  const byShelf = new Map<string, Candidate[]>();
  for (const candidate of all) {
    if (!candidate.shelf) continue;
    const bucket = byShelf.get(candidate.shelf) ?? [];
    bucket.push(candidate);
    byShelf.set(candidate.shelf, bucket);
  }

  let shelf: string | null = options.shelf ?? null;
  let reason: ResolvedIngredient["reason"] = options.shelf ? "shelf-name-match" : "no-shelf-signal";
  let alternativeShelves: ResolvedIngredient["alternativeShelves"] = [];

  if (!shelf && byShelf.size > 0) {
    const shelfTermTokens = tokensOf(term);

    // Prefer the shelf that best describes the ingredient itself. Text
    // relevance is a poor proxy here: it favours short names where the
    // ingredient is a modifier ("Onion Granules", "Garlic Mayo") over the
    // ingredient as head noun ("Brown Onions 1kg").
    const scored = [...byShelf.keys()]
      .map((name) => ({ name, score: scoreShelf(name, shelfTermTokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || (byShelf.get(b.name)?.length ?? 0) - (byShelf.get(a.name)?.length ?? 0));

    if (scored.length > 0) {
      shelf = scored[0]!.name;
      reason = "shelf-name-match";
      // Within 10% of the winner is close enough to be a real alternative.
      alternativeShelves = scored
        .slice(1)
        .filter((entry) => entry.score >= scored[0]!.score * 0.9)
        .map((entry) => ({ shelf: entry.name, score: Math.round(entry.score * 100) / 100, count: byShelf.get(entry.name)?.length ?? 0 }));
    } else {
      // No shelf names the ingredient; fall back to where the matches cluster.
      const votes = new Map<string, number>();
      for (const candidate of all.slice(0, 10)) {
        if (candidate.shelf) votes.set(candidate.shelf, (votes.get(candidate.shelf) ?? 0) + 1);
      }
      shelf = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      reason = shelf ? "most-matches" : "no-shelf-signal";
    }
  }

  const onShelf = shelf ? (byShelf.get(shelf) ?? []) : all;

  // Second stage: within the chosen shelf, the name must still mention the
  // ingredient. This is what drops the ginger from `Garlic & Ginger` — it
  // qualified only because it shares a shelf with garlic, not because it is
  // garlic. Prefer names matching every word, fall back to any.
  const termTokens = tokensOf(term);
  const nameOverlap = (candidate: Candidate): number => {
    const nameTokens = tokensOf(candidate.name);
    let matched = 0;
    for (const token of termTokens) if (nameTokens.has(token)) matched++;
    return matched;
  };
  // Household preferences are applied after the shelf is chosen, so a
  // rejected product still counts as evidence for which shelf is right.
  const rejected: { candidate: Candidate; preferenceId: string }[] = [];
  const permitted = options.ignorePreferences
    ? onShelf
    : onShelf.filter((candidate) => {
        const rejection = rejectionFor(candidate, options.preferences ?? PREFERENCES);
        if (rejection) {
          rejected.push({ candidate, preferenceId: rejection.preferenceId });
          return false;
        }
        return true;
      });
  rejected.sort((a, b) => (a.candidate.pricePerUom ?? Infinity) - (b.candidate.pricePerUom ?? Infinity));

  const fullMatches = permitted.filter((c) => nameOverlap(c) === termTokens.size);
  const anyMatches = permitted.filter((c) => nameOverlap(c) > 0);
  const scoped =
    fullMatches.length > 0 ? fullMatches : anyMatches.length > 0 ? anyMatches : permitted;

  // Rank by unit price, but only within the dominant unit — £/KG and £/EA
  // aren't comparable, and mixing them makes a bag of onions look worse than
  // a single onion.
  const unitCounts = new Map<string, number>();
  for (const candidate of scoped) {
    if (candidate.uom) unitCounts.set(candidate.uom, (unitCounts.get(candidate.uom) ?? 0) + 1);
  }
  const dominantUnit = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const comparable = scoped.filter((candidate) => candidate.uom === dominantUnit);
  const ranked = (comparable.length > 0 ? comparable : scoped).sort(
    (a, b) => (a.pricePerUom ?? Infinity) - (b.pricePerUom ?? Infinity),
  );

  const best = ranked[0];
  const bestOnOffer = ranked.find((candidate) => candidate.onOffer);

  return {
    term,
    shelf,
    reason,
    best,
    bestOnOffer: bestOnOffer && bestOnOffer.cin !== best?.cin ? bestOnOffer : undefined,
    candidates: ranked.slice(0, limit),
    rejected,
    alternativeShelves,
  };
}

/** Latest run ID, which is what a planner almost always wants. */
export function latestRun(db: Database): number {
  const row = db.query<{ id: number }, []>(`SELECT id FROM runs ORDER BY id DESC LIMIT 1`).get();
  if (!row) throw new Error("no snapshot runs — run snapshot.ts first");
  return row.id;
}

if (import.meta.main) {
  const db = new Database(DB_PATH, { readonly: true });
  const runId = latestRun(db);
  const terms = process.argv.slice(2);

  for (const term of terms.length > 0 ? terms : ["onions", "chicken thighs", "rice"]) {
    const resolved = resolveIngredient(db, runId, term);
    const alts = resolved.alternativeShelves.map((a) => a.shelf).join(", ");
    console.log(`\n${term}  ->  shelf: ${resolved.shelf ?? "(none)"}  [${resolved.reason}]${alts ? `  ambiguous with: ${alts}` : ""}`);
    for (const candidate of resolved.candidates.slice(0, 4)) {
      const unit = candidate.pricePerUom != null ? `£${candidate.pricePerUom.toFixed(2)}/${candidate.uom}` : "-";
      const pack = candidate.packQuantity != null ? `${candidate.packQuantity}${candidate.packUnit}` : "-";
      const offer = candidate.onOffer ? `  OFFER${candidate.discountPct ? ` -${candidate.discountPct}%` : ""}` : "";
      console.log(`   ${unit.padEnd(12)} £${String(candidate.price).padEnd(5)} ${pack.padEnd(9)} ${candidate.name}${offer}`);
    }
  }
  db.close();
}
