import { describe, expect, test } from "bun:test";
import { formatPackSize, parsePackSize } from "../src/asda/packsize";

describe("parsePackSize", () => {
  const cases: [string, string | undefined, string][] = [
    ["120G", "KG", "120g"],
    ["1.75L", "LT", "1750ml"],
    ["4X115G", "KG", "460g (4 x 115g)"],
    ["12X330", "LT", "3960ml (12 x 330ml)"],
    ["EACH", "EA", "1"],
    ["400ML", "LT", "400ml"],
    ["2KG", "KG", "2000g"],
    ["6X38.5", "KG", "231g (6 x 38.5g)"],
    ["4PK", "EA", "4 (4 x 1)"],
    ["80GR", "KG", "80g"],
  ];

  for (const [raw, hint, expected] of cases) {
    test(`${raw} -> ${expected}`, () => {
      const parsed = parsePackSize(raw, hint);
      expect(parsed).toBeDefined();
      expect(formatPackSize(parsed!)).toBe(expected);
    });
  }

  test("rejects a bare number with no unit hint", () => {
    expect(parsePackSize("12X330", undefined)).toBeUndefined();
  });

  test("rejects loose-by-weight rather than inventing a quantity", () => {
    expect(parsePackSize("PER KG", "KG")).toBeUndefined();
  });

  test("rejects an unrecognised unit rather than assuming grams", () => {
    expect(parsePackSize("ASSORTED", "KG")).toBeUndefined();
  });
});
