/**
 * Household dislikes.
 *
 * Things the household won't eat, captured one "yuck" at a time with the reason
 * attached. Unlike a preference (a product-level reject pattern) a dislike is
 * fed to the model at generation time, so it never builds a meal around them in
 * the first place. That matters: a pure product reject would let the model
 * write a frankfurter recipe and then fail to buy the frankfurters, leaving a
 * broken dish. The reason travels with it so the model can generalise to the
 * class, not just the literal word.
 *
 * Kept local (gitignored): personal taste, so it never goes to the public repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR, DISLIKES_PATH } from "../config";

export interface Dislike {
  /** The ingredient or thing, e.g. "frankfurters". */
  what: string;
  /** Why, in the household's words. Passed to the model to help it generalise. */
  reason: string;
  addedAt: string;
}

const key = (what: string): string => what.trim().toLowerCase();

/**
 * Add a dislike, replacing any existing entry for the same thing so a reason
 * can be updated and nothing duplicates. Pure: the IO wrapper is `addDislike`.
 */
export function mergeDislike(
  existing: Dislike[],
  what: string,
  reason: string,
  now: Date = new Date(),
): Dislike[] {
  const kept = existing.filter((d) => key(d.what) !== key(what));
  return [...kept, { what: what.trim(), reason: reason.trim(), addedAt: now.toISOString() }];
}

/** Prompt lines for the WILL NOT EAT section, reason included. */
export function dislikeLines(dislikes: Dislike[]): string[] {
  return dislikes.map((d) => `- ${d.what} (${d.reason})`);
}

/**
 * Parse a review ban list like "frankfurters - vile, offal: texture" into
 * dislikes. Splits on commas, then the first " - " or ":" into thing and
 * reason. A bare "frankfurters" gets a default reason. Pure, so the review can
 * capture bans in one keystroke and the parsing stays testable.
 */
export function parseBans(input: string): { what: string; reason: string }[] {
  return input
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const split = /^(.*?)\s*[-:]\s*(.+)$/.exec(piece);
      return split
        ? { what: split[1]!.trim(), reason: split[2]!.trim() }
        : { what: piece, reason: "the household won't eat it" };
    })
    .filter((ban) => ban.what.length > 0);
}

export function loadDislikes(): Dislike[] {
  if (!existsSync(DISLIKES_PATH)) return [];
  try {
    return JSON.parse(readFileSync(DISLIKES_PATH, "utf8")) as Dislike[];
  } catch {
    return [];
  }
}

export function addDislike(what: string, reason: string, now: Date = new Date()): Dislike[] {
  const merged = mergeDislike(loadDislikes(), what, reason, now);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DISLIKES_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
