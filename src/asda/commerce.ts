/**
 * Connection constants for ASDA's Salesforce Commerce Cloud backend.
 *
 * The cart flow (`cart.ts`) talks to Commerce Cloud with a token pasted from a
 * logged-in browser session, so only these published identifiers are needed. A
 * self-minting SLAS guest-token client used to live here for the product-detail
 * path; it was removed with that path and is recoverable from git history.
 */

export const ASDA_COMMERCE = {
  shortCode: "ohwhuw6h",
  organizationId: "f_ecom_bjgs_prd",
  /** SLAS public client ID, published in the site's own JS bundle. */
  clientId: "e68ca36d-6516-4704-b705-06b74f85ef2e",
  channelId: "ASDA_GROCERIES",
  /** Must be a redirect URI registered against the SLAS client. */
  redirectUri: "https://www.asda.com/callback",
} as const;
