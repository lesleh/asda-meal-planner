/**
 * Push a plan's shopping list into an ASDA basket.
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

import { ASDA_COMMERCE } from "./slas";
import { PLAN_PATH } from "./config";

const BASE = `https://${ASDA_COMMERCE.shortCode}.api.commercecloud.salesforce.com`;
const SITE = ASDA_COMMERCE.channelId;

const BOOKMARKLET =
  "javascript:(()=>{const m=document.cookie.match(/SLAS\\.AUTH_TOKEN=([^;]+)/);" +
  "if(!m){alert('Not logged in to asda.com, or the token has expired.');return;}" +
  "navigator.clipboard.writeText(decodeURIComponent(m[1]));" +
  "alert('ASDA token copied. Paste it into the terminal.');})()";

function help(): void {
  console.log(`Push the current plan's shopping list into your ASDA basket.

Getting a token (it lasts 30 minutes, and is never stored):

  1. Log in to asda.com in your browser.
  2. Easiest: make a bookmark with this as its URL, then click it while on asda.com:

${BOOKMARKLET}

     It copies the token to your clipboard.

  3. Or, in the browser devtools Console on asda.com, run:

     copy(decodeURIComponent(document.cookie.match(/SLAS\\.AUTH_TOKEN=([^;]+)/)[1]))

Then, in this directory:

  bun run cart --dry-run          # show what would be added, no network
  ASDA_TOKEN="$(pbpaste)" bun run cart   # add to your basket from the clipboard

The token is read from the ASDA_TOKEN environment variable, or from the
clipboard (pbpaste) if that is unset. It fills the basket and stops; it never
checks out.`);
}

interface ShoppingItem {
  cin: string;
  name: string;
  packs: number;
  cost: number;
}

interface Plan {
  generatedAt: string;
  shoppingList: ShoppingItem[];
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

  const plan = (await Bun.file(PLAN_PATH).json()) as Plan;
  const items = plan.shoppingList.filter((item) => item.packs > 0);
  if (items.length === 0) {
    console.log("nothing to add — run `bun run plan` first");
    return;
  }

  console.log(`plan from ${plan.generatedAt.slice(0, 10)}: ${items.length} items`);
  for (const item of items) {
    console.log(`  ${item.packs} x ${item.name}  (cin ${item.cin})  £${item.cost.toFixed(2)}`);
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

/** macOS clipboard, so `pbpaste` isn't needed in the command line. */
async function clipboard(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe" });
    return (await new Response(proc.stdout).text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) await main();
