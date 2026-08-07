/**
 * Record something the household won't eat, so the planner stops proposing it.
 * The reason is required: it is what lets the model avoid the whole class, not
 * just the one word.
 *
 *   bun run dislike                                    list current dislikes
 *   bun run dislike "frankfurters" "processed, vile"   never build a meal round them
 */

import { addDislike, loadDislikes } from "../planning/dislikes";

const [what, reason] = process.argv.slice(2);

if (!what) {
  const dislikes = loadDislikes();
  if (dislikes.length === 0) {
    console.log('no dislikes yet — add one with: bun run dislike "<thing>" "<why>"');
  } else {
    console.log(`${dislikes.length} thing(s) the planner avoids:\n`);
    for (const d of dislikes) console.log(`  ✗ ${d.what.padEnd(24)} ${d.reason}`);
  }
  process.exit(0);
}

if (!reason) {
  console.error('a reason is required: bun run dislike "frankfurters" "processed and taste vile"');
  process.exit(1);
}

const dislikes = addDislike(what, reason);
console.log(`noted: ${what} (${reason})`);
console.log(`the planner now avoids ${dislikes.length} thing(s)`);
