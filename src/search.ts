/**
 * Typed client for ASDA's public Algolia product index.
 *
 * Wraps the standard Algolia search endpoint (POST /1/indexes/{index}/query)
 * and layers ASDA's index schema and filter conventions on top.
 */

import { STORE_ID } from "./config";

const DEFAULTS = {
  appId: "8I6WSKCCNV",
  /** Public search-only key, as shipped in asda.com's browser bundle. */
  apiKey: "03e4272048dd17f771da37b57ff8a75e",
  indexName: "ASDA_PRODUCTS",
  /** Store the prices and stock levels are scoped to. */
  storeId: STORE_ID,
} as const;

/** Sent as a query param; Algolia uses it for usage analytics only. */
const USER_AGENT = "Algolia for JavaScript (4.26.0); Browser";

/** Attributes asda.com requests. Nested paths (`PRICES.EN`) are Algolia syntax. */
const DEFAULT_ATTRIBUTES = [
  "STATUS", "BRAND", "CIN", "NAME", "AVG_RATING", "RATING_COUNT", "ICONS",
  "PRICES.EN", "SALES_TYPE", "MAX_QTY", "IS_FROZEN", "IS_BWS", "PROMOS.EN",
  "LABEL", "LABEL_START_DATE", "LABEL_END_DATE", "IS_SPONSORED", "PRODUCT_TYPE",
  "CIN_ID", "PRIMARY_TAXONOMY", "IMAGE_ID", "PACK_SIZE", "PHARMACY_RESTRICTED",
  "CS_YES", "CS_TEXT", "IS_FTO", "PURCHASE_START_DATE_FTO",
  "PURCHASE_END_DATE_FTO", "DELIVERY_SLOT_START_DATE_FTO", "END_DATE",
  "START_DATE", "SIZE_DESC", "REWARDS", "SHOW_PRICE_CS",
  // Not requested by asda.com's PDP, but present and useful for diet filtering.
  "NUTRITIONAL_INFO", "ID",
] as const;

/**
 * Algolia Rule contexts. These trigger server-side rules that rewrite the
 * query, so `allOffers` is a filter ASDA controls, not one we construct.
 */
export const RULE_CONTEXTS = {
  /** Restricts to promotional lines: multibuys and price cuts. */
  allOffers: "AllOffers_EN",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsdaPrice {
  /** Promotional label, e.g. `"Dropped"`. */
  OFFER?: string | null;
  PRICE: number;
  WASPRICE?: number | null;
  /** Unit price, e.g. per kg. */
  PRICEPERUOM?: number | null;
  /** Pre-formatted unit price, e.g. `"£2.88/KG"`. */
  PRICEPERUOMFORMATTED?: string | null;
}

export interface AsdaPromo {
  ID: string;
  /** Display text, e.g. `"Any 2 for £3"`. */
  NAME: string;
  /** Unix seconds. */
  START_DATE: number;
  END_DATE: number;
  TYPE: number;
}

export interface AsdaIcon {
  ID: string;
  ICON_NAME: string;
  CLICKABLE: boolean;
  IMAGE_URL: string;
  /** Unix seconds. Absent on some icons. */
  START_DATE?: number;
  END_DATE?: number;
  /** Sort weight; higher wins. */
  PRIORITY?: number;
}

/** Four-level category tree. All IDs are numeric strings. */
export interface AsdaTaxonomy {
  CAT_ID?: string;
  CAT_NAME?: string;
  DEPT_ID?: string;
  DEPT_NAME?: string;
  AISLE_ID?: string;
  AISLE_NAME?: string;
  SHELF_ID?: string;
  SHELF_NAME?: string;
}

/**
 * A product hit, typed against live responses from the index.
 *
 * Fields marked `unknown` were absent or null across every sampled hit, so
 * their type is genuinely unestablished; narrow at the call site rather than
 * trusting a guess. Everything else is observed.
 */
export interface AsdaProduct {
  /** Algolia's object key. Matches CIN on every hit sampled. */
  objectID: string;
  /** Catalogue Item Number, ASDA's product ID. Numeric, carried as a string. */
  CIN: string;
  NAME?: string;
  BRAND?: string;
  /** `A` = active, `I` = inactive; asda.com treats both as sellable. */
  STATUS?: string;
  PACK_SIZE?: string;
  IMAGE_ID?: string;
  PRODUCT_TYPE?: string;
  /** Unit of sale, e.g. `"Each"`. */
  SALES_TYPE?: string;
  AVG_RATING?: number;
  RATING_COUNT?: number;
  MAX_QTY?: number;
  /** Badge text, e.g. `"New"`. */
  LABEL?: string | null;
  /**
   * Genuine booleans, despite the filter DSL comparing them numerically
   * (`IS_FTO=0`) — Algolia coerces booleans in numeric expressions.
   */
  IS_FROZEN?: boolean;
  IS_FTO?: boolean;
  /** Locale-keyed. Only `EN` is populated. */
  PRICES?: Record<string, AsdaPrice> | null;
  PROMOS?: Record<string, AsdaPromo[]> | null;
  ICONS?: AsdaIcon[] | null;
  /** Store-ID-keyed stock levels. */
  STOCK?: Record<string, number>;
  PRIMARY_TAXONOMY?: AsdaTaxonomy | null;
  SECONDARY_TAXONOMY?: AsdaTaxonomy | null;
  /** Unix seconds. */
  START_DATE?: number;
  END_DATE?: number;
  LABEL_START_DATE?: number | null;
  LABEL_END_DATE?: number | null;
  PURCHASE_START_DATE_FTO?: number | null;
  PURCHASE_END_DATE_FTO?: number | null;
  DELIVERY_SLOT_START_DATE_FTO?: number | null;
  /** SKU identifier, distinct from CIN, e.g. `"SKU100565032"`. */
  ID?: string;
  /**
   * Dietary and allergen flags as 0/1 rather than booleans. `No*` keys mean
   * "free from". Mirrors the Brandbank data but needs no authentication.
   */
  NUTRITIONAL_INFO?: Record<string, 0 | 1>;
  /** Present unless `attributesToHighlight` is disabled. */
  _highlightResult?: Record<string, unknown>;

  // Requested by asda.com but null or absent across every sampled hit.
  CIN_ID?: unknown;
  REWARDS?: unknown;
  IS_BWS?: unknown;
  IS_SPONSORED?: unknown;
  SIZE_DESC?: unknown;
  PHARMACY_RESTRICTED?: unknown;
  /** Christmas/seasonal pre-order flags, judging by their use in filters. */
  CS_YES?: unknown;
  CS_TEXT?: unknown;
  SHOW_PRICE_CS?: unknown;
}

/** Algolia's standard search envelope. */
export interface SearchResponse<Hit> {
  hits: Hit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  query: string;
  /** The request, URL-encoded, as Algolia parsed it. Useful for debugging. */
  params: string;
  processingTimeMS: number;
  serverTimeMS?: number;
  exhaustive?: Record<string, boolean>;
  exhaustiveNbHits?: boolean;
  exhaustiveTypo?: boolean;
  renderingContent?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  processingTimingsMS?: Record<string, unknown>;
}

export interface ClientOptions {
  appId?: string;
  apiKey?: string;
  indexName?: string;
  /** Store to scope stock and pricing to. */
  storeId?: string;
  /** Injectable for tests and non-browser runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface SearchOptions {
  /** Free-text query. Omit for a pure filter lookup. */
  query?: string;
  hitsPerPage?: number;
  page?: number;
  attributesToRetrieve?: readonly string[];
  /**
   * Restrict to these top-level categories. Pass `FOOD_CATEGORIES` to drop
   * the ~75% of the catalogue that is homeware, clothing and toiletries.
   */
  categories?: readonly string[];
  /** Extra filter clauses ANDed onto the availability filter. */
  extraFilters?: string;
  /** Skip the availability filter entirely and supply the whole thing. */
  rawFilters?: string;
  analytics?: boolean;
  ruleContexts?: string[];
  signal?: AbortSignal;
}

export class AlgoliaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "AlgoliaError";
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** CINs are interpolated into a quoted filter string, so reject anything else. */
function assertCin(cin: string): string {
  if (!/^\d+$/.test(cin)) {
    throw new TypeError(`Invalid CIN ${JSON.stringify(cin)}: expected digits`);
  }
  return cin;
}

/**
 * The availability filter asda.com applies to every query: in-stock at this
 * store, currently on sale, not a future-trading-only line, not a hidden shelf.
 */
export function buildAvailabilityFilter(
  storeId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return [
    "(STATUS:A OR STATUS:I)",
    "NOT DISPLAY_ONLINE:false",
    `NOT UNTRAITED_STORES:${storeId}`,
    `STOCK.${storeId} > 0`,
    `(IS_FTO=0 OR PURCHASE_END_DATE_FTO > ${nowSeconds})`,
    "(NOT PRIMARY_TAXONOMY.SHELF_ID:1215685231732 AND NOT SECONDARY_TAXONOMY.SHELF_ID:1215685231732)",
    `(START_DATE<${nowSeconds} OR CS_YES=1)`,
    `END_DATE>${nowSeconds}`,
  ].join(" AND ");
}

/** ORed CIN equality clauses, e.g. `(CIN:'123' OR CIN:'456')`. */
export function buildCinFilter(cins: readonly string[]): string {
  return `(${cins.map((cin) => `CIN:'${assertCin(cin)}'`).join(" OR ")})`;
}

/**
 * Top-level categories holding edible goods.
 *
 * Filtering here rather than at department level keeps the list short: the
 * catalogue is 121k products but 52k of that is `Home & Entertainment`, and
 * the whole food estate sits under ten category names.
 *
 * Deliberately excluded: `Beer, Wine & Spirits` (not meal ingredients),
 * `Pet Food & Accessories`, `Baby, Toddler & Kids`, and the seasonal
 * categories, which duplicate products already classified under a food one.
 */
export const FOOD_CATEGORIES = [
  "Food Cupboard",
  "Chilled Food",
  "Meat, Poultry & Fish",
  "Frozen Food",
  "Bakery",
  "World Food",
  "Fresh Fruit, Vegetables & Flowers",
  "Drinks",
  "Dietary & Lifestyle",
  "Sweets, Treats & Snacks",
] as const;

/**
 * Quote a value for the filter DSL. Several category names contain
 * apostrophes (`Mother's Day`), which would terminate a single-quoted string
 * early, so double quotes are used and escaped.
 */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** ORed category clauses over `PRIMARY_TAXONOMY.CAT_NAME`. */
export function buildCategoryFilter(categories: readonly string[]): string {
  return `(${categories
    .map((name) => `PRIMARY_TAXONOMY.CAT_NAME:${quoteFilterValue(name)}`)
    .join(" OR ")})`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AsdaClient {
  private readonly appId: string;
  private readonly apiKey: string;
  private readonly indexName: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  readonly storeId: string;

  constructor(options: ClientOptions = {}) {
    this.appId = options.appId ?? DEFAULTS.appId;
    this.apiKey = options.apiKey ?? DEFAULTS.apiKey;
    this.indexName = options.indexName ?? DEFAULTS.indexName;
    this.storeId = options.storeId ?? DEFAULTS.storeId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Read hosts in Algolia's documented priority order: the DSN replica first,
   * then the three fallbacks, which are separately hosted for failover.
   */
  private get hosts(): string[] {
    const id = this.appId.toLowerCase();
    return [
      `${id}-dsn.algolia.net`,
      `${id}-1.algolianet.com`,
      `${id}-2.algolianet.com`,
      `${id}-3.algolianet.com`,
    ];
  }

  async search(
    options: SearchOptions = {},
  ): Promise<SearchResponse<AsdaProduct>> {
    const {
      query = "",
      hitsPerPage = 14,
      page,
      attributesToRetrieve = DEFAULT_ATTRIBUTES,
      categories,
      extraFilters,
      rawFilters,
      analytics = false,
      ruleContexts = [],
      signal,
    } = options;

    const filters =
      rawFilters ??
      [
        categories?.length ? buildCategoryFilter(categories) : undefined,
        extraFilters,
        buildAvailabilityFilter(this.storeId),
      ]
        .filter(Boolean)
        .join(" AND ");

    const body = {
      query,
      hitsPerPage,
      ...(page === undefined ? {} : { page }),
      // STOCK is store-scoped, so the retrieve list is too.
      attributesToRetrieve: [
        ...attributesToRetrieve,
        `STOCK.${this.storeId}`,
      ],
      filters,
      analytics,
      ruleContexts,
    };

    return this.request(body, signal);
  }

  /**
   * Products on promotion, the same set the /special-offers page shows.
   * Composes with `categories`, so food-only offers are one call.
   */
  async searchOffers(
    options: Omit<SearchOptions, "ruleContexts"> = {},
  ): Promise<SearchResponse<AsdaProduct>> {
    return this.search({ ...options, ruleContexts: [RULE_CONTEXTS.allOffers] });
  }

  /** Fetch specific products by CIN, the shape asda.com's autocomplete uses. */
  async getByCins(
    cins: readonly string[],
    options: Omit<SearchOptions, "extraFilters" | "rawFilters"> = {},
  ): Promise<SearchResponse<AsdaProduct>> {
    if (cins.length === 0) {
      throw new TypeError("getByCins requires at least one CIN");
    }
    return this.search({
      ...options,
      hitsPerPage: options.hitsPerPage ?? cins.length,
      extraFilters: buildCinFilter(cins),
    });
  }

  private async request(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<SearchResponse<AsdaProduct>> {
    const path =
      `/1/indexes/${encodeURIComponent(this.indexName)}/query` +
      `?x-algolia-agent=${encodeURIComponent(USER_AGENT)}`;

    let lastError: unknown;

    for (const host of this.hosts) {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://${host}${path}`, {
          method: "POST",
          headers: {
            "x-algolia-api-key": this.apiKey,
            "x-algolia-application-id": this.appId,
            // Not a typo: keeps the POST a CORS "simple request" and so
            // skips the preflight. The body is still JSON.
            "content-type": "application/x-www-form-urlencoded",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        continue;
      }

      // 4xx is our fault and will fail identically on every host.
      if (!response.ok && response.status < 500) {
        throw new AlgoliaError(
          `Algolia returned ${response.status}`,
          response.status,
          await response.text(),
        );
      }

      if (response.ok) {
        return (await response.json()) as SearchResponse<AsdaProduct>;
      }

      lastError = new AlgoliaError(
        `Algolia returned ${response.status}`,
        response.status,
        await response.text(),
      );
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`All Algolia hosts failed: ${String(lastError)}`);
  }
}
