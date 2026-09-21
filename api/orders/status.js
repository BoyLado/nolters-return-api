import {
  shopifyGraphQL,
} from "../_lib/shopify.js";

import {
  verifyAppProxyRequest,
} from "../_lib/app-proxy.js";

/**
 * ---------------------------------------------------------
 * RESPONSE HELPER
 * ---------------------------------------------------------
 */

function json(
  res,
  status,
  data
) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  /**
   * Customer order information should never
   * be cached by browsers/CDNs.
   */
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.end(
    JSON.stringify(data)
  );
}

/**
 * ---------------------------------------------------------
 * INPUT NORMALIZATION
 * ---------------------------------------------------------
 */

function normalizeEmail(
  email
) {
  return String(
    email || ""
  )
    .trim()
    .toLowerCase();
}

function normalizeOrderNumber(
  value
) {
  let orderNumber =
    String(value || "")
      .trim();

  /**
   * Remove whitespace.
   */
  orderNumber =
    orderNumber.replace(
      /\s+/g,
      ""
    );

  /**
   * Customer may enter:
   *
   * 1001
   * #1001
   *
   * Internally we use:
   *
   * #1001
   */
  if (
    orderNumber &&
    !orderNumber.startsWith("#")
  ) {
    orderNumber =
      `#${orderNumber}`;
  }

  return orderNumber;
}

/**
 * Basic email validation.
 *
 * This is not intended to be a complete RFC parser.
 * Shopify performs the actual order matching.
 */
function isValidEmail(
  email
) {
  if (
    !email ||
    email.length > 254
  ) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

/**
 * ---------------------------------------------------------
 * REQUEST BODY
 * ---------------------------------------------------------
 */

async function getRequestBody(
  req
) {
  /**
   * Vercel's Node.js runtime may already expose
   * req.body depending on the request.
   */
  if (
    req.body !== undefined &&
    req.body !== null
  ) {
    if (
      typeof req.body ===
      "object"
    ) {
      return req.body;
    }

    if (
      typeof req.body ===
      "string"
    ) {
      try {
        return JSON.parse(
          req.body
        );
      } catch {
        throw new Error(
          "Invalid JSON request body."
        );
      }
    }
  }

  /**
   * Fallback parser for raw Node requests.
   */
  const chunks = [];

  for await (
    const chunk of req
  ) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw =
    Buffer.concat(chunks)
      .toString("utf8");

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid JSON request body."
    );
  }
}

/**
 * ---------------------------------------------------------
 * SHOPIFY SEARCH ESCAPING
 * ---------------------------------------------------------
 */

function escapeShopifySearchValue(
  value
) {
  return String(value)
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /"/g,
      '\\"'
    );
}

/**
 * ---------------------------------------------------------
 * SHOPIFY ORDER QUERY
 * ---------------------------------------------------------
 *
 * We search by email first.
 *
 * Then we perform an exact comparison against
 * the requested order number and email.
 *
 * This is safer than trusting search results alone.
 */

const ORDER_STATUS_QUERY = `
  query OrderStatus($query: String!) {
    orders(
      first: 20
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      nodes {
        id
        name
        email
        createdAt

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
 * Find an order by:
 *
 *   order number
 *   customer email
 *
 * Both values must match.
 */
async function findOrder(
  orderNumber,
  email
) {
  /**
   * We intentionally search by email.
   *
   * Shopify's orders query supports email
   * filtering.
   */
  const searchQuery =
    `email:"${escapeShopifySearchValue(
      email
    )}"`;

  const data =
    await shopifyGraphQL(
      ORDER_STATUS_QUERY,
      {
        query: searchQuery,
      }
    );

  const orders =
    data?.orders?.nodes || [];

  /**
   * Exact server-side verification.
   *
   * Never trust the search result alone.
   */
  const matchingOrder =
    orders.find(
      (order) => {
        const shopifyOrderNumber =
          String(
            order.name || ""
          ).trim();

        const shopifyEmail =
          normalizeEmail(
            order.email
          );

        return (
          shopifyOrderNumber ===
            orderNumber &&
          shopifyEmail ===
            email
        );
      }
    );

  return (
    matchingOrder || null
  );
}

/**
 * ---------------------------------------------------------
 * PUBLIC ORDER RESPONSE
 * ---------------------------------------------------------
 *
 * Do NOT return the entire Shopify Order object.
 */

function serializeOrder(
  order
) {
  return {
    number:
      order.name,

    createdAt:
      order.createdAt,

    financialStatus:
      order.displayFinancialStatus,

    fulfillmentStatus:
      order.displayFulfillmentStatus,

    returnStatus:
      order.returnStatus,

    total:
      order.totalPriceSet
        ?.shopMoney
        ? {
            amount:
              order.totalPriceSet
                .shopMoney
                .amount,

            currency:
              order.totalPriceSet
                .shopMoney
                .currencyCode,
          }
        : null,

    items:
      (
        order.lineItems
          ?.nodes || []
      ).map(
        (item) => ({
          id:
            item.id,

          title:
            item.name,

          quantity:
            item.quantity,

          image:
            item.image
              ? {
                  url:
                    item.image.url,

                  alt:
                    item.image
                      .altText ||
                    null,
                }
              : null,

          unitPrice:
            item
              .originalUnitPriceSet
              ?.shopMoney
              ? {
                  amount:
                    item
                      .originalUnitPriceSet
                      .shopMoney
                      .amount,

                  currency:
                    item
                      .originalUnitPriceSet
                      .shopMoney
                      .currencyCode,
                }
              : null,

          fulfillmentStatus:
            item.fulfillmentStatus,
        })
      ),

    returns:
      (
        order.returns
          ?.nodes || []
      ).map(
        (returnItem) => ({
          id:
            returnItem.id,

          name:
            returnItem.name,

          status:
            returnItem.status,

          createdAt:
            returnItem.createdAt,

          requestApprovedAt:
            returnItem.requestApprovedAt,

          closedAt:
            returnItem.closedAt,
        })
      ),
  };
}

/**
 * ---------------------------------------------------------
 * MAIN HANDLER
 * ---------------------------------------------------------
 */

export default async function handler(
  req,
  res
) {
  try {
    /**
     * Only POST is allowed.
     */
    if (
      req.method !== "POST"
    ) {
      res.setHeader(
        "Allow",
        "POST"
      );

      return json(
        res,
        405,
        {
          success: false,
          error:
            "Method not allowed.",
        }
      );
    }

    /**
     * IMPORTANT:
     *
     * This endpoint is intended to be called
     * through Shopify App Proxy.
     *
     * Direct calls to:
     *
     * /api/order/status
     *
     * should fail because they won't have
     * Shopify's proxy signature.
     */
    const proxy =
      verifyAppProxyRequest(
        req
      );

    if (!proxy.valid) {
      return json(
        res,
        401,
        {
          success: false,
          error:
            "Unauthorized.",
        }
      );
    }

    /**
     * Read request body.
     */
    const body =
      await getRequestBody(
        req
      );

    const orderNumber =
      normalizeOrderNumber(
        body.orderNumber
      );

    const email =
      normalizeEmail(
        body.email
      );

    /**
     * Validate required values.
     */
    if (
      !orderNumber ||
      !email
    ) {
      return json(
        res,
        400,
        {
          success: false,
          error:
            "Order number and email are required.",
        }
      );
    }

    /**
     * Validate email format.
     */
    if (
      !isValidEmail(email)
    ) {
      return json(
        res,
        400,
        {
          success: false,
          error:
            "Please enter a valid email address.",
        }
      );
    }

    /**
     * Reasonable order-number protection.
     */
    if (
      orderNumber.length > 50
    ) {
      return json(
        res,
        400,
        {
          success: false,
          error:
            "Invalid order number.",
        }
      );
    }

    /**
     * Find order in Shopify.
     */
    const order =
      await findOrder(
        orderNumber,
        email
      );

    /**
     * Same response whether:
     *
     * - order doesn't exist
     * - email doesn't match
     *
     * This avoids exposing whether a particular
     * order number exists.
     */
    if (!order) {
      return json(
        res,
        404,
        {
          success: false,
          error:
            "We couldn't find an order matching those details.",
        }
      );
    }

    /**
     * Return only the fields needed by
     * the customer-facing Order Status page.
     */
    return json(
      res,
      200,
      {
        success: true,

        order:
          serializeOrder(
            order
          ),
      }
    );
  } catch (error) {
    console.error(
      "ORDER STATUS ERROR:",
      error
    );

    return json(
      res,
      500,
      {
        success: false,
        error:
          "An unexpected server error occurred.",
      }
    );
  }
}