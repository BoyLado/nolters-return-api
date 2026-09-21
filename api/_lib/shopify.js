const API_VERSION = "2026-07";

/**
 * Get required environment variable.
 */
function getEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing ${name} environment variable.`
    );
  }

  return value.trim();
}

/**
 * Get Shopify shop domain.
 *
 * Supported:
 * SHOPIFY_SHOP=nolters
 * SHOPIFY_SHOP=nolters.myshopify.com
 * SHOPIFY_SHOP=https://nolters.myshopify.com
 */
function getShopDomain() {
  let shop = getEnv("SHOPIFY_SHOP");

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  if (!shop.includes(".")) {
    shop = `${shop}.myshopify.com`;
  }

  return shop;
}

/**
 * Get Shopify Admin API access token
 * using the client credentials grant.
 */
export async function getShopifyAccessToken() {
  const shop = getShopDomain();

  const clientId = getEnv(
    "SHOPIFY_CLIENT_ID"
  );

  const clientSecret = getEnv(
    "SHOPIFY_CLIENT_SECRET"
  );

  const tokenUrl =
    `https://${shop}/admin/oauth/access_token`;

  console.log(
    "Requesting Shopify access token for:",
    shop
  );

  const response = await fetch(tokenUrl, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },

    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Shopify authentication failed:",
      {
        status: response.status,
        response: responseText
      }
    );

    throw new Error(
      `Unable to authenticate with Shopify. HTTP ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error(
      "Shopify returned invalid JSON:",
      responseText
    );

    throw new Error(
      "Shopify returned an invalid authentication response."
    );
  }

  if (!data.access_token) {
    console.error(
      "Shopify authentication response did not contain an access token."
    );

    throw new Error(
      "Shopify did not return an access token."
    );
  }

  console.log(
    "Shopify access token obtained successfully."
  );

  return data.access_token;
}

/**
 * Execute Shopify Admin GraphQL request.
 */
export async function shopifyGraphQL(
  query,
  variables = {}
) {
  const shop = getShopDomain();

  const accessToken =
    await getShopifyAccessToken();

  const graphqlUrl =
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(
    graphqlUrl,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Shopify-Access-Token":
          accessToken
      },

      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Shopify GraphQL HTTP error:",
      {
        status: response.status,
        response: responseText
      }
    );

    throw new Error(
      `Shopify GraphQL request failed. HTTP ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error(
      "Shopify GraphQL returned invalid JSON:",
      responseText
    );

    throw new Error(
      "Shopify GraphQL returned invalid JSON."
    );
  }

  /**
   * GraphQL can return HTTP 200 while still
   * containing GraphQL errors.
   */
  if (
    Array.isArray(data.errors) &&
    data.errors.length > 0
  ) {
    console.error(
      "Shopify GraphQL errors:",
      data.errors
    );

    throw new Error(
      data.errors
        .map(
          (error) =>
            error.message ||
            "Unknown Shopify GraphQL error."
        )
        .join("; ")
    );
  }

  return data.data;
}