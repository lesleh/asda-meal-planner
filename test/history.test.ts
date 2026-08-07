import { describe, expect, test } from "bun:test";
import { favourites, historyKey, rate, recordPlan, toAvoid, type RecipeRecord } from "../src/planning/history";
import type { Recipe } from "../src/planning/costing";

const recipe = (name: string): Recipe => ({
  name, serves: 5, method: ["Cook."], ingredients: [{ term: "onions", quantity: 100, unit: "g" }],
});

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

describe("historyKey", () => {
  test("ignores casing and punctuation so trivial variants share a record", () => {
    expect(historyKey("Chicken Korma with Rice & Naan")).toBe(historyKey("chicken korma with rice and naan"));
  });

  test("drops filler words so wording variants collapse", () => {
    expect(historyKey("Sausage and Bean Casserole")).toBe("sausage bean casserole");
  });

  test("keeps genuinely different dishes apart", () => {
    expect(historyKey("Chicken Korma")).not.toBe(historyKey("Chicken Tikka Masala"));
  });
});

describe("recordPlan", () => {
  test("counts repeats rather than duplicating", () => {
    let history = recordPlan([], [recipe("Chilli")], new Map(), at(14));
    history = recordPlan(history, [recipe("Chilli")], new Map(), at(0));
    expect(history).toHaveLength(1);
    expect(history[0]!.timesPlanned).toBe(2);
  });

  // A verdict is the expensive input here; regenerating a plan must not lose it.
  test("preserves a verdict across replanning", () => {
    let history = recordPlan([], [recipe("Chilli")], new Map(), at(14));
    history[0]!.verdict = "loved";
    history = recordPlan(history, [recipe("Chilli")], new Map(), at(0));
    expect(history[0]!.verdict).toBe("loved");
  });

  test("keeps the first-planned date", () => {
    let history = recordPlan([], [recipe("Chilli")], new Map(), at(30));
    const first = history[0]!.firstPlanned;
    history = recordPlan(history, [recipe("Chilli")], new Map(), at(0));
    expect(history[0]!.firstPlanned).toBe(first);
  });
});

describe("toAvoid", () => {
  test("lists meals cooked inside the window", () => {
    const history = recordPlan([], [recipe("Chilli")], new Map(), at(7));
    expect(toAvoid(history, 6).map((a) => a.name)).toEqual(["Chilli"]);
  });

  test("forgets meals older than the window", () => {
    const history = recordPlan([], [recipe("Chilli")], new Map(), at(70));
    expect(toAvoid(history, 6)).toEqual([]);
  });

  // A meal nobody ate shouldn't return just because time passed.
  test("always avoids anything rejected, however long ago", () => {
    const history = recordPlan([], [recipe("Liver")], new Map(), at(365));
    history[0]!.verdict = "no";
    expect(toAvoid(history, 6)[0]!.reason).toBe("was not eaten");
  });
});

describe("favourites", () => {
  const built = (): RecipeRecord[] => {
    const h = recordPlan([], [recipe("A"), recipe("B"), recipe("C")], new Map(), at(1));
    h.find((r) => r.name === "A")!.verdict = "liked";
    h.find((r) => r.name === "B")!.verdict = "loved";
    h.find((r) => r.name === "C")!.verdict = "no";
    return h;
  };

  test("ranks loved above liked and excludes rejects", () => {
    expect(favourites(built()).map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("rate", () => {
  test("matches on a partial name", () => {
    const history = recordPlan([], [recipe("Chicken Korma with Rice and Naan")], new Map());
    expect(rate(history, "chicken korma", "loved")?.verdict).toBe("loved");
  });

  test("returns undefined for an unknown meal", () => {
    expect(rate(recordPlan([], [recipe("Chilli")], new Map()), "Paella", "liked")).toBeUndefined();
  });
});
