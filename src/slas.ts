/**
 * SLAS (Shopper Login and API Access Service) auth for ASDA's Salesforce
 * Commerce Cloud backend.
 *
 * Mints its own guest tokens via the public-client PKCE flow, so nothing here
 * depends on a credential captured from a browser session.
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

/** Refresh this many seconds before actual expiry, to cover clock skew. */
const EXPIRY_SKEW_SECONDS = 60;

export interface SlasTokenResponse {
  access_token: string;
  refresh_token: string;
  /** Seconds. Observed as 1800. */
  expires_in: number;
  refresh_token_expires_in?: number;
  token_type: string;
  usid: string;
  customer_id: string;
  enc_user_id?: string;
  id_token?: string;
  idp_access_token?: string;
}

export class SlasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "SlasError";
  }
}

export interface SlasClientOptions {
  shortCode?: string;
  organizationId?: string;
  clientId?: string;
  channelId?: string;
  redirectUri?: string;
  fetch?: typeof globalThis.fetch;
}

const base64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** RFC 7636 verifier/challenge pair. */
async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(digest) };
}

export class SlasClient {
  private readonly config: Required<Omit<SlasClientOptions, "fetch">>;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** Cached token, with an absolute expiry rather than a relative one. */
  private token?: { value: SlasTokenResponse; expiresAtMs: number };
  /** De-duplicates concurrent refreshes into a single in-flight request. */
  private pending?: Promise<SlasTokenResponse>;

  constructor(options: SlasClientOptions = {}) {
    this.config = {
      shortCode: options.shortCode ?? ASDA_COMMERCE.shortCode,
      organizationId: options.organizationId ?? ASDA_COMMERCE.organizationId,
      clientId: options.clientId ?? ASDA_COMMERCE.clientId,
      channelId: options.channelId ?? ASDA_COMMERCE.channelId,
      redirectUri: options.redirectUri ?? ASDA_COMMERCE.redirectUri,
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private get baseUrl(): string {
    return `https://${this.config.shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${this.config.organizationId}`;
  }

  /** A valid access token, minting or refreshing one only when needed. */
  async getAccessToken(): Promise<string> {
    const cached = this.token;
    if (cached && Date.now() < cached.expiresAtMs) return cached.value.access_token;

    this.pending ??= this.authenticate().finally(() => {
      this.pending = undefined;
    });
    return (await this.pending).access_token;
  }

  private async authenticate(): Promise<SlasTokenResponse> {
    const existing = this.token?.value.refresh_token;
    const token = existing
      ? await this.refresh(existing).catch(() => this.loginAsGuest())
      : await this.loginAsGuest();

    this.token = {
      value: token,
      expiresAtMs: Date.now() + (token.expires_in - EXPIRY_SKEW_SECONDS) * 1000,
    };
    return token;
  }

  /**
   * Public-client PKCE guest login. The authorize step returns a 303 whose
   * Location carries the auth code, so redirects must not be followed.
   */
  async loginAsGuest(): Promise<SlasTokenResponse> {
    const { verifier, challenge } = await createPkcePair();

    const authorizeUrl = `${this.baseUrl}/oauth2/authorize?${new URLSearchParams({
      client_id: this.config.clientId,
      channel_id: this.config.channelId,
      code_challenge: challenge,
      hint: "guest",
      redirect_uri: this.config.redirectUri,
      response_type: "code",
    })}`;

    const authorizeResponse = await this.fetchImpl(authorizeUrl, {
      redirect: "manual",
    });
    const location = authorizeResponse.headers.get("location");
    if (!location) {
      throw new SlasError(
        "SLAS authorize did not redirect; the client ID or redirect URI is likely wrong",
        authorizeResponse.status,
        await authorizeResponse.text(),
      );
    }

    const params = new URL(location, this.baseUrl).searchParams;
    const code = params.get("code");
    const usid = params.get("usid");
    if (!code || !usid) {
      throw new SlasError(
        `SLAS authorize redirect missing code/usid: ${location}`,
        authorizeResponse.status,
        location,
      );
    }

    return this.requestToken({
      grant_type: "authorization_code_pkce",
      code,
      code_verifier: verifier,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      channel_id: this.config.channelId,
      usid,
    });
  }

  async refresh(refreshToken: string): Promise<SlasTokenResponse> {
    return this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      channel_id: this.config.channelId,
    });
  }

  private async requestToken(
    form: Record<string, string>,
  ): Promise<SlasTokenResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new SlasError(
        `SLAS token request failed (${form.grant_type})`,
        response.status,
        body,
      );
    }
    return body as SlasTokenResponse;
  }
}
