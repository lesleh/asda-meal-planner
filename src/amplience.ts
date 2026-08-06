/**
 * Client for ASDA's Amplience content CDN.
 *
 * Serves CMS page templates — labels, SEO metadata, ad config, component
 * layout — keyed by a fixed delivery key such as `v1/product`. It holds no
 * product data; the response is byte-identical for every product page.
 */

const DEFAULT_HUB = "asdaprod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Attached by Amplience to every content item, nested ones included. */
export interface AmplienceMeta {
  /** Schema URI, e.g. `https://asda.com/schemas/pages/v1/product`. */
  schema: string;
  name?: string;
  /** Only present on the top-level item addressed by key. */
  deliveryKey?: string;
  deliveryId?: string;
}

export interface AmplienceContent {
  _meta: AmplienceMeta;
  [key: string]: unknown;
}

/** A slot holding the components rendered into one region of a page. */
export interface AmplienceSlot extends AmplienceContent {
  componentList?: AmplienceContent[];
}

/** The `v1/product` document: the PDP template. */
export interface ProductPageContent extends AmplienceContent {
  pageTemplate?: {
    _meta: AmplienceMeta;
    pageConfig?: {
      isPageDeactivated?: boolean;
      /** Criteo retail-media tagging. */
      criteoConfig?: Record<string, unknown>;
      /** `description` contains a `{name}` placeholder for the product name. */
      seoConfig?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  mainSlot?: AmplienceSlot[];
}

export interface AmplienceErrorBody {
  error: {
    /** e.g. `CONTENT_NOT_FOUND`. */
    type: string;
    message: string;
    data?: Record<string, unknown>;
  };
}

export class AmplienceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Parsed error envelope, when the body was JSON. */
    readonly body?: AmplienceErrorBody,
  ) {
    super(message);
    this.name = "AmplienceError";
  }

  /** True when the delivery key does not exist. */
  get isNotFound(): boolean {
    return this.body?.error.type === "CONTENT_NOT_FOUND" || this.status === 404;
  }
}

export interface AmplienceClientOptions {
  /** Amplience hub name; the subdomain of the CDN host. */
  hub?: string;
  fetch?: typeof globalThis.fetch;
}

export interface GetByKeyOptions {
  /**
   * Resolve nested content references inline. Disabling means nested items
   * arrive as bare `{_meta, id}` pointers needing separate fetches.
   * @default true
   */
  inline?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Known delivery keys. Both verified live; `v1/search` and `v1/category` 404. */
export const DELIVERY_KEYS = {
  productPage: "v1/product",
  homePage: "v1/home",
} as const;

export class AmplienceClient {
  private readonly hub: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AmplienceClientOptions = {}) {
    this.hub = options.hub ?? DEFAULT_HUB;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Fetch a content item by delivery key. Keys contain slashes and are passed
   * through unencoded, since Amplience treats them as path segments.
   */
  async getByKey<T extends AmplienceContent = AmplienceContent>(
    key: string,
    options: GetByKeyOptions = {},
  ): Promise<T> {
    const { inline = true, signal } = options;

    const params = new URLSearchParams(
      inline ? { depth: "all", format: "inlined" } : { depth: "all" },
    );
    const url = `https://${this.hub}.cdn.content.amplience.net/content/key/${key}?${params}`;

    const response = await this.fetchImpl(url, { headers: { Accept: "*/*" }, signal });

    if (!response.ok) {
      const raw = await response.text();
      let parsed: AmplienceErrorBody | undefined;
      try {
        parsed = JSON.parse(raw) as AmplienceErrorBody;
      } catch {
        // Non-JSON body (CDN-level error page); status alone has to do.
      }
      throw new AmplienceError(
        parsed?.error.message ?? `Amplience returned ${response.status}`,
        response.status,
        parsed,
      );
    }

    // `format=inlined` wraps the item in a `content` envelope.
    const { content } = (await response.json()) as { content: T };
    return content;
  }

  /** The PDP template: labels, SEO config, and component layout. */
  async getProductPage(options?: GetByKeyOptions): Promise<ProductPageContent> {
    return this.getByKey<ProductPageContent>(DELIVERY_KEYS.productPage, options);
  }
}

/**
 * Flatten a page's slots into a single component list, which is usually what
 * callers want — the slot grouping is a CMS authoring concern, not a render one.
 */
export function flattenComponents(page: ProductPageContent): AmplienceContent[] {
  return (page.mainSlot ?? []).flatMap((slot) => slot.componentList ?? []);
}

/** Is this an inlined content item rather than a plain object? */
function isContent(value: unknown): value is AmplienceContent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AmplienceContent)._meta?.schema === "string"
  );
}

/**
 * Walk every inlined content item in the tree, depth-first.
 *
 * Components nest arbitrarily — on the PDP, `ratingsAndReviews` and the
 * spotlight components are children of `productDetails`, not siblings — so a
 * top-level scan of `componentList` misses most of them.
 */
export function* walkContent(root: unknown): Generator<AmplienceContent> {
  if (Array.isArray(root)) {
    for (const item of root) yield* walkContent(item);
    return;
  }
  if (typeof root !== "object" || root === null) return;
  if (isContent(root)) yield root;
  for (const value of Object.values(root)) yield* walkContent(value);
}

/**
 * Find the first content item whose schema URI ends with `schemaSuffix`,
 * e.g. `productDetails`. Searches the whole tree, not just top-level slots.
 */
export function findComponent<T extends AmplienceContent = AmplienceContent>(
  root: unknown,
  schemaSuffix: string,
): T | undefined {
  for (const item of walkContent(root)) {
    if (item._meta.schema.endsWith(schemaSuffix)) return item as T;
  }
  return undefined;
}
