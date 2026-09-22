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
 * Map frontend reason strings to Shopify ReturnReason enum values.
 */
function mapReturnReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();

  const map = {
    "doesn't fit": "SIZE_TOO_SMALL",
    "not as described": "NOT_AS_DESCRIBED",
    "changed my mind": "UNWANTED",
    "damaged / defective": "DEFECTIVE",
    "wrong item received": "WRONG_ITEM",
    "other": "OTHER",
    // Fallbacks for direct enum values
    "size_too_small": "SIZE_TOO_SMALL",
    "size_too_large": "SIZE_TOO_LARGE",
    "color": "COLOR",
    "defective": "DEFECTIVE",
    "not_as_described": "NOT_AS_DESCRIBED",
    "style": "STYLE",
    "unwanted": "UNWANTED",
    "wrong_item": "WRONG_ITEM",
    "other": "OTHER",
  };

  return map[normalized] || "OTHER";
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
    return (
      shopifyOrderNumber === orderNumber &&
      shopifyEmail === email
    );
  });

  return matchedOrder || null;
}

/**
 * Get returnable fulfillment line items for an order.
 * Returns an array of { fulfillmentLineItemId, quantity } objects.
 */
const RETURNABLE_FULFILLMENTS_QUERY = `
  query ReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      edges {
        node {
          id
          returnableFulfillmentLineItems(first: 50) {
            edges {
              node {
                fulfillmentLineItem {
                  id
                }
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

async function getReturnableFulfillmentLineItems(orderId) {
  const data = await shopifyGraphQL(RETURNABLE_FULFILLMENTS_QUERY, { orderId });
  const fulfillments = data?.returnableFulfillments?.edges || [];
  const lineItems = [];

  fulfillments.forEach((edge) => {
    const items = edge.node?.returnableFulfillmentLineItems?.edges || [];
    items.forEach((itemEdge) => {
      const item = itemEdge.node;
      if (item?.fulfillmentLineItem?.id) {
        lineItems.push({
          fulfillmentLineItemId: item.fulfillmentLineItem.id,
          availableQuantity: item.quantity,
        });
      }
    });
  });

  return lineItems;
}

/**
 * Create a return in Shopify.
 * Returns { ok, returnData, errors }.
 */
const RETURN_CREATE_MUTATION = `
  mutation ReturnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
        name
        status
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function createShopifyReturn(orderId, returnLineItems) {
  const input = {
    orderId,
    notifyCustomer: true,
    returnLineItems: returnLineItems.map((item) => ({
      fulfillmentLineItemId: item.fulfillmentLineItemId,
      quantity: item.quantity,
      returnReason: item.returnReason,
      returnReasonNote: item.returnReasonNote || "",
    })),
  };

  const data = await shopifyGraphQL(RETURN_CREATE_MUTATION, {
    returnInput: input,
  });

  const payload = data?.returnCreate;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    return { ok: false, errors: userErrors };
  }

  return { ok: true, returnData: payload?.return };
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
          currency: order.totalPriceSet.shopMoney.currencyCode,
        }
      : null,
    items: (order.lineItems?.nodes || []).map((item) => ({
      id: item.id,
      title: item.name,
      quantity: item.quantity,
      image: item.image
        ? {
            url: item.image.url,
            alt: item.image.altText || null,
          }
        : null,
      unitPrice: item.originalUnitPriceSet?.shopMoney
        ? {
            amount: item.originalUnitPriceSet.shopMoney.amount,
            currency: item.originalUnitPriceSet.shopMoney.currencyCode,
          }
        : null,
      fulfillmentStatus: item.fulfillmentStatus,
    })),
    returns: (order.returns?.nodes || []).map((returnItem) => ({
      id: returnItem.id,
      name: returnItem.name,
      status: returnItem.status,
      createdAt: returnItem.createdAt,
      requestApprovedAt: returnItem.requestApprovedAt,
      closedAt: returnItem.closedAt,
    })),
  };
}

/**
 * Handle "lookup" intent
 */
async function handleLookup(res, body) {
  const orderNumber = normalizeOrderNumber(body.orderNumber || body.order_number);
  const email = normalizeEmail(body.email);

  if (!orderNumber || !email) {
    return sendJson(res, 400, {
      ok: false,
      error: "Order number and email are required.",
    });
  }

  if (!isValidEmail(email)) {
    return sendJson(res, 400, {
      ok: false,
      error: "Please enter a valid email address.",
    });
  }

  if (orderNumber.length > 50) {
    return sendJson(res, 400, {
      ok: false,
      error: "Invalid order number.",
    });
  }

  const order = await findOrder(orderNumber, email);

  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details.",
    });
  }

  return sendJson(res, 200, {
    ok: true,
    order: serializeOrder(order),
  });
}

/**
 * Handle "submit" intent — create Shopify return
 */
async function handleSubmit(res, body) {
  const orderNumber = normalizeOrderNumber(body.orderNumber || body.order_number);
  const email = normalizeEmail(body.email);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!orderNumber || !email) {
    return sendJson(res, 400, {
      ok: false,
      error: "Order number and email are required.",
    });
  }

  if (!items.length) {
    return sendJson(res, 400, {
      ok: false,
      error: "At least one item is required.",
    });
  }

  // 1. Find the order to get its Shopify ID
  const order = await findOrder(orderNumber, email);

  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "Order not found. Please check your details.",
    });
  }

  // 2. Get returnable fulfillment line items for this order
  let returnableLineItems;
  try {
    returnableLineItems = await getReturnableFulfillmentLineItems(order.id);
  } catch (err) {
    console.error("Failed to fetch returnable fulfillments:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "Could not retrieve returnable items from Shopify.",
    });
  }

  if (!returnableLineItems.length) {
    return sendJson(res, 400, {
      ok: false,
      error: "This order has no items eligible for return.",
    });
  }

  // 3. Build return line items by matching requested items to returnable fulfillment items
  const returnLineItems = [];

  for (const requestedItem of items) {
    const returnable = returnableLineItems.find(
      (r) => r.fulfillmentLineItemId === requestedItem.item_id
    );

    if (!returnable) {
      return sendJson(res, 400, {
        ok: false,
        error: `Item "${requestedItem.title || requestedItem.item_id}" is not eligible for return.`,
      });
    }

    const qty = Math.min(
      Number(requestedItem.quantity) || 1,
      returnable.availableQuantity
    );

    returnLineItems.push({
      fulfillmentLineItemId: returnable.fulfillmentLineItemId,
      quantity: qty,
      returnReason: mapReturnReason(requestedItem.reason),
      returnReasonNote: "",
    });
  }

  // 4. Create the return in Shopify
  let result;
  try {
    result = await createShopifyReturn(order.id, returnLineItems);
  } catch (err) {
    console.error("returnCreate mutation failed:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "An unexpected error occurred while creating the return.",
    });
  }

  if (!result.ok) {
    const errorMsg =
      result.errors?.[0]?.message || "Failed to create return in Shopify.";
    console.error("Return userErrors:", result.errors);
    return sendJson(res, 400, {
      ok: false,
      error: errorMsg,
    });
  }

  // 5. Success — Shopify automatically sends email to customer
  console.log("Return created successfully:", result.returnData);

  return sendJson(res, 200, {
    ok: true,
    message: "Return request submitted.",
    reference: result.returnData?.name || orderNumber,
    returnId: result.returnData?.id,
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
        error: "Method not allowed.",
      });
    }

    const proxy = verifyAppProxyRequest(req);
    if (!proxy.valid) {
      console.warn("Invalid App Proxy request:", proxy.reason);
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized.",
      });
    }

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
      error: "An unexpected server error occurred.",
    });
  }
}