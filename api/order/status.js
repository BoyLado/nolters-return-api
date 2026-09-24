import { shopifyGraphQL } from "../_lib/shopify.js";
import { verifyAppProxyRequest } from "../_lib/app-proxy.js";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * ============================================================
 * CONFIGURATION CONSTANTS
 * ============================================================
 */

/**
 * Return window: 7 days from delivery.
 * Items delivered more than 7 days ago are not returnable.
 */
const RETURN_WINDOW_DAYS = 7;

/**
 * Damage report window: 48 hours from delivery.
 * Damaged/defective items must be reported within this window.
 */
const DAMAGE_REPORT_WINDOW_HOURS = 48;

/**
 * Max results when querying orders by name.
 * Shopify's `orders` query has a max of 250.
 */
const MAX_ORDER_QUERY_RESULTS = 20;

/**
 * Final sale tags — items with these tags are not returnable.
 * Matching is case-insensitive and uses substring matching.
 */
const FINAL_SALE_TAGS = [
  "final-sale",
  "final sale",
  "no-return",
  "custom",
  "engraved",
  "personalized",
  "customized",
];

/**
 * Custom attribute keys that indicate final sale items.
 * Matching is case-insensitive and uses substring matching.
 */
const FINAL_SALE_ATTR_KEYWORDS = [
  "engrav",
  "personali",
  "custom",
  "monogram",
];

/**
 * ============================================================
 * UTILITY FUNCTIONS
 * ============================================================
 */

/**
 * Send JSON response with proper headers.
 */
function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
}

/**
 * Normalize email: trim + lowercase.
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Normalize order number: trim, remove spaces, add # prefix.
 *
 * Examples:
 *   "4153"    → "#4153"
 *   "#4153"   → "#4153"
 *   "# 4153"  → "#4153"
 *   " 4153 "  → "#4153"
 */
function normalizeOrderNumber(value) {
  let orderNumber = String(value || "").trim().replace(/\s+/g, "");
  if (orderNumber && !orderNumber.startsWith("#")) {
    orderNumber = `#${orderNumber}`;
  }
  return orderNumber;
}

/**
 * Validate email format.
 */
function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Escape a value for use in Shopify GraphQL search query.
 */
function escapeSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Map frontend reason strings to Shopify ReturnReason enum.
 *
 * IMPORTANT: Shopify only accepts specific enum values.
 * Custom strings will be rejected by the API.
 */
function mapReturnReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();

  const map = {
    "doesn't fit": "SIZE_TOO_SMALL",
    "doesn’t fit": "SIZE_TOO_SMALL",
    "not as described": "NOT_AS_DESCRIBED",
    "changed my mind": "UNWANTED",
    "damaged / defective": "DEFECTIVE",
    "wrong item received": "WRONG_ITEM",
    "other": "OTHER",
  };

  return map[normalized] || "OTHER";
}

/**
 * Check if an item is within the 7-day return window.
 *
 * @param {string|null} deliveredAt - ISO date string of delivery
 * @returns {boolean}
 */
function isWithinReturnWindow(deliveredAt) {
  if (!deliveredAt) return false;
  const delivered = new Date(deliveredAt).getTime();
  if (isNaN(delivered)) return false;
  const now = Date.now();
  const diffMs = now - delivered;
  return diffMs <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Check if an item is within the 48-hour damage report window.
 *
 * @param {string|null} deliveredAt - ISO date string of delivery
 * @returns {boolean}
 */
function isWithinDamageWindow(deliveredAt) {
  if (!deliveredAt) return false;
  const delivered = new Date(deliveredAt).getTime();
  if (isNaN(delivered)) return false;
  const now = Date.now();
  const diffMs = now - delivered;
  return diffMs <= DAMAGE_REPORT_WINDOW_HOURS * 60 * 60 * 1000;
}

/**
 * Check if an item is final sale based on:
 * - Product tags (e.g., "final-sale", "engraved")
 * - Custom attributes (e.g., "Engraving", "Personalization")
 *
 * @param {object} item - Shopify line item
 * @returns {boolean}
 */
function isFinalSaleItem(item) {
  // Check product tags
  const tags = (item.product?.tags || []).map((t) => String(t).toLowerCase());
  const hasFinalSaleTag = tags.some((tag) =>
    FINAL_SALE_TAGS.some((fs) => tag.includes(fs))
  );

  // Check custom attributes
  const attrs = item.customAttributes || [];
  const hasCustomAttr = attrs.some((attr) => {
    const key = String(attr.key || "").toLowerCase();
    return FINAL_SALE_ATTR_KEYWORDS.some((kw) => key.includes(kw));
  });

  return hasFinalSaleTag || hasCustomAttr;
}

/**
 * Read request body (supports both pre-parsed and stream).
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
 * ============================================================
 * GRAPHQL QUERIES & MUTATIONS
 * ============================================================
 */

/**
 * Order lookup query.
 *
 * Includes:
 * - Order basics (name, email, dates, status)
 * - Line items with images, prices, tags, customAttributes
 * - Fulfillments with deliveredAt (for return window check)
 * - Existing returns
 *
 * NOTE: `customer { ... }` block is NOT included because
 * the app only has `read_orders` scope, not `read_customers`.
 * Order.email is sufficient for our needs.
 */
const ORDER_STATUS_QUERY = `
  query OrderStatus($query: String!) {
    orders(
      first: ${MAX_ORDER_QUERY_RESULTS}
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
            customAttributes {
              key
              value
            }
            product {
              id
              tags
            }
          }
        }
        fulfillments(first: 10) {
          nodes {
            id
            status
            deliveredAt
            createdAt
            trackingInfo {
              number
              url
            }
            fulfillmentLineItems(first: 50) {
              edges {
                node {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
            }
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
 * Returnable fulfillments query.
 *
 * Includes:
 * - Line item name and image (for return items page)
 * - Fulfillment line item ID (for returnCreate mutation)
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
                quantity
                fulfillmentLineItem {
                  id
                  lineItem {
                    id
                    name
                    image {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Return create mutation.
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

/**
 * Return approve mutation — triggers customer notification.
 *
 * NOTE: Auto-approve is the default behavior for eligible returns
 * (within 7-day window, not final sale, not outside 48h damage window).
 * The eligibility is already checked before this mutation is called.
 */
const RETURN_APPROVE_MUTATION = `
  mutation ReturnApproveRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return {
        id
        name
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * ============================================================
 * CORE BUSINESS LOGIC
 * ============================================================
 */

/**
 * Find order by order number AND email.
 *
 * Requirement: Both orderNumber and email must match for security.
 *
 * Strategy:
 * 1. Query Shopify by `name` (order number) — specific and fast.
 * 2. Verify the email matches manually.
 * 3. Return the order only if both match.
 *
 * Why query by `name` instead of `email`?
 * - The `orders` query has a 60-day limit and returns max 250 results.
 * - If a customer has many orders, the specific order might not be in the results.
 * - Querying by `name` is more precise and reliable.
 */
async function findOrder(orderNumber, email) {
  const query = `name:"${escapeSearchValue(orderNumber)}"`;
  const data = await shopifyGraphQL(ORDER_STATUS_QUERY, { query });
  const orders = data?.orders?.nodes || [];

  // Find order with matching order number AND email
  const order = orders.find((o) => {
    const shopifyOrderNumber = String(o.name || "").trim();
    const shopifyEmail = normalizeEmail(o.email);
    return (
      shopifyOrderNumber === orderNumber &&
      shopifyEmail === email
    );
  });

  if (!order) {
    console.log(
      "findOrder: No match. Order number:",
      orderNumber,
      "| Email:",
      email,
      "| Orders found by name:",
      orders.length,
      "| Emails found:",
      orders.map((o) => normalizeEmail(o.email)).join(", ")
    );
    return null;
  }

  return order;
}

/**
 * Get returnable fulfillment line items for an order.
 *
 * Returns array of:
 * {
 *   fulfillmentLineItemId: string,
 *   lineItemId: string,
 *   availableQuantity: number,
 *   title: string,
 *   image: { url, alt } | null
 * }
 */
async function getReturnableFulfillmentLineItems(orderId) {
  const data = await shopifyGraphQL(RETURNABLE_FULFILLMENTS_QUERY, { orderId });
  const fulfillments = data?.returnableFulfillments?.edges || [];
  const lineItems = [];

  fulfillments.forEach((edge) => {
    const items = edge.node?.returnableFulfillmentLineItems?.edges || [];
    items.forEach((itemEdge) => {
      const item = itemEdge.node;
      const fli = item?.fulfillmentLineItem;
      if (fli?.id && fli?.lineItem?.id) {
        lineItems.push({
          fulfillmentLineItemId: fli.id,
          lineItemId: fli.lineItem.id,
          availableQuantity: item.quantity,
          title: fli.lineItem.name || "",
          image: fli.lineItem.image
            ? {
                url: fli.lineItem.image.url,
                alt: fli.lineItem.image.altText || null,
              }
            : null,
        });
      }
    });
  });

  return lineItems;
}

/**
 * Build a map of lineItemId → deliveredAt timestamp.
 *
 * Used for:
 * - 7-day return window check
 * - 48-hour damage report window check
 */
function buildDeliveryMap(order) {
  const map = new Map();
  (order.fulfillments?.nodes || []).forEach((f) => {
    if (!f.deliveredAt) return;
    (f.fulfillmentLineItems?.edges || []).forEach((edge) => {
      map.set(edge.node.lineItem.id, f.deliveredAt);
    });
  });
  return map;
}

/**
 * Create a Shopify return and auto-approve it.
 *
 * Since eligible items are already filtered by the 7-day window
 * (and 48-hour damage window) before reaching this function,
 * we can safely auto-approve all returns here.
 *
 * The customer will receive Shopify's native return confirmation
 * email (configured in Shopify Admin → Notifications).
 */
async function createShopifyReturn(orderId, returnLineItems) {
  const input = {
    orderId,
    returnLineItems: returnLineItems.map((item) => ({
      fulfillmentLineItemId: item.fulfillmentLineItemId,
      quantity: item.quantity,
      returnReason: item.returnReason,
      returnReasonNote: item.returnReasonNote || "",
    })),
  };

  // Step 1: Create the return
  const createData = await shopifyGraphQL(RETURN_CREATE_MUTATION, {
    returnInput: input,
  });

  const createPayload = createData?.returnCreate;
  const createErrors = createPayload?.userErrors || [];

  if (createErrors.length > 0) {
    return { ok: false, errors: createErrors };
  }

  const returnId = createPayload?.return?.id;
  if (!returnId) {
    return {
      ok: false,
      errors: [{ message: "Return created but no ID returned." }],
    };
  }

  // Step 2: Auto-approve + notify customer
  console.log("Auto-approving return and notifying customer...");

  const approveData = await shopifyGraphQL(RETURN_APPROVE_MUTATION, {
    input: {
      id: returnId,
      notifyCustomer: true,
    },
  });

  const approvePayload = approveData?.returnApproveRequest;
  const approveErrors = approvePayload?.userErrors || [];

  if (approveErrors.length > 0) {
    // Return was created successfully, but approval failed.
    // Log the error, but don't fail the whole request.
    // The merchant can manually approve in Shopify Admin.
    console.warn("Return created but auto-approve failed:", approveErrors);
    return {
      ok: true,
      returnData: createPayload?.return,
      autoApproved: false,
      approvalError: approveErrors[0]?.message || "Approval failed.",
    };
  }

  console.log("Return auto-approved successfully.");
  return {
    ok: true,
    returnData: approvePayload?.return || createPayload?.return,
    autoApproved: true,
  };
}

/**
 * ============================================================
 * EMAIL NOTIFICATION
 * ============================================================
 */

/**
 * Send merchant notification email via Resend.
 *
 * This is for awareness only — the return has already been
 * auto-approved. The merchant will still need to inspect the
 * returned item and issue the refund manually.
 */
async function sendMerchantNotification({ order, returnData, items }) {
  console.log("=== sendMerchantNotification START ===");

  const merchantEmail = process.env.MERCHANT_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;
  const storeName = process.env.STORE_NAME || "Store";
  const adminUrl = process.env.STORE_ADMIN_URL || "";

  if (!merchantEmail || !fromEmail || !process.env.RESEND_API_KEY) {
    console.warn("Merchant notification skipped — missing env vars.");
    return { skipped: true };
  }

  const orderId = String(order.id || "").split("/").pop();
  const orderLink = adminUrl ? `${adminUrl}/orders/${orderId}` : "";
  const returnName = returnData?.name || "Return";

  const itemsHtml = items
    .map(
      (i) => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">${i.title || ""}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${i.quantity}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${i.reason || ""}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${i.note || "—"}</td>
        </tr>`
    )
    .join("");

  const customerDisplay = order.email || "Customer";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="margin:0 0 16px;">New return request (auto-approved)</h2>
      <p>
        A customer has submitted a return request for <strong>${storeName}</strong>.
        The return has been <strong>automatically approved</strong> because it falls within the 7-day return window.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr>
          <td style="padding:8px;background:#f5f5f5;width:160px;"><strong>Order</strong></td>
          <td style="padding:8px;">${order.name || ""}</td>
        </tr>
        <tr>
          <td style="padding:8px;background:#f5f5f5;"><strong>Return</strong></td>
          <td style="padding:8px;">${returnName}</td>
        </tr>
        <tr>
          <td style="padding:8px;background:#f5f5f5;"><strong>Customer</strong></td>
          <td style="padding:8px;">${customerDisplay}</td>
        </tr>
      </table>

      <h3 style="margin:24px 0 8px;font-size:16px;">Items</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:center;">Qty</th>
            <th style="padding:8px;text-align:left;">Reason</th>
            <th style="padding:8px;text-align:left;">Note</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <div style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:4px;margin:16px 0;">
        <strong>⚠️ Return Policy Reminders:</strong>
        <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;">
          <li>Return window: 7 days from delivery</li>
          <li>Customer pays return shipping</li>
          <li>No return labels provided</li>
          <li>Refund within 2-5 business days after inspection</li>
          <li>Original shipping costs are non-refundable</li>
          <li>Inspect the item upon receipt before issuing refund</li>
        </ul>
      </div>

      ${
        orderLink
          ? `<p style="margin-top:24px;">
              <a href="${orderLink}" style="display:inline-block;padding:10px 20px;background:#121212;color:#fff;text-decoration:none;border-radius:4px;">
                View in Shopify Admin
              </a>
            </p>`
          : ""
      }

      <p style="margin-top:24px;font-size:12px;color:#888;">
        This is an automated notification from ${storeName}.
      </p>
    </div>
  `;

  const text = `
New return request (auto-approved)

Order: ${order.name}
Return: ${returnName}
Customer: ${order.email}

Items:
${items
  .map(
    (i) =>
      `- ${i.title} (Qty ${i.quantity}) — ${i.reason}${
        i.note ? ` — ${i.note}` : ""
      }`
  )
  .join("\n")}

${orderLink ? `View: ${orderLink}` : ""}
  `.trim();

  try {
    const result = await resend.emails.send({
      from: `${storeName} <${fromEmail}>`,
      to: merchantEmail,
      replyTo: order.email || undefined,
      subject: `New return request (auto-approved) — ${order.name} (${returnName})`,
      html,
      text,
    });

    if (result?.error) {
      console.error("Resend returned error:", result.error);
      return { ok: false, error: result.error };
    }

    console.log("Merchant notification sent:", result?.data?.id);
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error("Resend send failed:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * ============================================================
 * SERIALIZATION
 * ============================================================
 */

/**
 * Serialize order for frontend.
 *
 * Adds eligibility markers per item:
 * - withinWindow: within 7-day return window
 * - withinDamageWindow: within 48-hour damage report window
 * - finalSale: is a final sale item
 */
function serializeOrder(order) {
  const deliveryMap = buildDeliveryMap(order);

  return {
    number: order.name,
    email: order.email,
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
    items: (order.lineItems?.nodes || []).map((item) => {
      const deliveredAt = deliveryMap.get(item.id) || null;
      const withinWindow = isWithinReturnWindow(deliveredAt);
      const withinDamageWindow = isWithinDamageWindow(deliveredAt);
      const finalSale = isFinalSaleItem(item);

      return {
        id: item.id,
        title: item.name,
        quantity: item.quantity,
        image: item.image
          ? { url: item.image.url, alt: item.image.altText || null }
          : null,
        unitPrice: item.originalUnitPriceSet?.shopMoney
          ? {
              amount: item.originalUnitPriceSet.shopMoney.amount,
              currency: item.originalUnitPriceSet.shopMoney.currencyCode,
            }
          : null,
        fulfillmentStatus: item.fulfillmentStatus,
        deliveredAt,
        withinWindow,
        withinDamageWindow,
        finalSale,
      };
    }),
    returns: (order.returns?.nodes || []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: r.createdAt,
      requestApprovedAt: r.requestApprovedAt,
      closedAt: r.closedAt,
    })),
  };
}

/**
 * ============================================================
 * REQUEST HANDLERS
 * ============================================================
 */

/**
 * LOOKUP — find order by order number + email.
 *
 * Returns order details with eligibility markers per item.
 */
async function handleLookup(res, body) {
  const orderNumber = normalizeOrderNumber(body.orderNumber || body.order_number);
  const email = normalizeEmail(body.email);

  // Validate inputs
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

  // Find order (both order number and email must match)
  const order = await findOrder(orderNumber, email);
  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details.",
    });
  }

  // Get returnable items from Shopify
  let returnableIds = new Set();
  try {
    const returnable = await getReturnableFulfillmentLineItems(order.id);
    returnable.forEach((r) => returnableIds.add(r.lineItemId));
  } catch (err) {
    console.error("Failed to fetch returnable items:", err);
    // Continue — lahat ng items ay hindi eligible kung may error
  }

  const serialized = serializeOrder(order);

  // Mark eligibility per item
  serialized.items = serialized.items.map((item) => ({
    ...item,
    eligible:
      returnableIds.has(item.id) &&
      item.withinWindow &&
      !item.finalSale,
  }));

  return sendJson(res, 200, { ok: true, order: serialized });
}

/**
 * SUBMIT — create Shopify return + auto-approve + notify merchant.
 *
 * Eligibility is double-checked here even though the frontend
 * only shows eligible items, to prevent bypassing the policy.
 */
async function handleSubmit(res, body) {
  const orderNumber = normalizeOrderNumber(body.orderNumber || body.order_number);
  const email = normalizeEmail(body.email);
  const items = Array.isArray(body.items) ? body.items : [];

  // Validate inputs
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
  if (!items.length) {
    return sendJson(res, 400, {
      ok: false,
      error: "At least one item is required.",
    });
  }

  // Step 1: Find order (both order number and email must match)
  const order = await findOrder(orderNumber, email);
  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "Order not found.",
    });
  }

  // Step 2: Get returnable items
  let returnable;
  try {
    returnable = await getReturnableFulfillmentLineItems(order.id);
  } catch (err) {
    console.error("Failed to fetch returnable fulfillments:", err);
    return sendJson(res, 500, {
      ok: false,
      error: "Could not retrieve returnable items from Shopify.",
    });
  }

  if (!returnable.length) {
    return sendJson(res, 400, {
      ok: false,
      error: "This order has no items eligible for return.",
    });
  }

  const deliveryMap = buildDeliveryMap(order);

  // Step 3: Validate each requested item
  const returnLineItems = [];

  for (const requestedItem of items) {
    const match = returnable.find(
      (r) => r.lineItemId === requestedItem.item_id
    );

    if (!match) {
      console.warn(
        "No returnable match for item_id:",
        requestedItem.item_id,
        "| Title:",
        requestedItem.title
      );
      return sendJson(res, 400, {
        ok: false,
        error: `Item "${
          requestedItem.title || requestedItem.item_id
        }" is not eligible for return.`,
      });
    }

    // Double-check return window
    const deliveredAt = deliveryMap.get(requestedItem.item_id) || null;
    const isDamaged =
      String(requestedItem.reason || "").toLowerCase().includes("damaged") ||
      String(requestedItem.reason || "").toLowerCase().includes("defective");

    if (!isWithinReturnWindow(deliveredAt)) {
      return sendJson(res, 400, {
        ok: false,
        error: `Item "${requestedItem.title}" is outside the ${RETURN_WINDOW_DAYS}-day return window.`,
      });
    }

    if (isDamaged && !isWithinDamageWindow(deliveredAt)) {
      return sendJson(res, 400, {
        ok: false,
        error: `Damaged/defective items must be reported within ${DAMAGE_REPORT_WINDOW_HOURS} hours of delivery.`,
      });
    }

    const qty = Math.min(
      Number(requestedItem.quantity) || 1,
      match.availableQuantity
    );

    returnLineItems.push({
      fulfillmentLineItemId: match.fulfillmentLineItemId,
      quantity: qty,
      returnReason: mapReturnReason(requestedItem.reason),
      returnReasonNote: requestedItem.note || "",
    });
  }

  // Step 4: Create return + auto-approve + notify customer
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
    return sendJson(res, 400, { ok: false, error: errorMsg });
  }

  console.log("Return created successfully:", result.returnData);

  // Step 5: Notify merchant via Resend (non-blocking)
  try {
    await sendMerchantNotification({
      order,
      returnData: result.returnData,
      items,
    });
  } catch (err) {
    console.error("Merchant notification error:", err);
    // Hindi fatal — successful pa rin ang return
  }

  // Step 6: Respond to customer
  return sendJson(res, 200, {
    ok: true,
    message: result.autoApproved
      ? "Return request submitted and approved. Check your email for return instructions."
      : "Return request submitted. Our team will review it shortly.",
    reference: result.returnData?.name || orderNumber,
    returnId: result.returnData?.id,
    autoApproved: result.autoApproved || false,
  });
}

/**
 * ============================================================
 * MAIN HANDLER
 * ============================================================
 */

export default async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    }

    // Verify App Proxy request
    const proxy = verifyAppProxyRequest(req);
    if (!proxy.valid) {
      console.warn("Invalid App Proxy request:", proxy.reason);
      return sendJson(res, 401, { ok: false, error: "Unauthorized." });
    }

    // Parse body
    const body = await readBody(req);
    const intent = body.intent || "lookup";

    console.log("INTENT:", intent);

    // Route to handler
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