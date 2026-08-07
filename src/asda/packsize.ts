/**
 * Pack size normalisation.
 *
 * ASDA's `PACK_SIZE` is free text but tightly patterned: `120G`, `1.75L`,
 * `4X115G`, `12X330` (unit omitted), `EACH`. Normalising it to a base unit is
 * what lets a planner reason about "this recipe needs 400g, the pack is 2kg".
 */

/** Base units: mass in grams, volume in millilitres, or a countable item. */
export type PackUnit = "g" | "ml" | "ea";

export interface PackSize {
  /** Total quantity in the base unit, e.g. `4X115G` -> 460. */
  quantity: number;
  unit: PackUnit;
  /** Sub-unit count, e.g. `4X115G` -> 4. One when not a multipack. */
  multiplier: number;
  /** Quantity of a single sub-unit, e.g. `4X115G` -> 115. */
  unitQuantity: number;
  raw: string;
}

const UNIT_ALIASES: Record<string, { unit: PackUnit; scale: number }> = {
  G: { unit: "g", scale: 1 },
  GR: { unit: "g", scale: 1 },
  GRAM: { unit: "g", scale: 1 },
  KG: { unit: "g", scale: 1000 },
  ML: { unit: "ml", scale: 1 },
  CL: { unit: "ml", scale: 10 },
  L: { unit: "ml", scale: 1000 },
  LT: { unit: "ml", scale: 1000 },
  LTR: { unit: "ml", scale: 1000 },
  LITRE: { unit: "ml", scale: 1000 },
};

/** `PRICEPERUOMFORMATTED` suffixes, used when PACK_SIZE omits its unit. */
const UOM_FALLBACK: Record<string, PackUnit> = {
  KG: "g",
  LT: "ml",
  EA: "ea",
};

/**
 * Parse a pack size into a normalised quantity.
 *
 * `unitHint` should be the `/KG`, `/LT` or `/EA` suffix from the formatted
 * unit price. Roughly 1 in 20 pack sizes omit the unit entirely (`12X330`),
 * and the hint is the only way to tell 330ml cans from 330g tins.
 */
export function parsePackSize(
  raw: string | undefined,
  unitHint?: string,
): PackSize | undefined {
  if (!raw) return undefined;

  const text = raw.trim().toUpperCase();
  const fallbackUnit = unitHint ? UOM_FALLBACK[unitHint.toUpperCase()] : undefined;

  if (text === "EACH" || text === "EA") {
    return { quantity: 1, unit: "ea", multiplier: 1, unitQuantity: 1, raw };
  }

  // `4PK`, `16PK` — a countable multipack with no per-item size given.
  const packCount = /^(\d+)\s*(?:PK|PACK)$/.exec(text);
  if (packCount) {
    const count = Number(packCount[1]);
    return { quantity: count, unit: "ea", multiplier: count, unitQuantity: 1, raw };
  }

  // Sold loose by weight; the pack has no fixed quantity to reason about.
  if (text === "PER KG" || text === "PERKG") return undefined;

  // `4X115G`, `12X330`, `6X38.5` — multiplier, sub-quantity, optional unit.
  const multipack = /^(\d+)\s*X\s*(\d+(?:\.\d+)?)\s*([A-Z]*)$/.exec(text);
  if (multipack) {
    const [, count, size, unitText] = multipack as unknown as [string, string, string, string];
    const resolved = resolveUnit(unitText, fallbackUnit);
    if (!resolved) return undefined;
    const unitQuantity = Number(size) * resolved.scale;
    return {
      quantity: unitQuantity * Number(count),
      unit: resolved.unit,
      multiplier: Number(count),
      unitQuantity,
      raw,
    };
  }

  // `120G`, `1.75L`, `400ML`, or a bare number.
  const single = /^(\d+(?:\.\d+)?)\s*([A-Z]*)$/.exec(text);
  if (single) {
    const [, size, unitText] = single as unknown as [string, string, string];
    const resolved = resolveUnit(unitText, fallbackUnit);
    if (!resolved) return undefined;
    const quantity = Number(size) * resolved.scale;
    return { quantity, unit: resolved.unit, multiplier: 1, unitQuantity: quantity, raw };
  }

  return undefined;
}

function resolveUnit(
  unitText: string,
  fallback: PackUnit | undefined,
): { unit: PackUnit; scale: number } | undefined {
  if (unitText) {
    const known = UNIT_ALIASES[unitText];
    if (known) return known;
    // An unrecognised suffix is safer to reject than to guess at.
    return undefined;
  }
  return fallback ? { unit: fallback, scale: 1 } : undefined;
}

/** Human-readable form, e.g. `460g (4 x 115g)`. */
export function formatPackSize(pack: PackSize): string {
  const total = pack.unit === "ea" ? `${pack.quantity}` : `${round(pack.quantity)}${pack.unit}`;
  if (pack.multiplier === 1) return total;
  return `${total} (${pack.multiplier} x ${round(pack.unitQuantity)}${pack.unit === "ea" ? "" : pack.unit})`;
}

const round = (n: number): number => Math.round(n * 100) / 100;
