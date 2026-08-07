import { describe, expect, test } from "bun:test";
import { dislikeLines, mergeDislike, parseBans, type Dislike } from "../src/planning/dislikes";

const at = "2026-01-01T00:00:00.000Z";
const now = new Date(at);

describe("mergeDislike", () => {
  test("adds a trimmed entry with a timestamp", () => {
    const result = mergeDislike([], "  frankfurters ", "  vile ", now);
    expect(result).toEqual([{ what: "frankfurters", reason: "vile", addedAt: at }]);
  });

  test("replaces an existing entry for the same thing, case-insensitively", () => {
    const existing: Dislike[] = [{ what: "Frankfurters", reason: "old reason", addedAt: "2025-01-01T00:00:00.000Z" }];
    const result = mergeDislike(existing, "frankfurters", "processed and vile", now);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ what: "frankfurters", reason: "processed and vile", addedAt: at });
  });

  test("keeps unrelated entries", () => {
    const existing: Dislike[] = [{ what: "offal", reason: "texture", addedAt: at }];
    const result = mergeDislike(existing, "frankfurters", "vile", now);
    expect(result.map((d) => d.what)).toEqual(["offal", "frankfurters"]);
  });
});

describe("dislikeLines", () => {
  test("renders thing and reason for the prompt", () => {
    expect(dislikeLines([{ what: "frankfurters", reason: "vile", addedAt: at }])).toEqual([
      "- frankfurters (vile)",
    ]);
  });
});

describe("parseBans", () => {
  test("splits a thing and reason on a dash", () => {
    expect(parseBans("frankfurters - processed and vile")).toEqual([
      { what: "frankfurters", reason: "processed and vile" },
    ]);
  });

  test("splits on a colon too", () => {
    expect(parseBans("offal: texture")).toEqual([{ what: "offal", reason: "texture" }]);
  });

  test("gives a bare thing a default reason", () => {
    expect(parseBans("frankfurters")).toEqual([
      { what: "frankfurters", reason: "the household won't eat it" },
    ]);
  });

  test("handles a comma-separated mix and ignores blanks", () => {
    expect(parseBans("frankfurters - vile, offal, , tripe: rubbery")).toEqual([
      { what: "frankfurters", reason: "vile" },
      { what: "offal", reason: "the household won't eat it" },
      { what: "tripe", reason: "rubbery" },
    ]);
  });

  test("empty input yields nothing", () => {
    expect(parseBans("   ")).toEqual([]);
  });
});
