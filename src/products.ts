/**
 * Salesforce Commerce (SCAPI) Shopper Products client for ASDA.
 *
 * Talks to the SCAPI host directly rather than through www.asda.com's
 * /mobify/proxy path, which sits behind Cloudflare bot protection.
 */

import { ASDA_COMMERCE, SlasClient, type SlasClientOptions } from "./slas";

/** SCAPI caps a multi-product request at 24 IDs. */
const MAX_IDS_PER_REQUEST = 24;

// ---------------------------------------------------------------------------
// Brandbank (packaging data)
// ---------------------------------------------------------------------------

export interface BrandbankNutrient {
  nameId: string;
  /** e.g. `"Energy (kcal)"`. */
  nameValue: string;
  /** Decimal string, e.g. `"203.00000"`. */
  per100Used?: string;
}

export interface BrandbankLookup {
  lookupId?: string;
  lookupValue?: string;
  nameId?: string;
  nameValue?: string;
  [key: string]: unknown;
}

/**
 * Packaging data from Brandbank (nutrition, allergens, cooking, storage).
 *
 * Nearly every field is an array even when it holds one value, and the
 * `no*` allergen flags are booleans meaning "free from".
 */
export interface BrandbankData {
  brand?: string[];
  companyName?: string[];
  companyAddress?: string[];
  packSize?: string[];
  packType?: string[];
  country?: string[];
  furtherDescription?: string;
  descriptionBreakdown?: unknown[];
  features?: unknown[];
  nutrition?: unknown[];
  calculatedNutrition?: BrandbankNutrient[];
  /** e.g. `"per 100g"`. */
  calculatedNutritionPer100?: string;
  calculatedNutritionPer100Used?: string;
  structuredNutritionEU?: unknown[];
  nutritionalClaims?: unknown[];
  cookingGuidelines?: BrandbankLookup[];
  storage?: unknown[];
  storageConditions?: unknown[];
  storageType?: unknown[];
  storageandUsageStatements?: unknown[];
  safetyWarning?: unknown[];
  recyclingInfo?: unknown[];
  otherInformation?: unknown[];
  // "Free from" flags.
  noGluten?: boolean;
  noMilk?: boolean;
  noNuts?: boolean;
  noPeanuts?: boolean;
  noEgg?: boolean;
  noFish?: boolean;
  noShellfish?: boolean;
  noSoya?: boolean;
  noSesame?: boolean;
  noCeleryincludingceleriac?: boolean;
  noMustard?: boolean;
  noLupin?: boolean;
  noLactose?: boolean;
  // Dietary flags.
  vegan?: boolean;
  vegetarian?: boolean;
  halal?: boolean;
  kosher?: boolean;
  lowFat?: boolean;
  lowSalt?: boolean;
  lowSugar?: boolean;
  lowSaturatedFat?: boolean;
  highFibre?: boolean;
  sourceofFibre?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface ProductInventory {
  id: string;
  ats: number;
  stockLevel: number;
  orderable: boolean;
  backorderable: boolean;
  preorderable: boolean;
}

/** Per-store availability across the delivery window. */
export interface StoreInventory {
  /** Store ID. */
  id: string;
  todayATP: boolean;
  dayPlusOneATP: boolean;
  dayPlusTwoATP: boolean;
  dayPlusThreeATP: boolean;
  dayPlusFourATP: boolean;
  postFourDaysATP: boolean;
  incomingATPDate?: string | null;
  preorderable: boolean;
  preOrderInStockDate?: string | null;
  availableForSelectedDelivery: boolean;
  online: boolean;
}

/**
 * A product. SCAPI namespaces every merchant-defined attribute with `c_`;
 * the un-prefixed fields are Salesforce's own standard schema.
 */
export interface Product {
  id: string;
  name: string;
  brand?: string;
  currency?: string;
  price?: number;
  pricePerUnit?: number;
  minOrderQuantity?: number;
  stepQuantity?: number;
  upc?: string;
  primaryCategoryId?: string;
  slugUrl?: string;
  type?: { item?: boolean; [key: string]: unknown };
  inventory?: ProductInventory;

  /** Brandbank packaging data, double-encoded as a JSON string. */
  c_BRANDBANK_JSON?: string;
  c_storeInventory?: StoreInventory;
  c_categoryTree?: Record<string, unknown>;
  c_iconDetailsCustom?: unknown[];
  c_icon_ID?: string[];
  c_SCENE7_IMAGE_ID?: string;
  c_AVG_RATING?: number;
  c_RATING_COUNT?: number;
  c_MAX_QTY?: number;
  c_SALES_TYPE?: string;
  c_SIZE?: string;
  c_EAN_GTIN?: string;
  c_pricePerUOM?: string;
  c_price_type?: string;
  c_strikethrough_price?: string;
  c_primary_shelf_name?: string;
  c_PRIMARY_SHELF?: string;
  c_SECONDARY_SHELVES?: string;
  c_SEARCH_KEYWORDS?: string;
  c_Is_Fresh?: boolean;
  c_is_bws?: boolean;
  c_DO_NOT_SUB?: boolean;
  c_PHARMACY_RESTRICTED?: boolean;
  c_HFSS_STATUS?: boolean;
  c_sku_status?: boolean;
  c_SKU_START_DATE?: string;
  c_SKU_END_DATE?: string;
  c_rewards_value?: number;

  [key: string]: unknown;
}

export interface ProductResult {
  limit: number;
  data: Product[];
  total: number;
}

export class ScapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ScapiError";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface ProductsClientOptions extends SlasClientOptions {
  siteId?: string;
  /** Reuse an existing auth client rather than creating one. */
  auth?: SlasClient;
}

export interface GetProductOptions {
  allImages?: boolean;
  /** SCAPI expansions, e.g. `["availability", "prices"]`. */
  expand?: string[];
  signal?: AbortSignal;
}

/** Parse the double-encoded Brandbank blob. Returns undefined if absent. */
export function parseBrandbank(product: Product): BrandbankData | undefined {
  if (!product.c_BRANDBANK_JSON) return undefined;
  try {
    return JSON.parse(product.c_BRANDBANK_JSON) as BrandbankData;
  } catch {
    return undefined;
  }
}

/** Nutrition as a plain name to value map, e.g. `{"Energy (kcal)": 203}`. */
export function nutritionPer100(product: Product): Record<string, number> {
  const entries = parseBrandbank(product)?.calculatedNutrition ?? [];
  return Object.fromEntries(
    entries
      .filter((nutrient) => nutrient.per100Used !== undefined)
      .map((nutrient) => [nutrient.nameValue, Number(nutrient.per100Used)]),
  );
}

/** Allergens the product is declared free from, e.g. `["Gluten", "Nuts"]`. */
export function freeFrom(product: Product): string[] {
  const data = parseBrandbank(product);
  if (!data) return [];
  return Object.entries(data)
    .filter(([key, value]) => key.startsWith("no") && value === true)
    .map(([key]) => key.slice(2));
}

export class AsdaProductsClient {
  private readonly auth: SlasClient;
  private readonly shortCode: string;
  private readonly organizationId: string;
  private readonly siteId: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ProductsClientOptions = {}) {
    this.auth = options.auth ?? new SlasClient(options);
    this.shortCode = options.shortCode ?? ASDA_COMMERCE.shortCode;
    this.organizationId = options.organizationId ?? ASDA_COMMERCE.organizationId;
    this.siteId = options.siteId ?? ASDA_COMMERCE.channelId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private get baseUrl(): string {
    return `https://${this.shortCode}.api.commercecloud.salesforce.com/product/shopper-products/v1/organizations/${this.organizationId}`;
  }

  /** Fetch one product by CIN. */
  async getProduct(
    id: string,
    options: GetProductOptions = {},
  ): Promise<Product> {
    return this.request<Product>(`/products/${encodeURIComponent(id)}`, options);
  }

  /**
   * Fetch up to 24 products in one call. Beyond that SCAPI rejects the
   * request, so callers are chunked rather than silently truncated.
   */
  async getProducts(
    ids: readonly string[],
    options: GetProductOptions = {},
  ): Promise<Product[]> {
    if (ids.length === 0) return [];

    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += MAX_IDS_PER_REQUEST) {
      chunks.push(ids.slice(index, index + MAX_IDS_PER_REQUEST) as string[]);
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        this.request<ProductResult>("/products", options, { ids: chunk.join(",") }),
      ),
    );
    return results.flatMap((result) => result.data);
  }

  private async request<T>(
    path: string,
    options: GetProductOptions,
    extraParams: Record<string, string> = {},
  ): Promise<T> {
    const params = new URLSearchParams({ siteId: this.siteId, ...extraParams });
    if (options.allImages ?? true) params.set("allImages", "true");
    if (options.expand?.length) params.set("expand", options.expand.join(","));

    const token = await this.auth.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: options.signal,
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      throw new ScapiError(
        `SCAPI ${path} returned ${response.status}`,
        response.status,
        body,
      );
    }
    return (await response.json()) as T;
  }
}
