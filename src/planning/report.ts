/**
 * Plan artifacts.
 *
 * The terminal output is ephemeral, so a plan is also written as JSON (for
 * re-costing and diffing) and Markdown (to actually cook and shop from).
 * Both carry the resolved products and prices, not just the model's output.
 */

import type { CarryOverItem } from "./leftovers";
import type { Line, Recipe } from "./costing";
import type { BasketPricing } from "./multibuy";

export interface CostedIngredient {
  term: string;
  quantity: number;
  unit: string;
  staple: boolean;
  /** Undefined when nothing matched, or when it came from the cupboard. */
  product?: { cin: string; name: string; onOffer: boolean };
  /** This recipe's share of the pack cost. */
  cost: number;
  fromCarryOver: boolean;
  note?: string;
}

export interface CostedRecipe {
  name: string;
  serves: number;
  method: string[];
  ingredients: CostedIngredient[];
  cost: number;
  costPerPerson: number;
}

export interface ShoppingItem {
  cin: string;
  name: string;
  packs: number;
  packSize: string;
  price: number;
  cost: number;
  onOffer: boolean;
  leftover: number;
  unit: string;
}

export interface PlanArtifact {
  generatedAt: string;
  snapshotRunId: number;
  storeId: string;
  household: { adults: number; children: number; people: number };
  budget: { cap: number; portions: number };
  totals: {
    mealCost: number;
    costPerPortion: number; onOfferLines: number; preferencePremium: number;
  };
  recipes: CostedRecipe[];
  shoppingList: ShoppingItem[];
  cupboard: string[];
  carriedIn: CarryOverItem[];
  carriedOut: CarryOverItem[];
  warnings: string[];
  multibuy: BasketPricing;
}

export interface BuildArtifactInput {
  recipes: Recipe[];
  lines: Line[];
  runId: number;
  storeId: string;
  household: { adults: number; children: number; people: number };
  budget: { cap: number; portions: number };
  mealCost: number;
  carriedIn: CarryOverItem[];
  carriedOut: CarryOverItem[];
  warnings: string[];
  multibuy: BasketPricing;
  now?: Date;
}

export function buildArtifact(input: BuildArtifactInput): PlanArtifact {
  const { recipes, lines, now = new Date() } = input;
  const byKey = new Map(lines.map((line) => [`${line.term}|${line.unit}`, line]));

  const costedRecipes: CostedRecipe[] = recipes.map((recipe) => {
    const ingredients: CostedIngredient[] = recipe.ingredients.map((ingredient) => {
      const line = byKey.get(`${ingredient.term}|${ingredient.unit}`);
      // Apportion the pack cost by this recipe's share of total demand, so
      // recipe costs sum exactly to the shopping list.
      const share =
        line && line.needed > 0 ? (ingredient.quantity / line.needed) * line.cost : 0;
      return {
        term: ingredient.term,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        staple: line?.staple ?? Boolean(ingredient.staple),
        product:
          line?.product && !line.staple
            ? { cin: line.product.cin, name: line.product.name, onOffer: line.product.onOffer }
            : undefined,
        cost: Math.round(share * 100) / 100,
        fromCarryOver: (line?.fromCarryOver ?? 0) > 0,
        note: line?.note,
      };
    });

    const cost = ingredients.reduce((sum, item) => sum + item.cost, 0);
    return {
      name: recipe.name,
      serves: recipe.serves,
      method: recipe.method ?? [],
      ingredients,
      cost: Math.round(cost * 100) / 100,
      costPerPerson: Math.round((cost / Math.max(1, recipe.serves)) * 100) / 100,
    };
  });

  const shoppingList: ShoppingItem[] = lines
    .filter((line) => line.product && line.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((line) => ({
      cin: line.product!.cin,
      name: line.product!.name,
      packs: line.packs,
      packSize: `${line.product!.packQuantity ?? "?"}${line.product!.packUnit ?? ""}`,
      price: line.product!.price,
      cost: line.cost,
      onOffer: line.product!.onOffer,
      leftover: Math.round(line.leftover * 100) / 100,
      unit: line.unit,
    }));

  return {
    generatedAt: now.toISOString(),
    snapshotRunId: input.runId,
    storeId: input.storeId,
    household: input.household,
    budget: input.budget,
    totals: {
      mealCost: Math.round(input.mealCost * 100) / 100,
      costPerPortion: Math.round((input.mealCost / Math.max(1, input.budget.portions)) * 100) / 100,
      onOfferLines: shoppingList.filter((item) => item.onOffer).length,
      preferencePremium:
        Math.round(input.lines.reduce((sum, line) => sum + line.preferencePremium, 0) * 100) / 100,
    },
    recipes: costedRecipes,
    shoppingList,
    cupboard: [...new Set(lines.filter((line) => line.staple).map((line) => line.term))],
    carriedIn: input.carriedIn,
    carriedOut: input.carriedOut,
    warnings: input.warnings,
    multibuy: input.multibuy,
  };
}

const money = (value: number): string => `£${value.toFixed(2)}`;

/** Human-readable plan: something to cook and shop from. */
export function renderMarkdown(plan: PlanArtifact): string {
  const out: string[] = [];
  const date = plan.generatedAt.slice(0, 10);

  out.push(`# Meal plan, ${date}`);
  out.push("");
  out.push(
    `${plan.recipes.length} meals for ${plan.household.adults} adults and ` +
      `${plan.household.children} children. ` +
      `**${money(plan.totals.mealCost)}** (${money(plan.totals.costPerPortion)} per portion). ` +
      `Snacks are a separate list (\`bun run snacks\`).`,
  );
  out.push("");

  if (plan.carriedIn.length > 0) {
    out.push("Using up from the last shop: " +
      plan.carriedIn.map((item) => `${item.quantity}${item.unit} ${item.term}`).join(", ") + ".");
    out.push("");
  }

  out.push("## Shopping list");
  out.push("");
  out.push("| Qty | Item | Pack | Cost | Spare |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const item of plan.shoppingList) {
    out.push(
      `| ${item.packs} | ${item.name}${item.onOffer ? " **(offer)**" : ""} | ${item.packSize} | ` +
        `${money(item.cost)} | ${item.leftover > 0 ? `${item.leftover}${item.unit}` : "-"} |`,
    );
  }
  out.push(`| | **Total** | | **${money(plan.totals.mealCost)}** | |`);
  out.push("");

  if (plan.multibuy.saving > 0) {
    out.push(`Multibuy promotions took ${money(plan.multibuy.saving)} off this shop:`);
    out.push("");
    for (const promo of plan.multibuy.applied) {
      out.push(`- ${promo.promoName} on ${promo.qualifying} packs, saving ${money(promo.saving)}`);
    }
    out.push("");
  }

  if (plan.multibuy.nearMisses.length > 0) {
    out.push("Worth knowing: a few more packs would trigger further offers.");
    out.push("");
    for (const miss of plan.multibuy.nearMisses.slice(0, 5)) {
      out.push(`- ${miss.promoName}: ${miss.need} more pack(s) for ${money(miss.extraCost)}, worth ${money(miss.extraValue)}`);
    }
    out.push("");
  }

  if (plan.totals.preferencePremium > 0) {
    out.push(
      `Household preferences added ${money(plan.totals.preferencePremium)} to this shop, ` +
        `by ruling out cheaper products that don't suit.`,
    );
    out.push("");
  }

  if (plan.cupboard.length > 0) {
    out.push(`From your cupboard, not bought: ${plan.cupboard.join(", ")}.`);
    out.push("");
  }

  out.push("## Recipes");
  out.push("");

  for (const recipe of plan.recipes) {
    out.push(`### ${recipe.name}`);
    out.push("");
    out.push(`Serves ${recipe.serves} · ${money(recipe.cost)} · ${money(recipe.costPerPerson)} per person`);
    out.push("");
    out.push("**Ingredients**");
    out.push("");
    for (const ingredient of recipe.ingredients) {
      const source = ingredient.staple
        ? "from the cupboard"
        : ingredient.fromCarryOver
          ? `${ingredient.product?.name ?? "?"}, using the last shop's`
          : (ingredient.product?.name ?? "**no product matched**");
      out.push(`- ${ingredient.quantity}${ingredient.unit} ${ingredient.term} — ${source}`);
    }
    out.push("");

    if (recipe.method.length > 0) {
      out.push("**Method**");
      out.push("");
      recipe.method.forEach((step, index) => out.push(`${index + 1}. ${step}`));
      out.push("");
    }
  }

  if (plan.carriedOut.length > 0) {
    out.push("## Carries to the next shop");
    out.push("");
    out.push("Prep-required surplus only. Anything ready-to-eat is assumed eaten.");
    out.push("");
    for (const item of plan.carriedOut) {
      const days = Math.max(
        0,
        Math.round((new Date(item.expiresAt).getTime() - new Date(plan.generatedAt).getTime()) / 86_400_000),
      );
      out.push(`- ${item.quantity}${item.unit} ${item.term}, keeps about ${days} days`);
    }
    out.push("");
  }

  if (plan.warnings.length > 0) {
    out.push("## Warnings");
    out.push("");
    for (const warning of plan.warnings) out.push(`- ${warning}`);
    out.push("");
  }

  return out.join("\n");
}
