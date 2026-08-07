import { describe, expect, test } from "bun:test";
import { BOOKMARKLET, readIdentity } from "../src/commands/cart";

// Minimal unsigned JWTs; the code only reads claims, never verifies them.
const jwt = (payload: Record<string, unknown>): string => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
};

describe("readIdentity", () => {
  test("recognises a registered user and pulls the customer id from isb", () => {
    const token = jwt({
      sty: "User",
      isb: "uido:azure::uidn:Test User::rcid:ABC123::chid:ASDA_GROCERIES",
      exp: Math.floor(Date.now() / 1000) + 1800,
    });
    const id = readIdentity(token);
    expect(id.registered).toBe(true);
    expect(id.customerId).toBe("ABC123");
    expect(id.name).toBe("Test User");
  });

  test("treats a guest token as unregistered", () => {
    const token = jwt({ sty: "Guest", isb: "chid:ASDA_GROCERIES", exp: Math.floor(Date.now() / 1000) + 1800 });
    const id = readIdentity(token);
    expect(id.registered).toBe(false);
    expect(id.customerId).toBeUndefined();
  });

  test("surfaces expiry so an old token is rejected before any network call", () => {
    const token = jwt({ sty: "User", isb: "rcid:X", exp: Math.floor(Date.now() / 1000) - 60 });
    expect(readIdentity(token).expiresAt).toBeLessThan(Date.now());
  });
});

describe("bookmarklet", () => {
  test("is a javascript: bookmarklet that reads the token cookie and copies it", () => {
    expect(BOOKMARKLET.startsWith("javascript:")).toBe(true);
    expect(BOOKMARKLET).toContain("SLAS\\.AUTH_TOKEN");
    expect(BOOKMARKLET).toContain("clipboard.writeText");
    // decodeURIComponent turns the stored "Bearer%20eyJ..." back into a usable header.
    expect(BOOKMARKLET).toContain("decodeURIComponent");
  });
});
