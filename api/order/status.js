import { shopifyGraphQL } from "../_lib/shopify.js";
import { verifyAppProxyRequest } from "../_lib/app-proxy.js";

/**
 * Send JSON response
 */
function sendJson(res, status, data) {
  res.statusCode = status;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.end(JSON.stringify(data));
}

/**
 * Normalize email
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Normalize order number
 * 4153  -> #4153
 * #4153 -> #4153
 */
function normalizeOrderNumber(value) {
  let orderNumber = String(value || "").trim().replace(/\s+/g, "");

  if (orderNumber && !orderNumber.startsWith("#")) {
    orderNumber = `#${orderNumber}`;
  }

  return orderNumber;
}

/**
 * Basic email validation
 */
function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Escape Shopify search values
 */
function escapeSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Read request body
 */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return req.body;

    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new Error("Invalid JSON request body.");
      }
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

/**
 * Shopify Admin GraphQL query
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

  const data = await shopifyGraphQL(ORDER_STATUS_QUERY, { query });

  const orders = data?.orders?.nodes || [];

  const matchedOrder = orders.find((order) => {
    const shopifyOrderNumber = String(order.name || "").trim();
    const shopifyEmail = normalizeEmail(order.email);

    return shopifyOrderNumber === orderNumber && shopifyEmail === email;
  });

  return matchedOrder || null;
}

/**
 * Convert Shopify order into a safe public response.
 */
function serializeOrder(order) {
  return {
    number: order.name,
    createdAt: order.createdAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    returnStatus: order.returnStatus,

    total: order.totalPriceSet?.shopMoney
      ? {
          amount: order.totalPriceSet.shopMoney.amount,
          currency: order.totalPriceSet.shopMoney.currencyCode
        }
      : null,

    items: (order.lineItems?.nodes || []).map((item) => ({
      id: item.id,
      title: item.name,
      quantity: item.quantity,

      image: item.image
        ? {
            url: item.image.url,
            alt: item.image.altText || null
          }
        : null,

      unitPrice: item.originalUnitPriceSet?.shopMoney
        ? {
            amount: item.originalUnitPriceSet.shopMoney.amount,
            currency: item.originalUnitPriceSet.shopMoney.currencyCode
          }
        : null,

      fulfillmentStatus: item.fulfillmentStatus
    })),

    returns: (order.returns?.nodes || []).map((returnItem) => ({
      id: returnItem.id,
      name: returnItem.name,
      status: returnItem.status,
      createdAt: returnItem.createdAt,
      requestApprovedAt: returnItem.requestApprovedAt,
      closedAt: returnItem.closedAt
    }))
  };
}

/**
 * Handle "lookup" intent — find order by number + email
 */
async function handleLookup(res, body) {
  const orderNumber = normalizeOrderNumber(
    body.orderNumber || body.order_number   /* accept both */
  );
  const email = normalizeEmail(body.email);

  if (!orderNumber || !email) {
    return sendJson(res, 400, {
      ok: false,
      error: "Order number and email are required."
    });
  }

  if (!isValidEmail(email)) {
    return sendJson(res, 400, {
      ok: false,
      error: "Please enter a valid email address."
    });
  }

  if (orderNumber.length > 50) {
    return sendJson(res, 400, {
      ok: false,
      error: "Invalid order number."
    });
  }

  const order = await findOrder(orderNumber, email);

  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details."
    });
  }

  return sendJson(res, 200, {
    ok: true,
    order: serializeOrder(order)
  });
}

/**
 * Handle "submit" intent — receive return request
 *
 * NOTE: Real return creation via Shopify API (returnCreate mutation)
 * is out of scope here. This stores the request in logs and returns
 * success so the UI flow works. Extend this to send an email or
 * create the actual Shopify return.
 */
async function handleSubmit(res, body) {
  const orderNumber = normalizeOrderNumber(
    body.orderNumber || body.order_number
  );
  const email = normalizeEmail(body.email);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!orderNumber || !email) {
    return sendJson(res, 400, {
      ok: false,
      error: "Order number and email are required."
    });
  }

  if (!items.length) {
    return sendJson(res, 400, {
      ok: false,
      error: "At least one item is required."
    });
  }

  console.log("RETURN REQUEST RECEIVED:", {
    orderNumber,
    email,
    items,
    timestamp: new Date().toISOString()
  });

  /* TODO: send email to store owner, create Shopify return, etc. */

  return sendJson(res, 200, {
    ok: true,
    message: "Return request received.",
    reference: orderNumber
  });
}

/**
 * Main API handler
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, {
        ok: false,
        error: "Method not allowed."
      });
    }

    /* Verify Shopify App Proxy */
    const proxy = verifyAppProxyRequest(req);

    if (!proxy.valid) {
      console.warn("Invalid App Proxy request:", proxy.reason);
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized."
      });
    }

    /* Read body */
    const body = await readBody(req);
    const intent = body.intent || "lookup";

    console.log("INTENT:", intent, "| BODY:", JSON.stringify(body));

    if (intent === "submit") {
      return await handleSubmit(res, body);
    }

    return await handleLookup(res, body);
  } catch (error) {
    console.error("ORDER STATUS ERROR:", error);

    return sendJson(res, 500, {
      ok: false,
      error: "An unexpected server error occurred."
    });
  }
}