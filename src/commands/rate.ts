/**
 * Record what the household thought of a meal.
 *
 *   bun run rate                          list what's been cooked
 *   bun run rate "Chicken Korma" loved    mark it a favourite
 *   bun run rate "Sausage Bake" no        never plan it again
 */

import { loadHistory, rate, saveHistory, type Verdict } from "../planning/history";

const VERDICTS: Verdict[] = ["loved", "liked", "no"];

const records = loadHistory();
const [name, verdict] = process.argv.slice(2);

if (!name) {
  if (records.length === 0) {
    console.log("nothing cooked yet — run `bun run plan` first");
  } else {
    console.log(`${records.length} meals planned so far:\n`);
    for (const record of records) {
      const mark = record.verdict === "loved" ? "★" : record.verdict === "liked" ? "+" : record.verdict === "no" ? "✗" : " ";
      const cost = record.lastCostPerPerson != null ? `£${record.lastCostPerPerson.toFixed(2)}/person` : "";
      console.log(
        `  ${mark} ${record.name.padEnd(46)} ${String(record.timesPlanned).padStart(2)}x  ` +
          `${record.lastPlanned.slice(0, 10)}  ${cost}`,
      );
    }
    console.log(`\nrate one with: bun run rate "<name>" <${VERDICTS.join("|")}>`);
  }
  process.exit(0);
}

if (!verdict || !VERDICTS.includes(verdict as Verdict)) {
  console.error(`verdict must be one of: ${VERDICTS.join(", ")}`);
  process.exit(1);
}

const matched = rate(records, name, verdict as Verdict);
if (!matched) {
  console.error(`no meal matching "${name}". Run \`bun run rate\` to see the list.`);
  process.exit(1);
}

saveHistory(records);
console.log(`${matched.name}: ${verdict}`);
if (verdict === "no") console.log("it won't be suggested again");
if (verdict !== "no") console.log("it may come back in a future plan");
