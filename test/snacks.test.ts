import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { DB_PATH } from "../src/config";
import { latestRun } from "../src/ingredients";
import { selectSnacks } from "../src/snacks";

const fixed = () => 0.5; // deterministic ordering for assertions

/** Small seeded PRNG so "vary" can use two reproducible sequences. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
import { isGrazeable } from "../src/grazeable";

const db = new Database(DB_PATH, { readonly: true });
let runId: number;
beforeAll(() => { runId = latestRun(db); });

describe("selectSnacks", () => {
  test("fills the gap up to the delivery floor", () => {
    const mealCost = 26;
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, mealCost, fixed);
    const total = mealCost + picks.reduce((n, p) => n + p.cost, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  test("never spends more than maxSpend on snacks", () => {
    // Meals at zero would demand £40 of snacks; the cap must hold.
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 8 }, 0, fixed);
    expect(picks.reduce((n, p) => n + p.cost, 0)).toBeLessThanOrEqual(8);
  });

  test("only picks grazeable items", () => {
    const picks = selectSnacks(db, runId, { targetSpend: 40, maxSpend: 15 }, 26);
    for (const p of picks) expect(isGrazeable(p.department, p.shelf, p.name)).toBe(true);
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

describe("snacks exclude drinks", () => {
  test("no squash, juice, fizzy or water in the snack list", () => {
    const picks = selectSnacks(db, latestRun(db), { targetSpend: 20, maxSpend: 25 }, 0);
    for (const p of picks) {
      expect(`${p.department} ${p.name}`).not.toMatch(/squash|cordial|juice|fizzy|smoothie|\bwater\b/i);
    }
  });
});

describe("snack variety", () => {
  test("different randomness gives different lists", () => {
    const a = selectSnacks(db, latestRun(db), { targetSpend: 15, maxSpend: 22 }, 0, seeded(1));
    const b = selectSnacks(db, latestRun(db), { targetSpend: 15, maxSpend: 22 }, 0, seeded(999));
    // Not identical: the same frozen list every run was the whole complaint.
    expect(a.map((p) => p.cin).join()).not.toBe(b.map((p) => p.cin).join());
  });
});
