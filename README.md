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

For the deeper picture, see the docs:

- [docs/architecture.md](docs/architecture.md) covers the design principle, the
  snapshot-resolve-cost-plan-cart pipeline, and where state lives.
- [docs/api-notes.md](docs/api-notes.md) is the reverse-engineered map of ASDA's three
  backends: endpoints, auth, the Cloudflare-vs-origin gotcha, and the field quirks.

## Setup

Requires [Bun](https://bun.sh) and the `claude` CLI (already authenticated). No API
key and no other dependencies.

```bash
bun install
bun run cart:setup   # once: install the token bookmarklet (see step 3 below)
```

## Weekly use

The whole flow, from nothing to a filled basket, is four steps.

```bash
# 1. Refresh prices. ~11 requests, about 3 seconds.
bun run snapshot

# 2. Generate and cost a week of meals. Takes 3-12 minutes (it makes a few
#    model calls and revises if it is over budget or wasteful). Writes the
#    plan to data/plan.md (open it to see the recipes and shopping list).
bun run plan 4

# 3. Get a token for your account:
#    log in to asda.com, then click the "ASDA token" bookmark installed by
#    cart:setup. It copies a 30-minute token to your clipboard.

# 4. Fill your basket from that token.
bun run cart
```

Then review the basket at asda.com and check out yourself; the tool never does.

After you have cooked, record what landed so next week varies and improves:

```bash
bun run rate "Chicken Fajitas" loved   # do it again
bun run rate "Liver and Onions" no     # never again
```

Steps 1-2 are read-only and need no token. Step 4 is the only one that writes to
your account. Leftovers from step 2 carry into next week's plan automatically.

## Commands

| Command                                    | What it does                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bun run snapshot`                         | Pull the in-stock food catalogue into `data/snapshot.db` and diff against the previous run             |
| `bun run snapshot:diff`                    | Diff the two most recent runs without fetching                                                         |
| `bun run plan [meals]`                     | Generate recipes, cost them, retry if over budget or wasteful. Defaults to 4 meals. Takes 3-12 minutes |
| `bun run rate`                             | List everything cooked so far, with repeat counts and cost per person                                  |
| `bun run rate "<name>" <loved\|liked\|no>` | Record what the household thought; drives repeats and exclusions                                       |
| `bun run cart:setup`                       | Copy the token-grabbing bookmarklet to your clipboard, with install instructions                       |
| `bun run cart --dry-run`                   | Show the shopping list that would be added, no network                                                 |
| `bun run cart`                             | Add the current plan's shopping list to your ASDA basket (needs a pasted token)                        |
| `bun run search <term>`                    | Resolve an ingredient to products, e.g. `bun run search onions "chicken thighs"`                       |
| `bun test`                                 | Unit tests for pack parsing and ingredient resolution                                                  |
| `bun run check-types`                      | `tsc --noEmit`                                                                                         |

## Configuration

Everything tunable lives in `src/config.ts`.

- `HOUSEHOLD` sets adults, children, the child portion fraction, and the per-portion budget
- `PANTRY` lists ingredients assumed already owned, so a plan does not buy a litre of oil to use 45ml
- `STORE_ID` selects the store that stock and pricing are scoped to
- `PREFERENCES` in `src/preferences.ts` rejects products the household won't eat
- `DIETARY_NOTES` in the same file guides the model without filtering products

## Preferences

A preference has to be enforced twice, and the second place is easy to miss. The
model emits a search term ("chicken thighs"); the resolver picks the product.
Telling the model "no bones" achieves nothing on its own, because the resolver will
still return bone-in thighs as the cheapest match. So each preference carries both a
description for the prompt and a pattern the resolver rejects candidates with.

Not every preference can work that way. "Nothing very spicy" has no lexical signal in
a product name, so it lives in `DIETARY_NOTES`, reaches the prompt, and shapes the
recipes rather than the shopping. Reach for a reject pattern only when the wording is
reliable; it is a blunt instrument and easy to over-apply.

Rejected candidates are kept rather than discarded, so a plan can report what a
preference costs. Avoiding bone-in chicken adds about £4 to a generic "chicken
thighs" line, since bone-in is roughly £2.90/kg against £6.47/kg for boneless
fillets. Note that bone-in is only 65-70% edible, so the real gap is narrower than
the shelf price suggests.

## Output

A run writes two files.

- `data/plan.md` is the one to read: shopping list with prices, then each recipe with
  its ingredients, resolved products and cooking method.
- `data/plan.json` is the same plan structured, including per-ingredient costs, the
  snapshot run it was priced against, and any warnings. Re-costable and diffable.

Warnings call out ingredients that matched no product, since those silently drop off
the shopping list and understate the total, plus malformed model output such as two
ingredients in one search term.

## Multibuy promotions

ASDA encodes the mechanic in the promotion's name, so "Any 3 for £12" is parsed
rather than looked up. Two mechanics are supported, fixed-price and cheapest-free,
covering 84% of promoted products. Meal-deal style promotions are deliberately left
unpriced: they are pick-one-from-each-group constructs whose structure is not in the
data, and guessing would price three sandwiches as a meal deal.

Pricing happens at the basket rather than the line, because groups are mix-and-match:
three different products in one "Any 3 for £12" group trigger it together. Packs are
taken dearest-first so the discount lands where it is worth most.

The planner will buy up to a multibuy threshold, but only when two guards pass. The
surplus must be worth storing (ambient, frozen, or fresh protein if `WILL_FREEZE`),
which stops it buying 2kg of fresh chicken for a household that eats 700g a week. And
the effective unit price must improve by at least `MIN_STOCKPILE_SAVING`, because a 5%
saving does not justify tying up cash and freezer space.

Deliberate surplus is tracked separately from leftovers. It is inventory, not waste,
so it does not trigger the waste-revision loop, and it carries to next week.

Plans also report near misses, such as "Any 3 for £12: 2 more packs for £7.62, worth
£8.76", so a judgement call stays with you.

## Recipe history

Without memory the planner has no reason to vary: identical inputs produce the same
dishes, and five consecutive development runs all produced a chicken curry. Every plan
is now recorded in `data/history.json`, and the prompt is told what was cooked in the
last six weeks so it avoids repeating them.

Rate a meal and the history starts working for you. Anything marked `loved` or `liked`
is offered back to the model as a candidate, overriding the variety rule. Anything
marked `no` is excluded permanently, not just for six weeks, because a meal nobody ate
should not return simply because time has passed.

```bash
bun run rate                              # what have we had?
bun run rate "Chicken Fajitas" loved      # do that one again
bun run rate "Liver and Onions" no        # never again
```

History is tracked in git, unlike the rest of `data/`. The snapshot rebuilds in three
seconds; a year of "the children actually ate this" does not.

## Snacks

Snacks are handled apart from meals, because they are taste-driven and the household
grazes through them fast. `bun run snacks` fills a snack allowance from genuine
reductions, shows the list as checkboxes, and lets you tick any you don't want. A
rejected snack goes on a blocklist (`data/blocklist.json`, tracked) and is never
offered again, so the list is curated by rejection rather than by rules: the disliked
mince, the aloe water, whatever, one "no" at a time. Rejections refill the list
instantly, since snacks need no model. Accept, and it writes `data/snacks.json`.

The snack list is separate from the meal shop, so the cart can add them independently:
`bun run cart` for the meals, `bun run cart --snacks` for the snacks. Run the meal
plan with `--no-snacks` if you would rather it never touches snacks at all.

## Leftovers

Supermarket pack sizes do not match recipe quantities, so a plan that buys 2kg of
potatoes to cook 800g leaves the rest in the fridge. Two things address that.

First, plans are scored on cost **plus** waste, so a cheaper plan that throws food
away loses to one that eats what it buys. If more than 10% of the shop goes uneaten,
the plan goes back to the model with the itemised leftovers and a request to use
them up.

Second, whatever is genuinely left over persists to `data/carryover.json` and is
offered to the next run as free stock. Each item gets a shelf life derived from its
department, so a plan will build around a bag of frozen peas from last month but
never around fresh chicken from a fortnight ago.

In practice this took a real plan from 21% waste to 8%, and the following week's
plan cooked 200g of carried-over chicken rather than buying more.

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

- **Nothing steers the plan towards multibuy groups.** Promotions are priced correctly
  once products are chosen, but the model picks search terms and the resolver picks the
  cheapest match, so a qualifying group is only ever hit by luck. Preferring a
  multibuy member among near-equal candidates would be the next improvement.
- **Meal-deal promotions are not priced**, so their totals are overestimates.
- **Some units cannot be reconciled.** A recipe wanting "2 onions" against a 1kg bag
  has no per-item weight anywhere in the data. Those lines are flagged rather than
  guessed, and priced as a single pack.
- **Ambiguous ingredients need a hint.** `TERM_SHELF_HINTS` in `src/ingredients.ts`
  records the shelf for staples whose bare name is ambiguous, because scoring cannot
  separate `Whole Milk` from `Milk Drinks`. Tests assert every hint still resolves.
- **Snapshots go stale.** Prices and promotions change daily. Re-run `bun run snapshot`
  before planning.
- **Shelf lives are department-level guesses.** An opened pack does not keep as long
  as a sealed one, and nothing here tracks whether a leftover was opened. Departments
  that match no pattern fall back to 10 days.

## Adding to your basket

`bun run cart` pushes the current plan's shopping list into your ASDA basket. It is
the only part of the tool that writes to ASDA; everything else reads. It fills the
basket and stops. **It never places an order**; you review and check out yourself.

It needs a token bound to your account, which the anonymous guest flow cannot mint.
You paste one from a logged-in browser session; it lasts 30 minutes and is never
stored. The flow is three commands, once for setup and two each time you shop:

```bash
bun run cart:setup      # once: copies a bookmarklet to your clipboard, tells you
                        # how to save it as a browser bookmark

# then, each time you want to shop:
#   1. log in to asda.com and click the bookmark (copies your token)
bun run cart            # 2. reads the token from the clipboard, fills your basket
```

`bun run cart --dry-run` shows the shopping list without touching the network, and
setting `ASDA_TOKEN` overrides the clipboard if you would rather pass it explicitly.

The token's `SLAS.AUTH_TOKEN` cookie is not HttpOnly, so JavaScript can read it
directly: no decryption, no keychain. Its embedded customer id is what targets your
basket rather than an anonymous one; a guest token still works but fills an
anonymous basket instead.

This crosses from reading public data to writing to your account. It is your account
and your groceries, but it is a different category of action, so it is opt-in, one
command, and always leaves the final checkout to you.

## Legal

Uses undocumented endpoints. Fine for personal use at the volume here, roughly 11
requests per snapshot, but very likely against ASDA's terms of use. Do not point it
at anything sustained or high-volume.

## License

[MIT](LICENSE). Note this licenses the planner's own code; it does not grant
any rights over ASDA's data or APIs, and the personal-use caveats above still apply.
