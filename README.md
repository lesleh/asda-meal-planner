# ASDA Meal Planner

Builds budget-constrained family meal plans from ASDA's current promotional pricing.

Snapshots the in-stock food catalogue into SQLite, asks a model for recipes built
around what is actually discounted, then prices the plan in code and sends it back
for revision if it misses the budget.

## Why it works this way

The model picks dishes and resolves ambiguity. Code does every piece of arithmetic.
That split matters: models are good at "chicken thighs and rice make a traybake" and
unreliable at "three 700g joints for 1,500g of demand at £4.67 each". Anything that
adds up is done here, and the model only responds to the result.

## Setup

Requires [Bun](https://bun.sh) and the `claude` CLI (already authenticated). No API
key and no other dependencies.

```bash
bun install
bun run snapshot     # ~11 requests, about 3 seconds
bun run plan         # generate and cost a meal plan
```

## Commands

| Command                 | What it does                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `bun run snapshot`      | Pull the in-stock food catalogue into `data/snapshot.db` and diff against the previous run |
| `bun run snapshot:diff` | Diff the two most recent runs without fetching                                             |
| `bun run plan [meals]`  | Generate recipes, cost them, retry if over budget. Defaults to 4 meals                     |
| `bun run search <term>` | Resolve an ingredient to products, e.g. `bun run search onions "chicken thighs"`           |
| `bun test`              | Unit tests for pack parsing and ingredient resolution                                      |
| `bun run check-types`   | `tsc --noEmit`                                                                             |

## Configuration

Everything tunable lives in `src/config.ts`.

- `HOUSEHOLD` sets adults, children, the child portion fraction, and the per-portion budget
- `PANTRY` lists ingredients assumed already owned, so a plan does not buy a litre of oil to use 45ml
- `STORE_ID` selects the store that stock and pricing are scoped to

## How the data is sourced

Three separate ASDA backends, all reached without any account credentials.

- **Algolia** (`src/search.ts`) is the product search index. Public search key, no auth.
  Carries prices, promotions, stock per store, the category tree and dietary flags.
  The `AllOffers_EN` rule context is what the site's own offers page uses.
- **Salesforce Commerce** (`src/slas.ts`, `src/products.ts`) supplies full product
  detail including Brandbank nutrition and allergens. Mints its own guest token via
  the public PKCE flow, so nothing depends on a captured browser session. Optional:
  meal planning does not need it.
- **Amplience** (`src/amplience.ts`) serves CMS page templates. Included for
  completeness; not used by the planner.

Note that the Salesforce API is reached at its origin host rather than through
`www.asda.com/mobify/proxy/`, which sits behind bot protection.

## Known limitations

- **Multibuy promotions are not priced.** "Any 3 for £5" is recorded per product but
  the basket is costed at single-item prices, so the total is an overestimate for
  plans that trigger a multibuy.
- **Some units cannot be reconciled.** A recipe wanting "2 onions" against a 1kg bag
  has no per-item weight anywhere in the data. Those lines are flagged rather than
  guessed, and priced as a single pack.
- **Ambiguous ingredients need a hint.** `TERM_SHELF_HINTS` in `src/ingredients.ts`
  records the shelf for staples whose bare name is ambiguous, because scoring cannot
  separate `Whole Milk` from `Milk Drinks`. Tests assert every hint still resolves.
- **Snapshots go stale.** Prices and promotions change daily. Re-run `bun run snapshot`
  before planning.

## Legal

Uses undocumented endpoints. Fine for personal use at the volume here, roughly 11
requests per snapshot, but very likely against ASDA's terms of use. Do not point it
at anything sustained or high-volume.
