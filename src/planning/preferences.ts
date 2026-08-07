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

/** The children will not eat meat on the bone. */
export const NO_BONES: Preference = {
  id: "no-bones",
  description:
    "No chicken or meat on the bone. The children won't eat it. " +
    "Use breast fillets, boneless thigh fillets, mince or diced meat.",
  reject: /drumstick|chicken wing|leg quarter|on the bone|bone-in|whole chicken|spare rib|thigh/i,
  allow: /boneless|fillet|mince|diced/i,
};

/**
 * Active preferences.
 *
 * Add sparingly. A reject pattern is a blunt instrument and it is easy to rule
 * out more than intended, so anything without a clear lexical signal in the
 * product name belongs in `DIETARY_NOTES` instead.
 */
export const PREFERENCES: Preference[] = [NO_BONES];

/**
 * Guidance passed to the model but never used to filter products.
 *
 * The home for anything with no lexical signal in a product name. "Nothing
 * too spicy" cannot be pattern-matched the way "drumstick" can, so it has to
 * shape the recipes rather than the shopping.
 */
export const DIETARY_NOTES: string[] = [
  "Nothing very spicy; mild flavours for the children.",
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

/**
 * Prompt-facing lines. Includes notes that have no matching filter, since the
 * model is the only thing that can act on those.
 */
export function preferenceLines(
  preferences: Preference[] = PREFERENCES,
  notes: string[] = DIETARY_NOTES,
): string[] {
  return [...preferences.map((p) => `- ${p.description}`), ...notes.map((n) => `- ${n}`)];
}
