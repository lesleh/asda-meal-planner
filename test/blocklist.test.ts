import { describe, expect, test } from "bun:test";
import { block, blockedCins, loadBlocklist } from "../src/snacks/blocklist";

// These touch data/blocklist.json; each test namespaces its CINs and cleans up.
describe("blocklist", () => {
  test("blocking adds items and blockedCins reflects them", () => {
    const before = loadBlocklist();
    block([{ cin: "test-A1", name: "Grim Mince" }]);
    expect(blockedCins().has("test-A1")).toBe(true);
    // restore
    const { writeFileSync } = require("node:fs");
    const { BLOCKLIST_PATH } = require("../src/config");
    writeFileSync(BLOCKLIST_PATH, JSON.stringify(before, null, 2));
  });

  test("blocking the same CIN twice does not duplicate", () => {
    const before = loadBlocklist();
    block([{ cin: "test-B1", name: "Aloe Water" }]);
    const after = block([{ cin: "test-B1", name: "Aloe Water" }]);
    expect(after.filter((i) => i.cin === "test-B1")).toHaveLength(1);
    const { writeFileSync } = require("node:fs");
    const { BLOCKLIST_PATH } = require("../src/config");
    writeFileSync(BLOCKLIST_PATH, JSON.stringify(before, null, 2));
  });
});
