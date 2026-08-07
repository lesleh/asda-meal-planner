/**
 * Interactive snack picker.
 *
 * Fills the snack allowance, shows the list, and lets you tick the ones you
 * don't want. Rejected snacks go on the blocklist and are never offered again;
 * the list refills from what's left, instantly, because snacks need no model.
 * When you're happy, it writes the approved list for the cart.
 *
 *   bun run snacks
 */

import { Database } from "bun:sqlite";
import { intro, isCancel, multiselect, note, outro, spinner } from "@clack/prompts";
import { BUDGET, DB_PATH, SNACKS_PATH, ensureDataDir } from "../config";
import { latestRun } from "../planning/ingredients";
import { block, blockedCins } from "../snacks/blocklist";
import { selectSnacks, type SnackPick } from "../snacks/select";

const money = (n: number) => `£${n.toFixed(2)}`;

function pick(db: Database, runId: number, exclude: Set<string>): SnackPick[] {
  return selectSnacks(
    db,
    runId,
    { targetSpend: BUDGET.snackAllowance, maxSpend: BUDGET.maxSnackSpend, exclude },
    0,
  );
}

const db = new Database(DB_PATH, { readonly: true });
const runId = latestRun(db);

intro("Snacks");

// Blocklisted snacks never reappear; the working exclude set grows as you reject.
const exclude = blockedCins();
let snacks = pick(db, runId, exclude);

while (true) {
  if (snacks.length === 0) {
    note("Nothing left to offer. Widen the snapshot or clear some of the blocklist.", "Empty");
    break;
  }

  const total = snacks.reduce((n, s) => n + s.cost, 0);
  const removed = await multiselect({
    message: `${snacks.length} snacks, ${money(total)}. Tick any to remove, or submit with none ticked to accept.`,
    options: snacks.map((s) => ({
      value: s.cin,
      label: `${money(s.cost)}  ${s.name}`,
      hint: s.discountPct ? `-${s.discountPct}%` : undefined,
    })),
    required: false,
  });

  if (isCancel(removed)) {
    outro("Cancelled, nothing written.");
    db.close();
    process.exit(0);
  }

  const toRemove = removed as string[];
  if (toRemove.length === 0) break; // accepted

  const rejected = snacks.filter((s) => toRemove.includes(s.cin));
  block(rejected.map((s) => ({ cin: s.cin, name: s.name })));
  for (const cin of toRemove) exclude.add(cin);

  const s = spinner();
  s.start("Re-picking");
  snacks = pick(db, runId, exclude);
  s.stop(`Removed ${rejected.length}, refilled to ${snacks.length}`);
}

ensureDataDir();
await Bun.write(
  SNACKS_PATH,
  JSON.stringify(
    snacks.map((s) => ({
      cin: s.cin,
      name: s.name,
      packs: s.packs,
      cost: s.cost,
      discountPct: s.discountPct,
    })),
    null,
    2,
  ),
);

const total = snacks.reduce((n, s) => n + s.cost, 0);
outro(`Wrote ${snacks.length} snacks (${money(total)}) to ${SNACKS_PATH}. Add them with: bun run cart --snacks`);
db.close();
