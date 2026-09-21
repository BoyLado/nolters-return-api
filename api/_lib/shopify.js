const SHOPIFY_API_VERSION = "2026-07";

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

/**
 * Get and validate environment variables.
 */
function getConfig() {
  const required = [
    "SHOPIFY_SHOP",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(
        `Missing environment variable: ${key}`
      );
    }
  }

  return {
    shop: normalizeShop(process.env.SHOPIFY_SHOP),
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  };
}

/**
 * Shopify expects the store subdomain.
 *
 * Accepted:
 *   nolters
 *   nolters.myshopify.com
 *   https://nolters.myshopify.com
 *
 * Internally we normalize to:
 *   nolters.myshopify.com
 */
function normalizeShop(value) {
  let shop = String(value || "").trim();

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/i, "");

  if (!shop) {
    throw new Error("Invalid SHOPIFY_SHOP.");
  }

  return `${shop}.myshopify.com`;
}

/**
 * Get a Shopify Admin API access token.
 *
 * Client Credentials Grant:
 *
 * POST
 * https://STORE.myshopify.com/admin/oauth/access_token
 *
 * Tokens are valid for 24 hours.
 */
export async function getShopifyAccessToken() {
  const now = Date.now();

  /**
   * Reuse the existing token when possible.
   *
   * Refresh 5 minutes before expiration.
   */
  if (
    tokenCache.accessToken &&
    tokenCache.expiresAt >
      now + 5 * 60 * 1000
  ) {
    return tokenCache.accessToken;
  }

  const {
    shop,
    clientId,
    clientSecret,
  } = getConfig();

  const tokenUrl =
    `https://${shop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
    },

    body: body.toString(),
  });

  let data;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (
    !response.ok ||
    !data ||
    !data.access_token
  ) {
    console.error(
      "Shopify authentication failed:",
      {
        status: response.status,
        error: data?.error,
        error_description:
          data?.error_description,
      }
    );

    throw new Error(
      "Unable to authenticate with Shopify."
    );
  }

  const expiresIn =
    Number(data.expires_in) || 86399;

  tokenCache = {
    accessToken: data.access_token,

    /**
     * Store slightly less than the actual
     * expiration time.
     */
    expiresAt:
      Date.now() +
      expiresIn * 1000,
  };

  return tokenCache.accessToken;
}

/**
 * Execute a Shopify Admin GraphQL request.
 */
export async function shopifyGraphQL(
  query,
  variables = {}
) {
  const { shop } = getConfig();

  let accessToken =
    await getShopifyAccessToken();

  const graphqlUrl =
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function makeRequest(token) {
    return fetch(graphqlUrl, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Shopify-Access-Token":
          token,
      },

      body: JSON.stringify({
        query,
        variables,
      }),
    });
  }

  let response =
    await makeRequest(accessToken);

  /**
   * If Shopify says the token is unauthorized,
   * clear our cached token and obtain a new one.
   */
  if (response.status === 401) {
    tokenCache = {
      accessToken: null,
      expiresAt: 0,
    };

    accessToken =
      await getShopifyAccessToken();

    response =
      await makeRequest(accessToken);
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Shopify returned an invalid response."
    );
  }

  if (!response.ok) {
    console.error(
      "Shopify GraphQL HTTP error:",
      {
        status: response.status,
        errors: payload?.errors,
      }
    );

    throw new Error(
      "Shopify API request failed."
    );
  }

  if (
    payload.errors &&
    payload.errors.length > 0
  ) {
    console.error(
      "Shopify GraphQL errors:",
      payload.errors
    );

    throw new Error(
      "Shopify GraphQL returned an error."
    );
  }

  return payload.data;
}

/**
 * Export the normalized shop name.
 *
 * Useful for diagnostics and other modules.
 */
export function getShopifyShop() {
  return normalizeShop(
    process.env.SHOPIFY_SHOP
  );
}