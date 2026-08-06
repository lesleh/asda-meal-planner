import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { DB_PATH } from "../src/config";
import { latestRun } from "../src/ingredients";
import { selectSnacks } from "../src/snacks";
import { isGrazeable } from "../src/grazeable";

const db = new Database(DB_PATH, { readonly: true });
let runId: number;
beforeAll(() => { runId = latestRun(db); });

describe("selectSnacks", () => {
  test("fills the gap up to the delivery floor", () => {
    const mealCost = 26;
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, mealCost);
    const total = mealCost + picks.reduce((n, p) => n + p.cost, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  test("never spends more than maxSpend on snacks", () => {
    // Meals at zero would demand £40 of snacks; the cap must hold.
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 8 }, 0);
    expect(picks.reduce((n, p) => n + p.cost, 0)).toBeLessThanOrEqual(8);
  });

  test("only picks grazeable items", () => {
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, 26);
    for (const p of picks) expect(isGrazeable(p.department, undefined, p.name)).toBe(true);
  });

  test("only picks genuine reductions, never a plain list price", () => {
    // Every pick is flagged on offer; the query filters to Rollback/Dropped.
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, 26);
    for (const p of picks) expect(p.onOffer).toBe(true);
  });

  test("respects the exclude set", () => {
    const first = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, 26);
    if (first.length === 0) return;
    const exclude = new Set([first[0]!.cin]);
    const second = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15, exclude }, 26);
    expect(second.map((p) => p.cin)).not.toContain(first[0]!.cin);
  });
});

describe("snack variety", () => {
  test("caps how many come from any one department", () => {
    const picks = selectSnacks(
      db, latestRun(db),
      { targetSpend: 60, maxSpend: 25, maxPerDepartment: 3 },
      0,
    );
    const byDept = new Map<string, number>();
    for (const p of picks) byDept.set(p.department ?? "?", (byDept.get(p.department ?? "?") ?? 0) + 1);
    for (const n of byDept.values()) expect(n).toBeLessThanOrEqual(3);
  });
});
