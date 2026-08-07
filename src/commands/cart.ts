/**
 * Push the meal plan and the snack list into an ASDA basket.
 *
 * Plan and snacks are separate concerns written by separate commands; this is
 * the one place they meet. It adds whichever files exist and skips the missing.
 *
 * This is the one part of the tool that writes to ASDA rather than reading, and
 * it needs a token bound to your account, which the guest flow can't mint. You
 * paste one from a logged-in browser session (see `bun run cart --help`); it
 * lives 30 minutes and is never stored.
 *
 * Hard line: this fills a basket and stops. It never places an order. Review
 * and check out yourself in the browser.
 *
 *   bun run cart --help
 *   bun run cart --dry-run
 *   ASDA_TOKEN="$(pbpaste)" bun run cart
 */

import { ASDA_COMMERCE } from "../asda/commerce";
import { BUDGET, PLAN_PATH, SNACKS_PATH } from "../config";

const BASE = `https://${ASDA_COMMERCE.shortCode}.api.commercecloud.salesforce.com`;
const SITE = ASDA_COMMERCE.channelId;

export const BOOKMARKLET =
  "javascript:(()=>{const m=document.cookie.match(/SLAS\\.AUTH_TOKEN=([^;]+)/);" +
  "if(!m){alert('Not logged in to asda.com, or the token has expired.');return;}" +
  "navigator.clipboard.writeText(decodeURIComponent(m[1]));" +
  "alert('ASDA token copied. Paste it into the terminal.');})()";

function help(): void {
  console.log(`Fill your ASDA basket from the meal plan and the snack list.

The plan and snacks are separate: \`bun run plan\` writes the meals, \`bun run
snacks\` writes the snacks. This adds whichever exist, so run either or both
first. If one is missing it is simply skipped.

One-time setup:

  bun run cart:setup    Copies a bookmarklet to your clipboard and explains how
                        to save it as a browser bookmark.

Each time you want to shop:

  1. Log in to asda.com and click the bookmark. It copies your token.
  2. bun run cart       Reads the token from the clipboard and fills your basket.

Other:

  bun run cart --dry-run    Show what would be added, no network, no token needed.

The token lasts 30 minutes and is never stored. It is read from the clipboard,
or from the ASDA_TOKEN environment variable if that is set. This fills the
basket and stops; it never checks out.`);
}

interface CartItem {
  cin: string;
  name: string;
  packs: number;
  cost: number;
}

interface Plan {
  generatedAt: string;
  shoppingList: CartItem[];
}

/** The meal plan's shopping list, or nothing if no plan has been generated. */
async function loadPlan(): Promise<CartItem[]> {
  const file = Bun.file(PLAN_PATH);
  if (!(await file.exists())) return [];
  const plan = (await file.json()) as Plan;
  return plan.shoppingList.filter((item) => item.packs > 0);
}

/** The separately-approved snack list, or nothing if none was written. */
async function loadSnacks(): Promise<CartItem[]> {
  const file = Bun.file(SNACKS_PATH);
  if (!(await file.exists())) return [];
  const snacks = (await file.json()) as CartItem[];
  return snacks.filter((item) => item.packs > 0);
}

/** Decode a JWT payload without verifying it; we only read our own claims. */
export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("token is not a JWT");
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

interface Identity {
  registered: boolean;
  /** Registered customer id, from the token. Undefined for a guest. */
  customerId?: string;
  name?: string;
  expiresAt: number;
}

export function readIdentity(token: string): Identity {
  const claims = decodeClaims(token);
  const isb = String(claims.isb ?? "");
  const rcid = /rcid:([^:]+)/.exec(isb)?.[1];
  const name = /uidn:([^:]+)/.exec(isb)?.[1];
  return {
    registered: claims.sty === "User" && Boolean(rcid),
    customerId: rcid,
    name,
    expiresAt: Number(claims.exp ?? 0) * 1000,
  };
}

async function api(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${BASE}${path}${sep}siteId=${SITE}`, {
    ...init,
    headers: {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

/** The customer's current basket, or a freshly created one. */
async function resolveBasket(token: string, identity: Identity): Promise<string> {
  if (identity.registered && identity.customerId) {
    const existing = await api(
      `/customer/shopper-customers/v1/organizations/${ASDA_COMMERCE.organizationId}/customers/${identity.customerId}/baskets`,
      token,
    );
    if (existing.ok) {
      const body = (await existing.json()) as { baskets?: { basketId: string }[] };
      const basket = body.baskets?.[0]?.basketId;
      if (basket) {
        console.log(`  using your existing basket ${basket}`);
        return basket;
      }
    }
  }

  const created = await api(
    `/checkout/shopper-baskets/v1/organizations/${ASDA_COMMERCE.organizationId}/baskets`,
    token,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (!created.ok) {
    throw new Error(`could not create a basket (HTTP ${created.status}): ${(await created.text()).slice(0, 200)}`);
  }
  const basket = ((await created.json()) as { basketId: string }).basketId;
  console.log(`  created basket ${basket}`);
  return basket;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) return help();
  if (args.has("--bookmarklet")) return installBookmarklet();

  // Plan and snacks are separate files. Add whichever exist; skip the missing.
  const plan = await loadPlan();
  const snacks = await loadSnacks();
  const items = [...plan, ...snacks];
  if (items.length === 0) {
    console.log("nothing to add — run `bun run plan` and/or `bun run snacks` first");
    return;
  }

  const show = (label: string, group: CartItem[]): void => {
    if (group.length === 0) return;
    console.log(`${label}: ${group.length} items`);
    for (const item of group) {
      console.log(`  ${item.packs} x ${item.name}  (cin ${item.cin})  £${item.cost.toFixed(2)}`);
    }
  };
  show("meals", plan);
  show("snacks", snacks);

  const total = items.reduce((sum, item) => sum + item.cost, 0);
  console.log(`total £${total.toFixed(2)}`);
  if (total < BUDGET.deliveryMinimum) {
    console.log(`under the £${BUDGET.deliveryMinimum} delivery minimum — add more before you can check out`);
  }

  if (args.has("--dry-run")) {
    console.log("\ndry run — nothing sent. Drop --dry-run and supply a token to add these.");
    return;
  }

  const raw = (process.env.ASDA_TOKEN ?? (await clipboard()))?.trim();
  if (!raw) {
    console.error("\nno token. Run `bun run cart --help` for how to get one.");
    process.exit(1);
  }
  const token = raw.replace(/^Bearer%20/i, "Bearer ");

  const identity = readIdentity(token);
  if (identity.expiresAt < Date.now()) {
    console.error("\nthat token has expired — grab a fresh one and try again.");
    process.exit(1);
  }
  console.log(
    `\ntoken: ${identity.registered ? `your account${identity.name ? ` (${identity.name})` : ""}` : "a guest session, so this fills an anonymous basket, not your account"}`,
  );

  const basketId = await resolveBasket(token, identity);

  // One call with every line; the API takes an array of items.
  const add = await api(
    `/checkout/shopper-baskets/v1/organizations/${ASDA_COMMERCE.organizationId}/baskets/${basketId}/items`,
    token,
    {
      method: "POST",
      body: JSON.stringify(items.map((item) => ({ productId: item.cin, quantity: item.packs }))),
    },
  );

  if (!add.ok) {
    console.error(`\nadding items failed (HTTP ${add.status}): ${(await add.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const basket = (await add.json()) as {
    productItems?: { productId: string; productName: string; quantity: number; price: number }[];
    productTotal?: number;
  };
  const added = new Set((basket.productItems ?? []).map((line) => line.productId));
  const missing = items.filter((item) => !added.has(item.cin));

  console.log(`\nadded ${added.size} of ${items.length} lines. Basket total £${basket.productTotal?.toFixed(2)}`);
  if (missing.length > 0) {
    console.log("not added (out of stock or unavailable), add these yourself:");
    for (const item of missing) console.log(`  ${item.packs} x ${item.name}`);
  }
  console.log("\nReview and check out at https://www.asda.com/ — this tool never places the order.");
}

/** Read the macOS clipboard, so `pbpaste` isn't needed on the command line. */
async function clipboard(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe" });
    return (await new Response(proc.stdout).text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Write to the macOS clipboard. */
export async function writeClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
  proc.stdin.write(text);
  await proc.stdin.end();
  await proc.exited;
}

/** Copy the bookmarklet to the clipboard, then explain how to install it. */
async function installBookmarklet(): Promise<void> {
  await writeClipboard(BOOKMARKLET);
  console.log(`Bookmarklet copied to your clipboard.

To install it:
  1. Open your browser's bookmark manager (Chrome: Bookmarks > Bookmark Manager).
  2. Add a new bookmark. Name it e.g. "ASDA token".
  3. Paste the clipboard into the URL field and save.
     (Paste into the bookmark manager's URL box, NOT the address bar — Chrome
     strips the leading "javascript:" if you paste there.)

To use it:
  1. Log in to asda.com.
  2. Click the "ASDA token" bookmark. It copies your token to the clipboard.
  3. Back here, run:  bun run cart

The token lasts 30 minutes and is never stored.`);
}

if (import.meta.main) await main();
