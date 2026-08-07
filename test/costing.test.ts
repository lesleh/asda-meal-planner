import { describe, expect, test } from "bun:test";
import { recipeCosts, type Line, type Recipe } from "../src/planning/costing";

const line = (term: string, needed: number, cost: number): Line => ({
  term,
  unit: "g",
  needed,
  fromCarryOver: 0,
  usedBy: [],
  staple: false,
  product: undefined,
  packs: 0,
  bought: 0,
  leftover: 0,
  cost,
  preferencePremium: 0,
  promoIds: [],
  stockpiled: 0,
});

describe("recipeCosts", () => {
  const recipes: Recipe[] = [
    { name: "Chilli", serves: 5, ingredients: [
      { term: "mince", quantity: 500, unit: "g" },
      { term: "beans", quantity: 400, unit: "g" },
    ] },
    { name: "Bolognese", serves: 5, ingredients: [
      { term: "mince", quantity: 500, unit: "g" },
    ] },
  ];

  test("splits a shared line by each recipe's share of demand", () => {
    // mince: 1kg pack £6 supplies both recipes' 500g, so £3 each.
    const costs = recipeCosts(recipes, [line("mince", 1000, 6), line("beans", 400, 0.8)]);
    expect(costs.get("Chilli")).toEqual({ total: 3.8, perHead: 0.76 });
    expect(costs.get("Bolognese")).toEqual({ total: 3, perHead: 0.6 });
  });

  test("an ingredient with no matching line contributes nothing", () => {
    const costs = recipeCosts(
      [{ name: "Ghost", serves: 2, ingredients: [{ term: "nope", quantity: 1, unit: "ea" }] }],
      [],
    );
    expect(costs.get("Ghost")).toEqual({ total: 0, perHead: 0 });
  });
});
