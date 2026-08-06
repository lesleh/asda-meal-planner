/**
 * Snapshot job: pull the whole in-stock food catalogue into SQLite.
 *
 * Offers alone can't fill a meal plan — a recipe wanting onions needs the
 * cheapest onions whether or not they're promoted — so this stores every food
 * product and flags which are on offer.
 *
 * The planner queries this, never the live API, so a change upstream degrades
 * to stale prices rather than an outage. Each run is retained so promos
 * appearing and expiring can be diffed run over run.
 *
 *   bun run snapshot.ts              take a snapshot and diff against the last
 *   bun run snapshot.ts --diff       diff the two most recent runs only
 *   bun run snapshot.ts --export     write planner-ready JSON to stdout
 */

import { Database } from "bun:sqlite";
import { AsdaClient, FOOD_CATEGORIES, type AsdaProduct } from "./search";
import { formatPackSize, parsePackSize } from "./packsize";
import { DB_PATH, ensureDataDir } from "./config";

const PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function migrate(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT    NOT NULL,
      store_id    TEXT    NOT NULL,
      product_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      cin           TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      brand         TEXT,
      category      TEXT,
      department    TEXT,
      aisle         TEXT,
      shelf         TEXT,
      price         REAL    NOT NULL,
      was_price     REAL,
      discount_pct  REAL,
      offer_label   TEXT,
      price_per_uom REAL,
      uom           TEXT,
      pack_raw      TEXT,
      pack_quantity REAL,
      pack_unit     TEXT,
      pack_multiplier INTEGER,
      stock         INTEGER,
      on_offer      INTEGER NOT NULL DEFAULT 0,
      vegan         INTEGER,
      vegetarian    INTEGER,
      no_gluten     INTEGER,
      no_milk       INTEGER,
      no_nuts       INTEGER,
      PRIMARY KEY (run_id, cin)
    );

    -- Name search for ingredient resolution. Contentless-delete is not used
    -- because runs are retained, so each run's rows coexist here.
    CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
      cin UNINDEXED, run_id UNINDEXED, name, shelf, tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS promos (
      run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      cin        TEXT    NOT NULL,
      promo_id   TEXT    NOT NULL,
      promo_name TEXT    NOT NULL,
      start_date INTEGER,
      end_date   INTEGER,
      PRIMARY KEY (run_id, cin, promo_id)
    );

    CREATE INDEX IF NOT EXISTS products_run_dept  ON products(run_id, department);
    CREATE INDEX IF NOT EXISTS products_run_shelf ON products(run_id, shelf);
    CREATE INDEX IF NOT EXISTS products_run_ppu   ON products(run_id, price_per_uom);
    CREATE INDEX IF NOT EXISTS products_run_offer ON products(run_id, on_offer);
    CREATE INDEX IF NOT EXISTS promos_run_promo   ON promos(run_id, promo_id);
  `);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * A product is on offer if it carries a multibuy or its was-price beats its
 * price. Deriving it here rather than issuing a second `AllOffers_EN` query
 * saves 4 requests and doubles as a check on ASDA's own rule: if these two
 * counts drift apart, their merchandising config has changed under us.
 */
function isOnOffer(hit: AsdaProduct): boolean {
  if (hit.PROMOS?.EN?.length) return true;
  const price = hit.PRICES?.EN;
  return price?.WASPRICE != null && price.PRICE != null && price.WASPRICE > price.PRICE;
}

async function fetchFoodCatalogue(client: AsdaClient): Promise<AsdaProduct[]> {
  const hits: AsdaProduct[] = [];

  for (let page = 0; ; page++) {
    const result = await client.search({
      categories: FOOD_CATEGORIES,
      hitsPerPage: PAGE_SIZE,
      page,
    });
    hits.push(...result.hits);
    console.error(
      `  page ${page + 1}/${result.nbPages} — ${hits.length}/${result.nbHits}`,
    );
    if (page + 1 >= result.nbPages) break;
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function insertRun(db: Database, client: AsdaClient, hits: AsdaProduct[]): number {
  const run = db
    .query<{ id: number }, [string, string, number]>(
      `INSERT INTO runs (started_at, store_id, product_count)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(new Date().toISOString(), client.storeId, hits.length);
  if (!run) throw new Error("failed to create run row");

  const insertProduct = db.query(`
    INSERT OR REPLACE INTO products VALUES (
      $run_id, $cin, $name, $brand, $category, $department, $aisle, $shelf,
      $price, $was_price, $discount_pct, $offer_label, $price_per_uom, $uom,
      $pack_raw, $pack_quantity, $pack_unit, $pack_multiplier, $stock, $on_offer,
      $vegan, $vegetarian, $no_gluten, $no_milk, $no_nuts
    )`);
  const insertPromo = db.query(`
    INSERT OR REPLACE INTO promos VALUES ($run_id, $cin, $promo_id, $promo_name, $start_date, $end_date)`);
  const insertSearch = db.query(`
    INSERT INTO product_search (cin, run_id, name, shelf) VALUES ($cin, $run_id, $name, $shelf)`);

  const write = db.transaction((products: AsdaProduct[]) => {
    for (const hit of products) {
      const price = hit.PRICES?.EN;
      if (!price || price.PRICE == null) continue;

      const uom = price.PRICEPERUOMFORMATTED?.split("/")[1];
      const pack = parsePackSize(hit.PACK_SIZE, uom);
      const wasPrice = price.WASPRICE ?? null;
      const flags = hit.NUTRITIONAL_INFO ?? {};

      insertProduct.run({
        $run_id: run.id,
        $cin: hit.CIN,
        $name: hit.NAME ?? "",
        $brand: hit.BRAND ?? null,
        $category: hit.PRIMARY_TAXONOMY?.CAT_NAME ?? null,
        $department: hit.PRIMARY_TAXONOMY?.DEPT_NAME ?? null,
        $aisle: hit.PRIMARY_TAXONOMY?.AISLE_NAME ?? null,
        $shelf: hit.PRIMARY_TAXONOMY?.SHELF_NAME ?? null,
        $price: price.PRICE,
        $was_price: wasPrice,
        $discount_pct:
          wasPrice && wasPrice > price.PRICE
            ? Math.round((1 - price.PRICE / wasPrice) * 1000) / 10
            : null,
        $offer_label: price.OFFER ?? null,
        $price_per_uom: price.PRICEPERUOM ?? null,
        $uom: uom ?? null,
        $pack_raw: hit.PACK_SIZE ?? null,
        $pack_quantity: pack?.quantity ?? null,
        $pack_unit: pack?.unit ?? null,
        $pack_multiplier: pack?.multiplier ?? null,
        $stock: hit.STOCK?.[client.storeId] ?? null,
        $on_offer: isOnOffer(hit) ? 1 : 0,
        $vegan: flags.Vegan ?? null,
        $vegetarian: flags.Vegetarian ?? null,
        $no_gluten: flags.NoGluten ?? null,
        $no_milk: flags.NoMilk ?? null,
        $no_nuts: flags.NoNuts ?? null,
      });

      insertSearch.run({
        $cin: hit.CIN,
        $run_id: run.id,
        $name: hit.NAME ?? "",
        $shelf: hit.PRIMARY_TAXONOMY?.SHELF_NAME ?? "",
      });

      for (const promo of hit.PROMOS?.EN ?? []) {
        insertPromo.run({
          $run_id: run.id,
          $cin: hit.CIN,
          $promo_id: promo.ID,
          $promo_name: promo.NAME,
          $start_date: promo.START_DATE ?? null,
          $end_date: promo.END_DATE ?? null,
        });
      }
    }
  });

  write(hits);
  return run.id;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

interface DiffRow {
  cin: string;
  name: string;
  price: number;
  previous_price: number | null;
}

function reportDiff(db: Database, runId: number): void {
  const previous = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM runs WHERE id < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId);

  if (!previous) {
    console.log("\nno previous run to diff against");
    return;
  }

  const added = db
    .query<DiffRow, [number, number]>(`
      SELECT cin, name, price, NULL AS previous_price FROM products
      WHERE run_id = ?1 AND cin NOT IN (SELECT cin FROM products WHERE run_id = ?2)
      ORDER BY price`)
    .all(runId, previous.id);

  const removed = db
    .query<DiffRow, [number, number]>(`
      SELECT cin, name, price, NULL AS previous_price FROM products
      WHERE run_id = ?2 AND cin NOT IN (SELECT cin FROM products WHERE run_id = ?1)`)
    .all(runId, previous.id);

  const repriced = db
    .query<DiffRow, [number, number]>(`
      SELECT n.cin, n.name, n.price, o.price AS previous_price
      FROM products n JOIN products o ON o.cin = n.cin AND o.run_id = ?2
      WHERE n.run_id = ?1 AND n.price != o.price
      ORDER BY (n.price - o.price)`)
    .all(runId, previous.id);

  console.log(`\ndiff vs run ${previous.id}:`);
  console.log(`  entered offers: ${added.length}`);
  console.log(`  left offers:    ${removed.length}`);
  console.log(`  repriced:       ${repriced.length}`);

  for (const row of repriced.slice(0, 5)) {
    const direction = row.price < (row.previous_price ?? 0) ? "down" : "up";
    console.log(`    ${direction.padEnd(4)} £${row.previous_price} -> £${row.price}  ${row.name}`);
  }
}

// ---------------------------------------------------------------------------
// Planner export
// ---------------------------------------------------------------------------

interface PlannerItem {
  cin: string;
  name: string;
  price: number;
  wasPrice: number | null;
  discountPct: number | null;
  pack: string | null;
  unitPrice: string | null;
  department: string | null;
  diet: string[];
}

/**
 * A compact view for a planning agent.
 *
 * Multibuy groups are emitted as groups rather than loose rows, because the
 * effective unit price of "Any 3 for £5" only exists relative to the other
 * members. Flattening them loses the only thing that makes them worth having.
 */
function exportForPlanner(db: Database, runId: number): unknown {
  const items = db
    .query<
      PlannerItem & { price_per_uom: number | null; uom: string | null;
        pack_quantity: number | null; pack_unit: string | null;
        vegan: number | null; vegetarian: number | null;
        no_gluten: number | null; no_milk: number | null; no_nuts: number | null },
      [number]
    >(`SELECT cin, name, price, was_price AS wasPrice, discount_pct AS discountPct,
              pack_quantity, pack_unit, price_per_uom, uom, department,
              vegan, vegetarian, no_gluten, no_milk, no_nuts
       FROM products WHERE run_id = ? ORDER BY department, price_per_uom`)
    .all(runId);

  const toItem = (row: (typeof items)[number]): PlannerItem => ({
    cin: row.cin,
    name: row.name,
    price: row.price,
    wasPrice: row.wasPrice,
    discountPct: row.discountPct,
    pack: row.pack_quantity != null ? `${row.pack_quantity}${row.pack_unit}` : null,
    unitPrice: row.price_per_uom != null ? `£${row.price_per_uom}/${row.uom}` : null,
    department: row.department,
    diet: [
      row.vegan === 1 && "vegan",
      row.vegetarian === 1 && "vegetarian",
      row.no_gluten === 1 && "gluten-free",
      row.no_milk === 1 && "dairy-free",
      row.no_nuts === 1 && "nut-free",
    ].filter(Boolean) as string[],
  });

  const byCin = new Map(items.map((row) => [row.cin, toItem(row)]));

  const groups = db
    .query<{ promo_id: string; promo_name: string; cins: string }, [number]>(`
      SELECT promo_id, promo_name, group_concat(cin) AS cins
      FROM promos WHERE run_id = ? GROUP BY promo_id, promo_name
      ORDER BY count(*) DESC`)
    .all(runId);

  const grouped = groups.map((group) => ({
    promoId: group.promo_id,
    offer: group.promo_name,
    members: group.cins.split(",").map((cin) => byCin.get(cin)).filter(Boolean),
  }));

  const inGroup = new Set(groups.flatMap((g) => g.cins.split(",")));

  return {
    runId,
    multibuyGroups: grouped,
    priceCuts: items
      .filter((row) => !inGroup.has(row.cin) && row.discountPct != null)
      .map(toItem),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

ensureDataDir();
const db = new Database(DB_PATH, { create: true });
migrate(db);

const mode = process.argv[2];
const latest = () =>
  db.query<{ id: number }, []>(`SELECT id FROM runs ORDER BY id DESC LIMIT 1`).get();

if (mode === "--export") {
  const run = latest();
  if (!run) throw new Error("no runs yet — take a snapshot first");
  console.log(JSON.stringify(exportForPlanner(db, run.id), null, 2));
} else if (mode === "--diff") {
  const run = latest();
  if (!run) throw new Error("no runs yet");
  reportDiff(db, run.id);
} else {
  const client = new AsdaClient();
  console.error(`snapshotting food catalogue for store ${client.storeId}...`);
  const started = Date.now();
  const hits = await fetchFoodCatalogue(client);
  const runId = insertRun(db, client, hits);
  console.log(
    `\nrun ${runId}: ${hits.length} products in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  const stats = db
    .query<
      { parsed: number; total: number; promos: number; offers: number },
      [number]
    >(`
      SELECT
        (SELECT count(*) FROM products WHERE run_id = ?1 AND pack_quantity IS NOT NULL) AS parsed,
        (SELECT count(*) FROM products WHERE run_id = ?1) AS total,
        (SELECT count(DISTINCT promo_id) FROM promos WHERE run_id = ?1) AS promos,
        (SELECT count(*) FROM products WHERE run_id = ?1 AND on_offer = 1) AS offers`)
    .get(runId);
  console.log(
    `pack sizes parsed: ${stats?.parsed}/${stats?.total}  on offer: ${stats?.offers}  distinct multibuys: ${stats?.promos}`,
  );

  reportDiff(db, runId);
}

db.close();

export { exportForPlanner, formatPackSize };
