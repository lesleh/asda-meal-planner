/**
 * Household culinary preferences.
 *
 * These have to be enforced in two places, and the second is easy to miss.
 * The model emits a search term ("chicken thighs"); the resolver picks the
 * product. Telling the model "no bones" does nothing if `resolveIngredient`
 * then returns bone-in thighs because they are cheapest per kg. So each
 * preference carries both a description for the prompt and a pattern the
 * resolver rejects candidates with.
 */

export interface Preference {
  /** Short id, used in warnings and premium reporting. */
  id: string;
  /** Natural language, passed to the model. */
  description: string;
  /** Products whose name or shelf matches are rejected. */
  reject: RegExp;
  /**
   * Escape hatch, checked first. Bone-in thighs and boneless thigh fillets
   * both say "thigh", so the reject pattern needs an exemption rather than
   * an ever more baroque negative lookahead.
   */
  allow?: RegExp;
}

export const PREFERENCES: Preference[] = [
  {
    id: "no-bones",
    description:
      "No chicken or meat on the bone. The children won't eat it. " +
      "Use breast fillets, boneless thigh fillets, mince or diced meat.",
    reject: /drumstick|chicken wing|leg quarter|on the bone|bone-in|whole chicken|spare rib|thigh/i,
    allow: /boneless|fillet|mince|diced/i,
  },
];

export interface Rejection {
  preferenceId: string;
  description: string;
}

/** The preference a product falls foul of, if any. */
export function rejectionFor(
  product: { name: string; shelf?: string | null },
  preferences: Preference[] = PREFERENCES,
): Rejection | undefined {
  const text = `${product.name} ${product.shelf ?? ""}`;
  for (const preference of preferences) {
    if (preference.allow?.test(text)) continue;
    if (preference.reject.test(text)) {
      return { preferenceId: preference.id, description: preference.description };
    }
  }
  return undefined;
}

/** Prompt-facing lines, so the model plans meals that fit in the first place. */
export function preferenceLines(preferences: Preference[] = PREFERENCES): string[] {
  return preferences.map((preference) => `- ${preference.description}`);
}
