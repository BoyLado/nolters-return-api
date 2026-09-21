import { shopifyGraphQL } from "../_lib/shopify.js";
import { verifyAppProxyRequest } from "../_lib/app-proxy.js";

/**
 * Send JSON response
 */
function sendJson(res, status, data) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.end(JSON.stringify(data));
}

/**
 * Normalize email
 */
function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * Normalize order number
 *
 * 4153  -> #4153
 * #4153 -> #4153
 */
function normalizeOrderNumber(value) {
  let orderNumber = String(value || "")
    .trim()
    .replace(/\s+/g, "");

  if (
    orderNumber &&
    !orderNumber.startsWith("#")
  ) {
    orderNumber = `#${orderNumber}`;
  }

  return orderNumber;
}

/**
 * Basic email validation
 */
function isValidEmail(email) {
  if (!email || email.length > 254) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Escape Shopify search values
 */
function escapeSearchValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Read request body
 */
async function readBody(req) {
  /**
   * Vercel may already provide req.body.
   */
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") {
      return req.body;
    }

    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new Error("Invalid JSON request body.");
      }
    }
  }

  /**
   * Fallback for raw Node requests.
   */
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

/**
 * Shopify Admin GraphQL query
 *
 * We search by email first.
 * Then we perform an exact server-side check
 * against both order number and email.
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
 * Find order by email + exact order number
 */
async function findOrder(orderNumber, email) {
  const query = `email:"${escapeSearchValue(email)}"`;

  const data = await shopifyGraphQL(
    ORDER_STATUS_QUERY,
    {
      query
    }
  );

  const orders = data?.orders?.nodes || [];

  const matchedOrder = orders.find((order) => {
    const shopifyOrderNumber = String(
      order.name || ""
    ).trim();

    const shopifyEmail = normalizeEmail(
      order.email
    );

    return (
      shopifyOrderNumber === orderNumber &&
      shopifyEmail === email
    );
  });

  return matchedOrder || null;
}

/**
 * Convert Shopify order into a safe public response.
 *
 * We intentionally do NOT expose the entire
 * Shopify Order object.
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

    total: order.totalPriceSet?.shopMoney
      ? {
          amount:
            order.totalPriceSet.shopMoney.amount,

          currency:
            order.totalPriceSet.shopMoney.currencyCode
        }
      : null,

    items: (
      order.lineItems?.nodes || []
    ).map((item) => ({
      id: item.id,

      title: item.name,

      quantity: item.quantity,

      image: item.image
        ? {
            url: item.image.url,
            alt: item.image.altText || null
          }
        : null,

      unitPrice:
        item.originalUnitPriceSet?.shopMoney
          ? {
              amount:
                item.originalUnitPriceSet
                  .shopMoney.amount,

              currency:
                item.originalUnitPriceSet
                  .shopMoney.currencyCode
            }
          : null,

      fulfillmentStatus:
        item.fulfillmentStatus
    })),

    returns: (
      order.returns?.nodes || []
    ).map((returnItem) => ({
      id: returnItem.id,

      name: returnItem.name,

      status: returnItem.status,

      createdAt: returnItem.createdAt,

      requestApprovedAt:
        returnItem.requestApprovedAt,

      closedAt: returnItem.closedAt
    }))
  };
}

/**
 * Main API handler
 */
export default async function handler(req, res) {
  try {
    /**
     * Only POST requests are allowed.
     */
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return sendJson(res, 405, {
        success: false,
        error: "Method not allowed."
      });
    }

    /**
     * Verify Shopify App Proxy.
     */
    const proxy = verifyAppProxyRequest(req);

    if (!proxy.valid) {
      console.warn(
        "Invalid App Proxy request:",
        proxy.reason
      );

      return sendJson(res, 401, {
        success: false,
        error: "Unauthorized."
      });
    }

    /**
     * Read JSON body.
     */
    const body = await readBody(req);

    const orderNumber = normalizeOrderNumber(
      body.orderNumber
    );

    const email = normalizeEmail(
      body.email
    );

    /**
     * Validate required fields.
     */
    if (!orderNumber || !email) {
      return sendJson(res, 400, {
        success: false,
        error:
          "Order number and email are required."
      });
    }

    /**
     * Validate email.
     */
    if (!isValidEmail(email)) {
      return sendJson(res, 400, {
        success: false,
        error:
          "Please enter a valid email address."
      });
    }

    /**
     * Prevent excessively long input.
     */
    if (orderNumber.length > 50) {
      return sendJson(res, 400, {
        success: false,
        error: "Invalid order number."
      });
    }

    /**
     * Search Shopify.
     */
    const order = await findOrder(
      orderNumber,
      email
    );

    /**
     * Do not reveal whether an order number
     * exists if the email doesn't match.
     */
    if (!order) {
      return sendJson(res, 404, {
        success: false,
        error:
          "We couldn't find an order matching those details."
      });
    }

    /**
     * Success.
     */
    return sendJson(res, 200, {
      success: true,
      order: serializeOrder(order)
    });
  } catch (error) {
    console.error(
      "ORDER STATUS ERROR:",
      error
    );

    return sendJson(res, 500, {
      success: false,
      error:
        "An unexpected server error occurred."
    });
  }
}