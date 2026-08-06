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
import { buildArtifact, renderMarkdown } from "./report";
import { validateRecipes, validateResolution } from "./validate";
import { preferenceLines } from "./preferences";
import { isGrazeable } from "./grazeable";
import { selectSnacks, type SnackPick } from "./snacks";
import { loadRules, priceBasket, type BasketItem } from "./multibuy";
import { favourites, loadHistory, recordPlan, saveHistory, toAvoid } from "./history";
import { carryOverIndex, loadCarryOver, saveCarryOver } from "./leftovers";
import { DB_PATH, HISTORY_PATH, PLAN_MD_PATH, PLAN_PATH, STORE_ID, ensureDataDir, HOUSEHOLD, PEOPLE, ADULT_EQUIVALENT, PANTRY, isPantry, BUDGET } from "./config";

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

function buildPrompt(
  offers: OfferRow[],
  meals: number,
  carried: string[],
  avoid: { name: string; reason: string }[],
  liked: { name: string; verdict?: string }[],
): string {
  const budget = HOUSEHOLD.budgetPerPortion * PEOPLE * meals;
  const avoidSection = avoid.length
    ? `\nALREADY COOKED RECENTLY — do NOT repeat these, and avoid anything that is
essentially the same dish under another name. Variety is the point:
${avoid.map((a) => `- ${a.name} (${a.reason})`).join("\n")}\n`
    : "";
  const likedSection = liked.length
    ? `\nMEALS THIS HOUSEHOLD LIKED — include one or two if they fit the budget and
the promoted ingredients. These override the variety rule:
${liked.map((l) => `- ${l.name}${l.verdict === "loved" ? " (a favourite)" : ""}`).join("\n")}\n`
    : "";
  const carriedSection = carried.length
    ? `\nALREADY IN THE FRIDGE from the last shop — use these up first, they cost nothing:\n${carried.join("\n")}\n`
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

COST: keep meals economical, aiming around £${HOUSEHOLD.budgetPerPortion.toFixed(2)} per person
per meal (£${budget.toFixed(2)} for the ${meals} meals). Cheaper is better; a separate snack
allowance tops the shop up afterwards, so you do not need to hit any total here.

ALREADY IN THE CUPBOARD — use freely, they cost nothing and must still be listed
with "staple": true:
${PANTRY.join(", ")}
${carriedSection}${avoidSection}${likedSection}

PROMOTED INGREDIENTS (cheapest per unit first):
${lines.join("\n")}

HOUSEHOLD PREFERENCES — these are hard constraints, not suggestions:
${preferenceLines().join("\n")}

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
- ONE ingredient per entry. Never "carrots and broccoli" or "salt and pepper";
  those are two entries. A term with "and" in it cannot be shopped for.
- Never list the same ingredient twice in one recipe. Add the quantities up.
- Give a "method": an array of short numbered cooking steps, enough for
  someone to actually cook the meal. Six to ten steps is usually right.

Reply with ONLY a JSON array, no prose, no markdown fences:
[{"name":"string","serves":${PEOPLE},
  "method":["step one","step two"],
  "ingredients":[{"term":"string","quantity":0,"unit":"g"|"ml"|"ea","shelf":"string?","staple":true}]}]`;
}

function buildRevisionPrompt(
  previous: string,
  recipes: Recipe[],
  lines: Line[],
): string {
  const total = lines.reduce((n, l) => n + l.cost, 0);
  const worst = lines
    .filter((l) => l.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6)
    .map((l) => {
      const p = l.product;
      const unit = p?.pricePerUom != null ? ` (£${p.pricePerUom.toFixed(2)}/${p.uom})` : "";
      return `- ${l.term}: £${l.cost.toFixed(2)} for ${l.packs} x ${p?.packQuantity}${p?.packUnit} of "${p?.name}"${unit}`;
    });

  return `${previous}

---

The recipes you gave were: ${recipes.map((r) => r.name).join("; ")}

Your plan came to £${total.toFixed(2)} for the meals, over the £${BUDGET.cap.toFixed(2)} cap.
The biggest costs, priced against real pack sizes, were:
${worst.join("\n")}

Bring it under £${BUDGET.cap.toFixed(2)} by cutting or downgrading the expensive
proteins, reducing meat quantities, and leaning harder on cheap bulk (potatoes,
rice, pasta, pulses, tinned tomatoes, frozen veg). Keep the same number of meals.
Keep the "method" steps for any meal you leave unchanged, and write new ones
for any meal you change. Reply with ONLY the corrected JSON array.`;
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`no JSON array:\n${text.slice(0, 300)}`);
  return body.slice(start, end + 1);
}

/**
 * A model call takes 3-4 minutes and there are up to three of them, so say
 * what is happening before blocking rather than only after. A silent minute
 * is indistinguishable from a hang.
 */
async function ask(prompt: string, label: string): Promise<Recipe[]> {
  const started = Date.now();
  process.stdout.write(`  ${label}: asking ${MODEL} (${(prompt.length / 1000).toFixed(1)}k chars)... `);
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", MODEL, "--output-format", "text"], {
    stdout: "pipe", stderr: "pipe", cwd: "/tmp",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  console.log(`${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(0, 300)}`);
  return JSON.parse(extractJson(out)) as Recipe[];
}

/** Purchased packs, as the multibuy pricer wants them. */
function toBasket(lines: Line[]): BasketItem[] {
  return lines
    .filter((line) => line.product && line.cost > 0 && line.packs > 0)
    .map((line) => ({
      cin: line.product!.cin,
      name: line.product!.name,
      packs: line.packs,
      price: line.product!.price,
      promoIds: line.promoIds,
    }));
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
  const db = new Database(DB_PATH, { readonly: true });
  const runId = latestRun(db);

  console.log(`household: ${HOUSEHOLD.adults} adults + ${HOUSEHOLD.children} children = ${PEOPLE} people (${ADULT_EQUIVALENT.toFixed(1)} adult portions)`);
  console.log(`shop must clear the £${BUDGET.deliveryMinimum} delivery minimum; keep meals under the £${BUDGET.cap} cap\n`);

  const carried = loadCarryOver();
  const carryOver = carryOverIndex(carried);
  if (carried.length) {
    console.log(`carried from last shop: ${carried.map((c) => `${c.quantity}${c.unit} ${c.term}`).join(", ")}\n`);
  }

  // Measured, not guessed: 170-260s per call, and the revision prompt is
  // longer than the first so later attempts are slower.
  console.log(`up to ${MAX_ATTEMPTS} model calls at roughly 3-4 minutes each; expect 3-12 minutes\n`);
  const runStarted = Date.now();

  const history = loadHistory();
  const avoid = toAvoid(history);
  const liked = favourites(history);
  if (avoid.length) console.log(`avoiding ${avoid.length} recently cooked meals`);
  if (liked.length) console.log(`may bring back: ${liked.map((r) => r.name).join(", ")}`);

  const basePrompt = buildPrompt(
    promotedIngredients(db, runId),
    meals,
    carried.map((c) => `- ${c.quantity}${c.unit} ${c.term}`),
    avoid,
    liked,
  );
  let prompt = basePrompt;
  const rules = loadRules(db, runId);
  let best:
    | { recipes: Recipe[]; lines: Line[]; total: number; basket: ReturnType<typeof priceBasket> }
    | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const recipes = await ask(prompt, `attempt ${attempt}/${MAX_ATTEMPTS}`);
    const lines = applyPantry(costPlan(db, runId, recipes, carryOver));
    const gross = lines.reduce((n, l) => n + l.cost, 0);
    const basket = priceBasket(toBasket(lines), rules);
    // Multibuys are priced across the whole basket, so the discount lands
    // here rather than on any single line.
    const total = Math.round((gross - basket.saving) * 100) / 100;

    // No waste term any more: this household eats surplus rather than binning
    // it, so a bigger pack is more food, not waste. The only thing to steer on
    // is keeping the meals under the cap; the snack pass tops up to the floor.
    const overCap = total > BUDGET.cap;
    console.log(
      `attempt ${attempt}: meals £${total.toFixed(2)} ` +
      `(${overCap ? `£${(total - BUDGET.cap).toFixed(2)} over the £${BUDGET.cap} cap` : "within cap"}) — ` +
      recipes.map((r) => r.name).join("; "),
    );

    if (!best || total < best.total) best = { recipes, lines, total, basket };
    if (!overCap) break;
    if (attempt < MAX_ATTEMPTS) prompt = buildRevisionPrompt(basePrompt, recipes, lines);
  }

  if (!best) throw new Error("no plan produced");

  // Snacks are a deliberate line the children will graze through, not just
  // gap-filler. Spend the allowance every shop, and more if the meals leave
  // the cart short of the delivery minimum.
  const mealCost = best.total; // already net of the multibuy saving
  const inBasket = new Set(best.lines.filter((l) => l.product).map((l) => l.product!.cin));
  const snackTargetCart = Math.max(
    BUDGET.deliveryMinimum,
    mealCost + BUDGET.snackAllowance,
  );
  const snacks = selectSnacks(db, runId, {
    targetSpend: snackTargetCart,
    maxSpend: BUDGET.maxSnackSpend,
    exclude: inBasket,
  }, mealCost);
  const snackCost = Math.round(snacks.reduce((n: number, s: SnackPick) => n + s.cost, 0) * 100) / 100;
  const shopTotal = Math.round((mealCost + snackCost) * 100) / 100;

  if (snacks.length) {
    console.log(`\nsnack allowance (grazed, bought every shop): +£${snackCost.toFixed(2)}`);
    for (const s of snacks) console.log(`  £${s.cost.toFixed(2).padStart(5)}  -${s.discountPct}%  ${s.name}`);
  }
  if (shopTotal < BUDGET.deliveryMinimum) {
    console.log(`\nstill £${(BUDGET.deliveryMinimum - shopTotal).toFixed(2)} under the floor after snacks; add a meal or raise maxSnackSpend`);
  }

  ensureDataDir();

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
  if (snacks.length) {
    console.log(`  ${"-".repeat(84)}\n  snacks & extras (to clear the £${BUDGET.deliveryMinimum} floor):`);
    for (const s of snacks) {
      console.log(`  ${pad("1 x", 6)}${pad(s.name + " *", 48)}${pad("", 10)}${money(s.cost).padStart(8)}`);
    }
  }
  // Persist what the plan doesn't cook, so next week can spend it. Only
  // prep-required items survive: anything ready-to-eat is grazed to nothing by
  // the children within the day, so carrying it forward would be a fiction.
  const kept = saveCarryOver(
    best.lines
      .filter(
        (l) =>
          l.leftover + l.stockpiled > 0 &&
          !l.staple &&
          !isGrazeable(l.department, undefined, l.product?.name),
      )
      .map((l) => ({
        term: l.term,
        unit: l.unit,
        quantity: l.leftover + l.stockpiled,
        department: l.department,
        carriedOnly: l.packs === 0,
        previousExpiry: carried.find((c) => c.term === l.term && c.unit === l.unit)?.expiresAt,
      })),
  );

  const warnings = [...validateResolution(best.lines), ...validateRecipes(best.recipes)];

  const perPerson = new Map<string, number>();
  for (const recipe of best.recipes) {
    const cost = recipe.ingredients.reduce((sum, ing) => {
      const line = best!.lines.find((l) => l.term === ing.term && l.unit === ing.unit);
      return sum + (line && line.needed > 0 ? (ing.quantity / line.needed) * line.cost : 0);
    }, 0);
    perPerson.set(recipe.name, Math.round((cost / Math.max(1, recipe.serves)) * 100) / 100);
  }
  saveHistory(recordPlan(history, best.recipes, perPerson));

  const artifact = buildArtifact({
    recipes: best.recipes,
    lines: best.lines,
    runId,
    storeId: STORE_ID,
    household: { adults: HOUSEHOLD.adults, children: HOUSEHOLD.children, people: PEOPLE },
    budget: { deliveryMinimum: BUDGET.deliveryMinimum, cap: BUDGET.cap, portions: PEOPLE * meals },
    mealCost,
    snacks,
    snackCost,
    shopTotal,
    multibuy: best.basket,
    carriedIn: carried,
    carriedOut: kept,
    warnings,
  });
  await Bun.write(PLAN_PATH, JSON.stringify(artifact, null, 2));
  await Bun.write(PLAN_MD_PATH, renderMarkdown(artifact));

  const cupboard = best.lines.filter((l) => l.staple).map((l) => l.term);
  console.log(`\n  from your cupboard (not bought): ${cupboard.join(", ") || "none"}`);
  if (best.basket.saving > 0) {
    console.log(`  multibuys saved ${money(best.basket.saving)}:`);
    for (const promo of best.basket.applied) {
      console.log(`    ${promo.promoName} on ${promo.qualifying} packs, -${money(promo.saving)}`);
    }
  }
  if (best.basket.nearMisses.length > 0) {
    console.log(`  one more pack would trigger:`);
    for (const miss of best.basket.nearMisses.slice(0, 4)) {
      console.log(`    ${miss.promoName}: ${miss.need} more for ${money(miss.extraCost)}, worth ${money(miss.extraValue)}`);
    }
  }

  const premium = best.lines.reduce((sum, l) => sum + l.preferencePremium, 0);
  if (premium > 0) {
    const byPref = best.lines.filter((l) => l.preferencePremium > 0);
    console.log(`  preferences cost ${money(premium)} extra: ${byPref.map((l) => `${l.term} +${money(l.preferencePremium)}`).join(", ")}`);
  }

  const usedCarryOver = best.lines.filter((l) => l.fromCarryOver > 0);
  if (usedCarryOver.length) {
    console.log(`  used from the last shop's leftovers: ${usedCarryOver.map((l) => `${l.fromCarryOver}${l.unit} ${l.term}`).join(", ")}`);
  }

  const floorNote =
    shopTotal >= BUDGET.deliveryMinimum ? "clears the floor" : "UNDER the floor";
  console.log(
    `\n  meals ${money(mealCost)} + snacks ${money(snackCost)} = TOTAL ${money(shopTotal)} ` +
    `(floor ${money(BUDGET.deliveryMinimum)}, cap ${money(BUDGET.cap)}, ${floorNote})`,
  );
  if (kept.length > 0) {
    console.log(`  carries to next shop (prep-required, survives the kids):`);
    for (const item of kept.slice(0, 8)) {
      const days = Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000));
      console.log(`    ${item.quantity}${item.unit} ${item.term} (keeps ~${days}d)`);
    }
  }
  console.log(`  ${best.lines.filter((l) => l.product?.onOffer).length} of ${best.lines.filter((l) => l.product && l.cost > 0).length} meal lines on promotion`);
  if (warnings.length) {
    console.log(`\n  warnings:`);
    for (const warning of warnings) console.log(`    ${warning}`);
  }
  console.log(`\n  took ${((Date.now() - runStarted) / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  written: ${PLAN_MD_PATH}`);
  console.log(`           ${HISTORY_PATH}`);
  console.log(`           ${PLAN_PATH}`);
  db.close();
}
