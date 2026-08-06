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
import { costPlan, type Recipe } from "./plan";
import { DB_PATH, PLAN_PATH, HOUSEHOLD, PEOPLE, ADULT_EQUIVALENT, PANTRY, isPantry } from "./config";

const MODEL = "sonnet";
const MAX_ATTEMPTS = 3;



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

function buildPrompt(offers: OfferRow[], meals: number): string {
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
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
  600g of a 1kg pack, have another use the rest.
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
  lines: ReturnType<typeof costPlan>,
  meals: number,
): string {
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
  const total = lines.reduce((n, l) => n + l.cost, 0);
  const worst = lines
    .filter((l) => l.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6)
    .map((l) => {
      const p = l.product;
      const unit = p?.pricePerUom != null ? ` (£${p.pricePerUom.toFixed(2)}/${p.uom})` : "";
      return `- ${l.term}: £${l.cost.toFixed(2)} — ${l.packs} x ${p?.packQuantity}${p?.packUnit} of "${p?.name}"${unit}, need ${l.needed}${l.unit}, ${l.leftover}${l.unit} wasted`;
    });

  return `${previous}

---

Your previous plan came to £${total.toFixed(2)} against a ceiling of £${budget.toFixed(2)}. It is £${(total - budget).toFixed(2)} over.

The recipes you gave were: ${recipes.map((r) => r.name).join("; ")}

Biggest costs, priced against real pack sizes:
${worst.join("\n")}

Revise the plan to come in under £${budget.toFixed(2)}. Cut or downgrade the
expensive proteins, reduce meat quantities, and lean harder on cheap bulk.
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
function applyPantry(lines: ReturnType<typeof costPlan>): ReturnType<typeof costPlan> {
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

  const basePrompt = buildPrompt(promotedIngredients(db, runId), meals);
  let prompt = basePrompt;
  let best: { recipes: Recipe[]; lines: ReturnType<typeof costPlan>; total: number } | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const recipes = await ask(prompt);
    const lines = applyPantry(costPlan(db, runId, recipes));
    const total = lines.reduce((n, l) => n + l.cost, 0);

    console.log(`attempt ${attempt}: £${total.toFixed(2)} (${total <= budget ? "under" : `£${(total - budget).toFixed(2)} OVER`}) — ${recipes.map((r) => r.name).join("; ")}`);

    if (!best || total < best.total) best = { recipes, lines, total };
    if (total <= budget) break;
    if (attempt < MAX_ATTEMPTS) prompt = buildRevisionPrompt(basePrompt, recipes, lines, meals);
  }

  if (!best) throw new Error("no plan produced");
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
  const cupboard = best.lines.filter((l) => l.staple).map((l) => l.term);
  console.log(`\n  from your cupboard (not bought): ${cupboard.join(", ") || "none"}`);
  console.log(`\n  TOTAL ${money(best.total)} vs budget ${money(budget)} — ${money(best.total / (PEOPLE * meals))}/portion`);
  console.log(`  ${best.lines.filter((l) => l.product?.onOffer).length} of ${best.lines.filter((l) => l.product && l.cost > 0).length} bought lines on promotion`);
  db.close();
}
