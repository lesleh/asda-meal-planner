# Architecture

## The one principle

**The model supplies judgement; code supplies arithmetic.**

A language model is good at "chicken thighs and rice make a traybake" and at knowing
that "potatoes" in a recipe means white, not sweet. It is unreliable at "three 700g
joints for 1,500g of demand at £4.67 each, minus a multibuy, apportioned across two
recipes". Every real bug in this project came from the boundary between those two being
in the wrong place.

So the split is strict:

- The model chooses dishes, names ingredients as search terms, pins an ambiguous shelf
  when it knows better than the data, and writes cooking methods.
- Code does every calculation: pack selection, unit conversion, multibuy pricing,
  budget totals, carry-over. The model never sees a total it produced itself treated as
  the answer; it only ever _responds_ to numbers code computed.

When the two disagree, code wins and the discrepancy is reported, never silently
absorbed.

## The pipeline

```
snapshot ──▶ resolve ──▶ cost ──▶ multibuy ──▶ plan loop ──▶ artifact ──▶ cart
 (data)     (fuzzy)    (exact)    (exact)     (model+code)   (output)    (write)
```

1. **Snapshot** (`asda/snapshot.ts` + `asda/search.ts`). Pull the in-stock food catalogue into
   SQLite, ~11 Algolia requests. Everything downstream reads this file, never the live
   API, so an upstream change degrades to stale prices rather than an outage. An FTS5
   index over product names powers resolution.

2. **Resolve** (`planning/ingredients.ts`). Turn a search term into the product to buy. This is
   the only fuzzy step, and where every resolution bug has lived. Candidates are
   clustered by ASDA's shelf taxonomy, and the shelf is scored by coverage then
   specificity, which separates `Onions & Leeks` from `Pickled Onions & Vegetables`.
   Genuinely ambiguous staples (`milk`, `butter`, `potatoes`) use a curated hint map;
   preferences (`planning/preferences.ts`) reject unwanted products here, not just in the prompt,
   because the model picks the term but the resolver picks the product.

3. **Cost** (`planning/costing.ts`). Aggregate demand across all recipes _before_ choosing packs, so
   ingredient sharing falls out for free and nothing is bought twice. Pick the pack that
   minimises cost for the quantity needed, not the best unit price (a 7.5kg potato sack
   wins on £/kg and loses on total). Reconcile recipe units against pack units, flagging
   what cannot be converted rather than guessing.

4. **Multibuy** (`planning/multibuy.ts`). Price promotions across the whole basket, since groups
   are mix-and-match. Optionally buy up to a threshold, guarded by whether the surplus is
   storable and the saving worth it. See `docs/api-notes.md` for how promotions are
   encoded.

5. **Plan loop** (`commands/plan.ts`). The one place model and code interleave. Generate
   recipes, cost them, and if the meals come in over the cap, hand the model the itemised
   overspend and ask for a revision. Up to three attempts; the cheapest is kept. Surplus
   is not scored as waste: this household eats it rather than binning it.

6. **Artifact** (`planning/report.ts`). Write `data/plan.md` (to cook and shop from) and
   `data/plan.json` (structured, re-costable). The model's raw output alone is not a
   plan; the resolved products, prices and methods are.

7. **Cart** (`commands/cart.ts`). The only write path. Push the shopping list to a basket via a
   pasted account token, and stop before checkout.

## Layout

`src/` is grouped by role, so the four things you run are separate from the modules they
orchestrate:

- **`asda/`** reaches or models ASDA's data: `search` (Algolia), `snapshot` (ingest to
  SQLite), `packsize` (parse pack strings), `commerce` (Commerce Cloud constants).
- **`planning/`** is the meal-planning brain, all pure-ish logic: `ingredients`, `costing`,
  `multibuy`, `leftovers`, `grazeable`, `preferences`, `history`, `report`, `validate`.
- **`snacks/`** is the snack feature: `select` (weighted-random pick) and `blocklist`.
- **`commands/`** holds the entrypoints `bun run` targets: `plan`, `snacks`, `cart`, `rate`,
  `dislike`. Plan and snacks are independent; `cart` is the only one that combines them.
- **`config.ts`** sits at the root; every group reads it and it imports nothing.

Dependencies flow one way, up toward `commands/`, with no cycles.

## State

All of `data/` is gitignored. Most of it is regenerable; two files are real state that
is not, so losing them costs something even though nothing tracks them:

- **`history.json`**. Past recipes, repeat counts and your verdicts. Drives variety and
  favourites. The snapshot rebuilds in seconds; a year of "the children actually ate
  this" does not. Kept local rather than tracked: it is personal usage data on a
  single-machine tool, and git would only leak eating habits to a public repo.
- **`carryover.json`**. Leftovers from the last plan, offered to the next run as free
  stock with a per-department shelf life. This is what makes buying a whole pack to use
  half of it not a waste.

## Cross-cutting decisions

- **Snapshot, don't stream.** Plan against a local copy. Robust to upstream change, free
  to query, and ~11 requests/day is indistinguishable from browsing.
- **Reject rather than guess.** An unparseable pack size, an unconvertible unit, an
  ingredient that matches nothing: all surface as flags or warnings, never a silently
  invented number that corrupts a total.
- **No stored credentials.** Guest tokens are self-minted per run; the account token for
  baskets is pasted, used, and never written to disk.
- **Determinism where it counts.** The resolver's SQL is invariant across option
  combinations, and pricing is exact integer-penny arithmetic. The fuzzy surface is
  deliberately confined to step 2 and the model calls.

## Known limitations

Current as of the last commit; kept in sync in the README's "Known limitations" section.

- Nothing steers the plan _toward_ multibuy groups, so promo savings are opportunistic
  rather than sought.
- Meal-deal promotions ("Bistro Dine In £12") are not priced; their structure is not in
  the data.
- Some unit mismatches ("2 onions" against a 1kg bag) are flagged, not resolved, for
  want of per-item weights.
- Shelf-life is a department-level guess and does not track whether a pack was opened.
