/**
 * Snack blocklist.
 *
 * Rejecting a snack adds it here, and it is never offered again. This is the
 * whole taste-preference layer: rather than encoding rules for what the
 * household dislikes, it is curated one "no" at a time from real lists.
 *
 * Kept local (gitignored): it is personal taste, so it never goes to the
 * public repo and never causes pull conflicts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BLOCKLIST_PATH, DATA_DIR } from "../config";

export interface BlockedItem {
  cin: string;
  name: string;
  blockedAt: string;
}

export function loadBlocklist(): BlockedItem[] {
  if (!existsSync(BLOCKLIST_PATH)) return [];
  try {
    return JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8")) as BlockedItem[];
  } catch {
    return [];
  }
}

/** CINs to exclude from selection. */
export function blockedCins(): Set<string> {
  return new Set(loadBlocklist().map((item) => item.cin));
}

/** Add items to the blocklist, ignoring any already present. */
export function block(
  items: { cin: string; name: string }[],
  now: Date = new Date(),
): BlockedItem[] {
  const existing = loadBlocklist();
  const known = new Set(existing.map((item) => item.cin));
  const additions = items
    .filter((item) => !known.has(item.cin))
    .map((item) => ({ cin: item.cin, name: item.name, blockedAt: now.toISOString() }));

  const merged = [...existing, ...additions];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BLOCKLIST_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
