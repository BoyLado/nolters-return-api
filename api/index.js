import crypto from "node:crypto";

const SHOPIFY_API_VERSION = "2026-07";

/**
 * ---------------------------------------------------------
 * ENVIRONMENT
 * ---------------------------------------------------------
 */

const REQUIRED_ENV = [
  "SHOPIFY_SHOP",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
];

function getEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Missing environment variable: ${key}`);
    }
  }

  return {
    shop: normalizeShop(process.env.SHOPIFY_SHOP),
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  };
}

/**
 * Accept:
 *
 * nolters
 * nolters.myshopify.com
 * https://nolters.myshopify.com
 *
 * and normalize everything to:
 *
 * nolters.myshopify.com
 */

function normalizeShop(value) {
  let shop = String(value || "").trim();

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/i, "");

  if (!shop) {
    throw new Error("Invalid SHOPIFY_SHOP");
  }

  return `${shop}.myshopify.com`;
}

/**
 * ---------------------------------------------------------
 * TOKEN CACHE
 * ---------------------------------------------------------
 *
 * Client-credentials access tokens expire after 24 hours.
 *
 * We keep the token in memory when possible.
 * Vercel may create a new function instance at any time,
 * so the code must always be able to request a fresh token.
 */

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getShopifyAccessToken() {
  const now = Date.now();

  // Reuse token if it still has at least 5 minutes left.
  if (
    tokenCache.accessToken &&
    tokenCache.expiresAt > now + 5 * 60 * 1000
  ) {
    return tokenCache.accessToken;
  }

  const { shop, clientId, clientSecret } = getEnv();

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

  const data = await safeJson(response);

  if (!response.ok || !data.access_token) {
    console.error("Shopify token error:", {
      status: response.status,
      data,
    });

    throw new Error(
      "Unable to authenticate with Shopify."
    );
  }

  const expiresIn =
    Number(data.expires_in) || 86399;

  tokenCache = {
    accessToken: data.access_token,
    expiresAt:
      Date.now() + expiresIn * 1000,
  };

  return tokenCache.accessToken;
}

/**
 * ---------------------------------------------------------
 * SHOPIFY ADMIN GRAPHQL
 * ---------------------------------------------------------
 */

async function shopifyGraphQL(query, variables = {}) {
  const { shop } = getEnv();
  const accessToken =
    await getShopifyAccessToken();

  const url =
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const payload = await safeJson(response);

  if (!response.ok) {
    console.error("Shopify GraphQL HTTP error:", {
      status: response.status,
      payload,
    });

    throw new Error(
      "Shopify API request failed."
    );
  }

  if (payload.errors?.length) {
    console.error(
      "Shopify GraphQL errors:",
      payload.errors
    );

    throw new Error(
      "Shopify API returned an error."
    );
  }

  return payload.data;
}

/**
 * ---------------------------------------------------------
 * APP PROXY HMAC VERIFICATION
 * ---------------------------------------------------------
 *
 * Shopify signs App Proxy requests using the app's
 * shared secret.
 *
 * We verify:
 *
 * signature
 * shop
 * timestamp
 */

function verifyShopifyAppProxy(requestUrl) {
  const url = new URL(requestUrl);

  const signature =
    url.searchParams.get("signature");

  const shop =
    url.searchParams.get("shop");

  const timestamp =
    url.searchParams.get("timestamp");

  if (!signature || !shop || !timestamp) {
    return {
      valid: false,
      reason: "Missing Shopify proxy authentication.",
    };
  }

  const timestampNumber =
    Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return {
      valid: false,
      reason: "Invalid timestamp.",
    };
  }

  // Reject stale requests.
  const age =
    Math.abs(
      Math.floor(Date.now() / 1000) -
      timestampNumber
    );

  if (age > 300) {
    return {
      valid: false,
      reason: "Expired Shopify proxy request.",
    };
  }

  let expectedShop;

  try {
    expectedShop =
      normalizeShop(process.env.SHOPIFY_SHOP);
  } catch {
    return {
      valid: false,
      reason: "Server shop configuration error.",
    };
  }

  if (
    shop.toLowerCase() !==
    expectedShop.toLowerCase()
  ) {
    return {
      valid: false,
      reason: "Unknown Shopify shop.",
    };
  }

  const params = new URLSearchParams(url.search);

  params.delete("signature");

  const grouped = {};

  for (const [key, value] of params.entries()) {
    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(value);
  }

  const message = Object.keys(grouped)
    .sort()
    .map(
      (key) =>
        `${key}=${grouped[key].join(",")}`
    )
    .join("");

  const secret =
    process.env.SHOPIFY_CLIENT_SECRET;

  const calculatedSignature =
    crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("hex");

  const providedBuffer =
    Buffer.from(signature, "utf8");

  const calculatedBuffer =
    Buffer.from(
      calculatedSignature,
      "utf8"
    );

  if (
    providedBuffer.length !==
    calculatedBuffer.length
  ) {
    return {
      valid: false,
      reason: "Invalid Shopify signature.",
    };
  }

  const valid =
    crypto.timingSafeEqual(
      providedBuffer,
      calculatedBuffer
    );

  return {
    valid,
    reason: valid
      ? null
      : "Invalid Shopify signature.",
    shop,
  };
}

/**
 * ---------------------------------------------------------
 * INPUT VALIDATION
 * ---------------------------------------------------------
 */

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeOrderNumber(value) {
  let orderNumber =
    String(value || "").trim();

  // Remove whitespace.
  orderNumber =
    orderNumber.replace(/\s+/g, "");

  // Standard Shopify order number usually
  // looks like #1001.
  if (
    !orderNumber.startsWith("#")
  ) {
    orderNumber =
      `#${orderNumber}`;
  }

  return orderNumber;
}

/**
 * ---------------------------------------------------------
 * ORDER LOOKUP
 * ---------------------------------------------------------
 */

const ORDER_STATUS_QUERY = `
  query OrderStatus($query: String!) {
    orders(
      first: 5
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      nodes {
        id
        name
        createdAt
        email

        displayFinancialStatus
        displayFulfillmentStatus

        returnStatus

        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }

        lineItems(first: 50) {
          nodes {
            id
            name
            quantity

            image {
              url
              altText
            }

            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            fulfillmentStatus
          }
        }

        returns(first: 20) {
          nodes {
            id
            name
            status
            createdAt
            requestApprovedAt
            closedAt
          }
        }
      }
    }
  }
`;

/**
 * We search using order name + email,
 * then perform an exact server-side comparison.
 *
 * This is important because customer-provided
 * data must never be trusted just because Shopify's
 * search returned a result.
 */

async function lookupOrder({
  orderNumber,
  email,
}) {
  const normalizedOrder =
    normalizeOrderNumber(orderNumber);

  const normalizedEmail =
    normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error(
      "Order number and email are required."
    );
  }

  // Only allow reasonable email length.
  if (normalizedEmail.length > 254) {
    throw new Error(
      "Invalid order credentials."
    );
  }

  // Shopify search syntax.
  //
  // We use a conservative order-name value.
  // The email is also used to narrow the search.
  const searchQuery =
    `name:${escapeShopifySearchValue(
      normalizedOrder
    )} email:${escapeShopifySearchValue(
      normalizedEmail
    )}`;

  const data =
    await shopifyGraphQL(
      ORDER_STATUS_QUERY,
      {
        query: searchQuery,
      }
    );

  const orders =
    data?.orders?.nodes || [];

  // Exact verification.
  const order =
    orders.find((candidate) => {
      const candidateEmail =
        normalizeEmail(candidate.email);

      return (
        candidate.name ===
          normalizedOrder &&
        candidateEmail ===
          normalizedEmail
      );
    });

  if (!order) {
    return null;
  }

  return order;
}

/**
 * Escape characters that can affect Shopify's
 * search query syntax.
 */

function escapeShopifySearchValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * ---------------------------------------------------------
 * SAFE PUBLIC ORDER RESPONSE
 * ---------------------------------------------------------
 *
 * Never return the raw Shopify Order object.
 */

function serializeOrder(order) {
  return {
    number: order.name,

    createdAt: order.createdAt,

    financialStatus:
      order.displayFinancialStatus,

    fulfillmentStatus:
      order.displayFulfillmentStatus,

    returnStatus:
      order.returnStatus,

    total: order.totalPriceSet
      ? {
          amount:
            order.totalPriceSet.shopMoney.amount,
          currency:
            order.totalPriceSet.shopMoney.currencyCode,
        }
      : null,

    items:
      order.lineItems?.nodes?.map(
        (item) => ({
          id: item.id,
          title: item.name,
          quantity: item.quantity,

          image: item.image
            ? {
                url: item.image.url,
                alt:
                  item.image.altText || null,
              }
            : null,

          unitPrice:
            item.originalUnitPriceSet
              ?.shopMoney
              ? {
                  amount:
                    item.originalUnitPriceSet
                      .shopMoney.amount,
                  currency:
                    item.originalUnitPriceSet
                      .shopMoney.currencyCode,
                }
              : null,

          fulfillmentStatus:
            item.fulfillmentStatus,
        })
      ) || [],

    returns:
      order.returns?.nodes?.map(
        (returnItem) => ({
          id: returnItem.id,
          name: returnItem.name,
          status: returnItem.status,
          createdAt:
            returnItem.createdAt,
          requestApprovedAt:
            returnItem.requestApprovedAt,
          closedAt:
            returnItem.closedAt,
        })
      ) || [],
  };
}

/**
 * ---------------------------------------------------------
 * JSON RESPONSE
 * ---------------------------------------------------------
 */

function json(
  response,
  status,
  data
) {
  response.statusCode = status;

  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  response.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  response.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  response.end(
    JSON.stringify(data)
  );
}

/**
 * ---------------------------------------------------------
 * BODY PARSER
 * ---------------------------------------------------------
 */

async function getRequestBody(request) {
  // Vercel's Node request may already expose
  // a parsed body.
  if (
    request.body !== undefined &&
    request.body !== null
  ) {
    if (
      typeof request.body ===
      "object"
    ) {
      return request.body;
    }

    if (
      typeof request.body ===
      "string"
    ) {
      try {
        return JSON.parse(
          request.body
        );
      } catch {
        throw new Error(
          "Invalid JSON body."
        );
      }
    }
  }

  return {};
}

/**
 * ---------------------------------------------------------
 * ROUTES
 * ---------------------------------------------------------
 */

async function handleHealth(request, response) {
  json(response, 200, {
    success: true,
    service:
      "Nolters Orders & Returns API",
    version: "1.0.0",
    shop:
      normalizeShop(
        process.env.SHOPIFY_SHOP
      ),
  });
}

async function handleOrderStatus(
  request,
  response
) {
  if (request.method !== "POST") {
    response.setHeader(
      "Allow",
      "POST"
    );

    return json(
      response,
      405,
      {
        success: false,
        error:
          "Method not allowed.",
      }
    );
  }

  const body =
    await getRequestBody(request);

  const orderNumber =
    String(
      body.orderNumber || ""
    ).trim();

  const email =
    String(
      body.email || ""
    ).trim();

  if (
    !orderNumber ||
    !email
  ) {
    return json(
      response,
      400,
      {
        success: false,
        error:
          "Order number and email are required.",
      }
    );
  }

  const order =
    await lookupOrder({
      orderNumber,
      email,
    });

  /**
   * IMPORTANT:
   *
   * Use the same public error for:
   *
   * - order doesn't exist
   * - email doesn't match
   *
   * This prevents order enumeration.
   */

  if (!order) {
    return json(
      response,
      404,
      {
        success: false,
        error:
          "We couldn't find an order matching those details.",
      }
    );
  }

  return json(
    response,
    200,
    {
      success: true,
      order:
        serializeOrder(order),
    }
  );
}

/**
 * ---------------------------------------------------------
 * MAIN HANDLER
 * ---------------------------------------------------------
 */

export default async function handler(
  request,
  response
) {
  try {
    /**
     * Health check is intentionally separate.
     *
     * For production we can later protect it or
     * remove it entirely.
     */

    const url =
      new URL(
        request.url,
        `https://${request.headers.host}`
      );

    let pathname =
      url.pathname;

    /**
     * If using the Vercel rewrite:
     *
     * /api/order/status
     *       ↓
     * /api/index
     *
     * We use the original request URL/path to
     * determine the route.
     */

    if (
      pathname === "/api" ||
      pathname === "/api/"
    ) {
      pathname = "/api/health";
    }

    /**
     * Health endpoint.
     */

    if (
      pathname === "/api/health"
    ) {
      return handleHealth(
        request,
        response
      );
    }

    /**
     * All customer-facing API routes must
     * come through Shopify App Proxy.
     */

    const proxyAuth =
      verifyShopifyAppProxy(
        url.toString()
      );

    if (!proxyAuth.valid) {
      return json(
        response,
        401,
        {
          success: false,
          error:
            "Unauthorized.",
        }
      );
    }

    /**
     * ORDER STATUS
     */

    if (
      pathname ===
      "/api/order/status"
    ) {
      return await handleOrderStatus(
        request,
        response
      );
    }

    /**
     * Unknown route.
     */

    return json(
      response,
      404,
      {
        success: false,
        error:
          "Endpoint not found.",
      }
    );
  } catch (error) {
    console.error(
      "API ERROR:",
      error
    );

    return json(
      response,
      500,
      {
        success: false,
        error:
          "An unexpected server error occurred.",
      }
    );
  }
}