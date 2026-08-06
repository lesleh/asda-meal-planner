/**
 * Budget-constrained meal planning.
 *
 * Generates recipes, costs them in code, and if the plan is over budget hands
 * the model the itemised overspend and asks for a revision. The model never
 * does the arithmetic; it only responds to it.
 *
 *   bun run mealplan.ts [meals]
 */

import { Database } from "bun:sqlite";
import { latestRun } from "./ingredients";
import { costPlan, type Line, type Recipe } from "./plan";
import {
  carryOverIndex, computeWaste, loadCarryOver, saveCarryOver,
} from "./leftovers";
import { DB_PATH, PLAN_PATH, ensureDataDir, HOUSEHOLD, PEOPLE, ADULT_EQUIVALENT, PANTRY, isPantry } from "./config";

const MODEL = "sonnet";
const MAX_ATTEMPTS = 3;
/** Revise if more than this share of the shop ends up uneaten. */
const WASTE_TARGET = 0.1;



interface OfferRow {
  name: string; shelf: string | null; price: number;
  discount_pct: number | null; pack_quantity: number | null;
  pack_unit: string | null; price_per_uom: number | null; uom: string | null;
  promo: string | null;
}

const COOKABLE_DEPARTMENTS = [
  "Meat & Poultry", "Fish & Seafood", "Fresh Vegetables", "Fresh Fruit",
  "Fresh Salad & Stir Fry", "Milk, Butter, Cream & Eggs", "Cheese",
  "Rice, Pasta & Noodles", "Tinned Food", "Condiments & Cooking Ingredients",
  "Cooking Sauces, Meal Kits & Sides", "Frozen Chicken & Meat",
  "Frozen Fish & Seafood", "Frozen Vegetables, Fruit & Herbs",
  "Bread & Rolls", "Cooked Meat", "Home Baking", "Indian & Asian Food",
];

function promotedIngredients(db: Database, runId: number, limit = 120): OfferRow[] {
  const placeholders = COOKABLE_DEPARTMENTS.map(() => "?").join(",");
  return db
    .query<OfferRow, (number | string)[]>(`
      SELECT p.name, p.shelf, p.price, p.discount_pct, p.pack_quantity,
             p.pack_unit, p.price_per_uom, p.uom,
             (SELECT promo_name FROM promos WHERE promos.run_id = p.run_id AND promos.cin = p.cin LIMIT 1) AS promo
      FROM products p
      WHERE p.run_id = ? AND p.on_offer = 1
        AND p.department IN (${placeholders})
        AND p.price_per_uom IS NOT NULL
      ORDER BY p.price_per_uom
      LIMIT ?`)
    .all(runId, ...COOKABLE_DEPARTMENTS, limit);
}

function buildPrompt(offers: OfferRow[], meals: number, carried: string[]): string {
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
  const carriedSection = carried.length
    ? `\nALREADY IN THE FRIDGE from last week — use these up first, they cost nothing:\n${carried.join("\n")}\n`
    : "";
  const lines = offers.map((o) => {
    const pack = o.pack_quantity != null ? `${o.pack_quantity}${o.pack_unit}` : "?";
    const deal = o.promo ?? (o.discount_pct ? `-${o.discount_pct}%` : "reduced");
    return `- ${o.name} | ${pack} | £${o.price} | £${o.price_per_uom}/${o.uom} | ${deal}`;
  });

  return `Plan ${meals} family dinners for a UK household.

HOUSEHOLD: ${HOUSEHOLD.adults} adults and ${HOUSEHOLD.children} children (${PEOPLE} people).
Cook roughly ${ADULT_EQUIVALENT.toFixed(1)} adult portions per meal — children eat less.
Set "serves" to ${PEOPLE} but size quantities for about ${ADULT_EQUIVALENT.toFixed(1)} adult portions.

BUDGET: £${HOUSEHOLD.budgetPerPortion.toFixed(2)} per person per meal.
Total for the whole shop: £${budget.toFixed(2)}. This is a hard ceiling.

ALREADY IN THE CUPBOARD — use freely, they cost nothing and must still be listed
with "staple": true:
${PANTRY.join(", ")}
${carriedSection}

PROMOTED INGREDIENTS (cheapest per unit first):
${lines.join("\n")}

Rules:
- Value beats discount. A promoted premium product at £15/kg is worse than an
  ordinary one at £5/kg. Judge by the £/kg column, not by the fact it's reduced.
- Meat is the biggest cost. Budget roughly 100-125g of raw meat per adult
  portion, not 200g. Use cheaper cuts: thighs over breast, mince, sausages.
- Bulk meals out with potatoes, rice, pasta, pulses, tinned tomatoes and
  frozen vegetables. Children's meals do not need premium protein.
- REUSE ingredients across meals so whole packs get used. If one meal uses
  600g of a 1kg pack, have another use the rest. Leaving most of a pack
  uneaten is treated as waste and will be sent back for revision.
- "term" is what you'd type into a supermarket search: "chicken thighs", not
  a brand name. Keep it short and generic.
- Set "shelf" only when the term is genuinely ambiguous (e.g. term "potatoes",
  shelf "White Potatoes").
- Mark anything from the cupboard list with "staple": true.

Reply with ONLY a JSON array, no prose, no markdown fences:
[{"name":"string","serves":${PEOPLE},"ingredients":[{"term":"string","quantity":0,"unit":"g"|"ml"|"ea","shelf":"string?","staple":true}]}]`;
}

function buildRevisionPrompt(
  previous: string,
  recipes: Recipe[],
  lines: Line[],
  meals: number,
): string {
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
  const total = lines.reduce((n, l) => n + l.cost, 0);
  const waste = computeWaste(lines);
  const overBudget = total > budget;
  const worst = lines
    .filter((l) => l.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6)
    .map((l) => {
      const p = l.product;
      const unit = p?.pricePerUom != null ? ` (£${p.pricePerUom.toFixed(2)}/${p.uom})` : "";
      return `- ${l.term}: £${l.cost.toFixed(2)} — ${l.packs} x ${p?.packQuantity}${p?.packUnit} of "${p?.name}"${unit}, need ${l.needed}${l.unit}, ${l.leftover}${l.unit} wasted`;
    });

  const leftovers = waste.lines
    .slice(0, 8)
    .map((w) => `- ${w.term}: you use only part of the pack, leaving ${w.leftover}${w.unit} of ${w.bought}${w.unit} unused (£${w.value.toFixed(2)} wasted)`);

  const budgetSection = overBudget
    ? `Your plan came to £${total.toFixed(2)} against a ceiling of £${budget.toFixed(2)}. It is £${(total - budget).toFixed(2)} OVER.

Biggest costs, priced against real pack sizes:
${worst.join("\n")}
`
    : `Your plan came to £${total.toFixed(2)}, within the £${budget.toFixed(2)} ceiling. Do not exceed it.
`;

  const wasteSection = waste.total > 0
    ? `£${waste.total.toFixed(2)} of the shop (${((waste.total / total) * 100).toFixed(0)}%) is food you buy but never cook,
because supermarket pack sizes don't match your quantities:

${leftovers.join("\n")}
`
    : "";

  return `${previous}

---

The recipes you gave were: ${recipes.map((r) => r.name).join("; ")}

${budgetSection}
${wasteSection}
Revise the plan so that:
${overBudget ? `- the total comes in under £${budget.toFixed(2)}\n` : ""}- the leftovers above are USED UP, not left in the fridge

To use leftovers, either increase quantities in an existing meal so a whole
pack gets eaten, or change a meal to include that ingredient. Whole packs
eaten beats clever recipes. Keep the same number of meals.
Reply with ONLY the corrected JSON array.`;
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`no JSON array:\n${text.slice(0, 300)}`);
  return body.slice(start, end + 1);
}

async function ask(prompt: string): Promise<Recipe[]> {
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", MODEL, "--output-format", "text"], {
    stdout: "pipe", stderr: "pipe", cwd: "/tmp",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(0, 300)}`);
  return JSON.parse(extractJson(out)) as Recipe[];
}

/** Pantry items are consumed but not bought, so they cost nothing. */
function applyPantry(lines: Line[]): Line[] {
  return lines.map((line) =>
    isPantry(line.term) || line.staple
      ? { ...line, cost: 0, staple: true, note: line.note ?? "from cupboard" }
      : line,
  );
}

if (import.meta.main) {
  const meals = Number(process.argv[2] ?? 4);
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
  const db = new Database(DB_PATH, { readonly: true });
  const runId = latestRun(db);

  console.log(`household: ${HOUSEHOLD.adults} adults + ${HOUSEHOLD.children} children = ${PEOPLE} people (${ADULT_EQUIVALENT.toFixed(1)} adult portions)`);
  console.log(`budget: £${HOUSEHOLD.budgetPerPortion.toFixed(2)}/portion x ${PEOPLE} x ${meals} meals = £${budget.toFixed(2)}\n`);

  const carried = loadCarryOver();
  const carryOver = carryOverIndex(carried);
  if (carried.length) {
    console.log(`carried from last week: ${carried.map((c) => `${c.quantity}${c.unit} ${c.term}`).join(", ")}\n`);
  }

  const basePrompt = buildPrompt(
    promotedIngredients(db, runId),
    meals,
    carried.map((c) => `- ${c.quantity}${c.unit} ${c.term}`),
  );
  let prompt = basePrompt;
  let best: { recipes: Recipe[]; lines: Line[]; total: number; waste: number; score: number } | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const recipes = await ask(prompt);
    const lines = applyPantry(costPlan(db, runId, recipes, carryOver));
    const total = lines.reduce((n, l) => n + l.cost, 0);
    const waste = computeWaste(lines).total;
    // Waste is already inside `total`; counting it again breaks ties towards
    // the plan that actually eats what it buys.
    const score = total + waste;

    const overBudget = total > budget;
    const tooWasteful = total > 0 && waste / total > WASTE_TARGET;
    console.log(
      `attempt ${attempt}: £${total.toFixed(2)} (${overBudget ? `£${(total - budget).toFixed(2)} OVER` : "under budget"}), ` +
      `£${waste.toFixed(2)} wasted (${total > 0 ? ((waste / total) * 100).toFixed(0) : 0}%) — ${recipes.map((r) => r.name).join("; ")}`,
    );

    if (!best || score < best.score) best = { recipes, lines, total, waste, score };
    if (!overBudget && !tooWasteful) break;
    if (attempt < MAX_ATTEMPTS) prompt = buildRevisionPrompt(basePrompt, recipes, lines, meals);
  }

  if (!best) throw new Error("no plan produced");
  ensureDataDir();
  await Bun.write(PLAN_PATH, JSON.stringify(best.recipes, null, 2));

  const money = (n: number) => `£${n.toFixed(2)}`;
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

  for (const recipe of best.recipes) {
    console.log(`\n${"─".repeat(88)}\n${recipe.name}  (serves ${recipe.serves})\n${"─".repeat(88)}`);
    let cost = 0;
    for (const ing of recipe.ingredients) {
      const line = best.lines.find((l) => l.term === ing.term && l.unit === ing.unit);
      if (!line) continue;
      const share = line.needed > 0 ? (ing.quantity / line.needed) * line.cost : 0;
      cost += share;
      console.log(
        `  ${pad(`${ing.quantity}${ing.unit}`, 10)}${pad(ing.term, 22)}` +
        `${pad(line.staple ? "(cupboard)" : (line.product?.name ?? "NO MATCH") + (line.product?.onOffer ? " *" : ""), 40)}` +
        `${money(share).padStart(8)}`,
      );
    }
    console.log(`  ${" ".repeat(72)}${money(cost).padStart(8)}  ${money(cost / recipe.serves)}/person`);
  }

  console.log(`\n${"═".repeat(88)}\nSHOPPING LIST\n${"═".repeat(88)}`);
  for (const line of best.lines.filter((l) => l.product && l.cost > 0).sort((a, b) => b.cost - a.cost)) {
    const p = line.product!;
    console.log(
      `  ${pad(String(line.packs) + " x", 6)}${pad(p.name + (p.onOffer ? " *" : ""), 48)}` +
      `${pad(`${p.packQuantity ?? "?"}${p.packUnit ?? ""}`, 10)}${money(line.cost).padStart(8)}` +
      (line.leftover > 0 ? `   ${line.leftover}${line.unit} spare` : ""),
    );
  }
  // Persist what the plan doesn't cook, so next week can spend it.
  const kept = saveCarryOver(
    best.lines
      .filter((l) => l.leftover > 0 && !l.staple)
      .map((l) => ({
        term: l.term,
        unit: l.unit,
        quantity: l.leftover,
        department: l.department,
        carriedOnly: l.packs === 0,
        previousExpiry: carried.find((c) => c.term === l.term && c.unit === l.unit)?.expiresAt,
      })),
  );

  const cupboard = best.lines.filter((l) => l.staple).map((l) => l.term);
  console.log(`\n  from your cupboard (not bought): ${cupboard.join(", ") || "none"}`);
  const usedCarryOver = best.lines.filter((l) => l.fromCarryOver > 0);
  if (usedCarryOver.length) {
    console.log(`  used from last week's leftovers: ${usedCarryOver.map((l) => `${l.fromCarryOver}${l.unit} ${l.term}`).join(", ")}`);
  }

  console.log(`\n  TOTAL ${money(best.total)} vs budget ${money(budget)} — ${money(best.total / (PEOPLE * meals))}/portion`);
  console.log(`  ${money(best.waste)} (${best.total > 0 ? ((best.waste / best.total) * 100).toFixed(0) : 0}%) left uneaten, carried to next week:`);
  for (const item of kept.slice(0, 8)) {
    const days = Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000));
    console.log(`    ${item.quantity}${item.unit} ${item.term} (keeps ~${days}d)`);
  }
  if (kept.length === 0) console.log("    nothing — the plan eats everything it buys");
  console.log(`  ${best.lines.filter((l) => l.product?.onOffer).length} of ${best.lines.filter((l) => l.product && l.cost > 0).length} bought lines on promotion`);
  db.close();
}
