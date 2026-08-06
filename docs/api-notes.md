# ASDA backend notes

Reverse-engineered from asda.com's own network traffic. None of it is official or
documented by ASDA, and any of it can change without notice. This file is the map,
so the knowledge does not live only in scattered code comments.

Everything here is reachable without an ASDA account, except writing to a basket.

## The three backends

ASDA's grocery site is a headless-commerce PWA sitting on top of three separate
services. The planner uses the first; the others are optional.

| Backend                     | Module                              | Auth                                                           | Carries                                                           |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Algolia                     | `search.ts`                         | Public search key                                              | Prices, promotions, per-store stock, category tree, dietary flags |
| Salesforce Commerce (SCAPI) | `slas.ts`, `products.ts`, `cart.ts` | Self-minted guest token, or a pasted account token for baskets | Full product detail, Brandbank nutrition, baskets                 |
| Amplience                   | `amplience.ts`                      | None                                                           | CMS page templates (labels, layout). Not used by the planner.     |

## Algolia (search and promotions)

Standard Algolia, ASDA is just a tenant.

- Endpoint: `POST https://{appId}-dsn.algolia.net/1/indexes/ASDA_PRODUCTS/query`,
  with three `-1/-2/-3.algolianet.com` fallback hosts for failover.
- App id `8I6WSKCCNV`, public search key `03e4272048dd17f771da37b57ff8a75e`. Both ship
  in asda.com's browser bundle. The key is search-only and rate-limited; it rotates,
  which is why it is overridable rather than hardcoded deep in the client.
- `content-type: application/x-www-form-urlencoded` on a JSON body is deliberate, not
  a bug. It keeps the POST a CORS "simple request" and skips the preflight. Preserve it.

Load-bearing facts discovered the hard way:

- **The "special offers" page is not a separate endpoint.** It is the same index with
  `ruleContexts: ["AllOffers_EN"]`, an Algolia server-side rule that rewrites the query
  to promotional lines only. 23k products becomes ~6k. See `RULE_CONTEXTS` in `search.ts`.
- **The offers rule partitions cleanly** into "has a `PROMOS.EN` entry" or "`WASPRICE >
PRICE`", with nothing left over. That is why `snapshot.ts` derives the `on_offer` flag
  locally instead of issuing a second query, and it doubles as a check on ASDA's rule: if
  the two ever diverge, their merchandising config changed.
- **Store id `4618` is threaded through the filter.** Stock is a nested attribute
  `STOCK.4618`, so the store id appears in both the filter string and the
  `attributesToRetrieve` list. Prices and stock are store-scoped.
- **`NUTRITIONAL_INFO` is in the index**, as 0/1 flags (`Vegan`, `NoGluten`, `Halal`, ...).
  Dietary filtering needs no auth and no second call.
- **The search key can list indexes** (`GET /1/indexes`). That is how the taxonomy and
  the absence of a separate offers index were confirmed. `Enriched_Taxonomy` and
  `Products_query_suggestions` exist alongside `ASDA_PRODUCTS`.
- **Field quirks:** `IS_FROZEN`/`IS_FTO` are real booleans despite the filter DSL
  comparing them numerically (`IS_FTO=0`); `PRICES.EN` is a rich object, not a scalar;
  `PACK_SIZE` is free text (`4X115G`, `12X330`, `EACH`) parsed by `packsize.ts`.
- **`CIN` is ASDA's product id** and the primary key everywhere: Algolia `objectID`,
  SCAPI `productId`, and the basket `productId` are all the same CIN.

## Salesforce Commerce (product detail and baskets)

- Short code `ohwhuw6h`, org `f_ecom_bjgs_prd`, site `ASDA_GROCERIES`. All three are in
  the SLAS token's claims (`ssc`, `aud`, `chid`), which is how they were recovered.
- **Reach SCAPI at its origin host**,
  `https://ohwhuw6h.api.commercecloud.salesforce.com`, not through
  `www.asda.com/mobify/proxy/...`. The proxy path sits behind Cloudflare bot protection
  and returns a 403 challenge page without a `cf_clearance` cookie; the origin returns
  200 clean with just the bearer token.
- **Guest tokens are self-mintable.** `slas.ts` runs the public-client PKCE guest flow
  using client id `e68ca36d-6516-4704-b705-06b74f85ef2e` (from the token's `sub`). The
  authorize step 303-redirects with the auth code in the `Location` header, so redirects
  must not be followed. Tokens last 30 minutes; the client caches with a 60s skew and
  refreshes.
- **A guest token already has basket write scope** (`sfcc.shopper-baskets-orders.rw`).
  SLAS scopes are per-client, not per-user, so even the anonymous token can create and
  fill a basket. It just is not _your_ basket.
- **`c_BRANDBANK_JSON` is double-encoded** JSON, a string inside the parsed response. It
  holds nutrition, allergens, cooking and storage. `products.ts` re-parses it.
- SCAPI namespaces merchant attributes with `c_`; un-prefixed fields are Salesforce's
  own schema. A multi-product request caps at 24 ids.

## Baskets (the only write path)

- Create: `POST /checkout/shopper-baskets/v1/organizations/{org}/baskets`.
- Add: `POST .../baskets/{id}/items` with an array of `{productId, quantity}`. One call
  takes the whole list; the response echoes prices and a `productTotal`.
- **Your account vs a guest basket.** A self-minted guest token fills an anonymous
  basket unconnected to any login. To target your real cart you need a token minted
  after your ASDA login, which goes through Azure AD B2C (`uido:azure_adb2c-signin` in
  the token) and cannot be scripted without your credentials. So `cart.ts` takes a token
  pasted from a logged-in browser session instead.
- **The account token is a readable cookie.** `SLAS.AUTH_TOKEN` is not HttpOnly
  (confirmed via the `is_httponly` flag in Chrome's cookie store), so a one-line
  bookmarklet reads it with `document.cookie` and copies it. No decryption, no keychain.
  It is stored URL-encoded as `Bearer%20eyJ...`; `decodeURIComponent` restores it.
- **The customer id is in the token.** The `isb` claim carries `rcid:<id>`, which is the
  SCAPI customer id. `cart.ts` reads it to find and reuse your existing basket rather
  than creating a duplicate.

## Security and etiquette

- A captured account curl carries live credentials: the bearer, refresh tokens, and
  `cf_clearance`, plus your name and email in the decoded JWT, with read-write scope over
  baskets, orders, addresses and payment instruments. Access tokens die in 30 minutes but
  refresh tokens outlive them, so log out to invalidate a session properly. Prefer
  "Copy as cURL (no cookies)" when capturing.
- Volume is trivial (about 11 requests per snapshot, indistinguishable from browsing) but
  automated access is very likely against ASDA's terms of use. Fine for personal use;
  do not point it at anything sustained or high-volume.
- The tool fills a basket and stops. It never places an order. Checkout stays a human
  step in the browser.
