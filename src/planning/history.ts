/**
 * Recipe history.
 *
 * Without it the planner has no memory, so identical inputs produce the same
 * dishes every week: five consecutive runs during development all produced a
 * chicken curry. History gives the prompt something to avoid, and gives you
 * somewhere to record the meals worth having again.
 *
 * Stored as readable JSON rather than in the snapshot database, because it is
 * personal usage data that cannot be regenerated: the snapshot rebuilds in
 * three seconds, a year of "the children actually ate this" does not. Kept
 * local (gitignored) like the blocklist and dislikes; the file on disk is the
 * persistence, git tracking would only leak eating habits to a public repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR, HISTORY_PATH } from "../config";
import type { Recipe } from "./costing";

export type Verdict = "loved" | "liked" | "no";

export interface RecipeRecord {
  /** Display name, as generated. */
  name: string;
  /** Normalised name, used as the key. */
  key: string;
  firstPlanned: string;
  lastPlanned: string;
  timesPlanned: number;
  /** Set by hand or via `bun run rate`. Drives what gets suggested again. */
  verdict?: Verdict;
  /** Cost per person the last time it was planned. */
  lastCostPerPerson?: number;
  /** Full recipe, so a favourite can be re-cooked without regenerating it. */
  recipe: Recipe;
}

/** Words that carry no dish identity, dropped so variants collapse together. */
const FILLER = new Set(["and", "with", "the", "a", "an", "of", "in", "on", "served"]);

/**
 * Key a recipe by its dish, not its exact wording. "Chicken Korma with Rice &
 * Naan" and "Chicken Korma with Rice and Naan" are the same meal and must
 * share a record, or the repeat counter and verdicts split in two.
 */
export const historyKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !FILLER.has(word))
    .join(" ");

export function loadHistory(): RecipeRecord[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8")) as RecipeRecord[];
  } catch {
    // Losing history to a parse error would be worse than starting again
    // silently, so this is reported by the caller rather than thrown.
    return [];
  }
}

export function saveHistory(records: RecipeRecord[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(records, null, 2));
}

/** Fold a generated plan into history, preserving verdicts already recorded. */
export function recordPlan(
  existing: RecipeRecord[],
  recipes: Recipe[],
  costPerPerson: Map<string, number>,
  now: Date = new Date(),
): RecipeRecord[] {
  const byKey = new Map(existing.map((record) => [record.key, record]));
  const stamp = now.toISOString();

  for (const recipe of recipes) {
    const key = historyKey(recipe.name);
    const previous = byKey.get(key);
    byKey.set(key, {
      name: recipe.name,
      key,
      firstPlanned: previous?.firstPlanned ?? stamp,
      lastPlanned: stamp,
      timesPlanned: (previous?.timesPlanned ?? 0) + 1,
      verdict: previous?.verdict,
      lastCostPerPerson: costPerPerson.get(recipe.name) ?? previous?.lastCostPerPerson,
      // Keep the newest version; the method may have improved.
      recipe,
    });
  }

  return [...byKey.values()].sort((a, b) => b.lastPlanned.localeCompare(a.lastPlanned));
}

/**
 * Recently planned meals, for the prompt's "don't repeat" list.
 *
 * Anything marked `no` is included regardless of age: a meal that failed
 * should not come back just because enough weeks have passed.
 */
export function toAvoid(
  records: RecipeRecord[],
  weeks = 6,
  now: Date = new Date(),
): { name: string; reason: string }[] {
  const cutoff = now.getTime() - weeks * 7 * 86_400_000;
  const avoid: { name: string; reason: string }[] = [];

  for (const record of records) {
    if (record.verdict === "no") {
      avoid.push({ name: record.name, reason: "was not eaten" });
      continue;
    }
    if (new Date(record.lastPlanned).getTime() >= cutoff) {
      const weeksAgo = Math.max(
        1,
        Math.round((now.getTime() - new Date(record.lastPlanned).getTime()) / (7 * 86_400_000)),
      );
      avoid.push({
        name: record.name,
        reason: weeksAgo === 1 ? "planned last week" : `planned ${weeksAgo} weeks ago`,
      });
    }
  }

  return avoid;
}

/** Meals worth bringing back, best-liked first. */
export function favourites(records: RecipeRecord[], limit = 8): RecipeRecord[] {
  const rank: Record<Verdict, number> = { loved: 0, liked: 1, no: 99 };
  return records
    .filter((record) => record.verdict === "loved" || record.verdict === "liked")
    .sort(
      (a, b) =>
        rank[a.verdict!] - rank[b.verdict!] ||
        a.lastPlanned.localeCompare(b.lastPlanned),
    )
    .slice(0, limit);
}

/** Record what the household thought. Returns undefined if no match. */
export function rate(
  records: RecipeRecord[],
  name: string,
  verdict: Verdict,
): RecipeRecord | undefined {
  const key = historyKey(name);
  const exact = records.find((record) => record.key === key);
  const match =
    exact ?? records.find((record) => record.key.includes(key) || key.includes(record.key));
  if (!match) return undefined;
  match.verdict = verdict;
  return match;
}
