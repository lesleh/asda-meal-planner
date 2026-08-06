/**
 * Sanity checks on model-generated recipes.
 *
 * These are all things observed in real output: two ingredients mashed into
 * one search term, the same ingredient listed twice in a recipe, and missing
 * cooking steps. None are fatal, so they surface as warnings on the plan
 * rather than rejecting it.
 */

import type { Line, Recipe } from "./plan";

/** "carrots and broccoli" is two shopping items pretending to be one. */
const COMPOUND = /\s+(?:and|&|,|\+)\s+/i;

/**
 * Ingredients that resolved to no product.
 *
 * Serious for real ingredients: the item silently vanishes from the shopping
 * list and the total understates what the shop actually costs. Harmless for
 * cupboard staples, which were never going to be bought.
 */
export function validateResolution(lines: Line[]): string[] {
  return lines
    .filter((line) => !line.product && !line.staple)
    .map(
      (line) =>
        `"${line.term}" matched no product, so ${line.needed}${line.unit} is MISSING ` +
        `from the shopping list and the total is understated`,
    );
}

export function validateRecipes(recipes: Recipe[]): string[] {
  const warnings: string[] = [];

  for (const recipe of recipes) {
    if (!recipe.method || recipe.method.length === 0) {
      warnings.push(`${recipe.name}: no cooking method returned`);
    }

    const seen = new Map<string, number>();
    for (const ingredient of recipe.ingredients) {
      if (COMPOUND.test(ingredient.term)) {
        warnings.push(
          `${recipe.name}: "${ingredient.term}" looks like two ingredients in one term, ` +
            `so only one of them will be priced`,
        );
      }
      const key = `${ingredient.term.toLowerCase()}|${ingredient.unit}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    for (const [key, count] of seen) {
      if (count > 1) {
        warnings.push(`${recipe.name}: "${key.split("|")[0]}" listed ${count} times; quantities were summed`);
      }
    }
  }

  return warnings;
}
