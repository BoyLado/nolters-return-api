import { shopifyGraphQL } from "../_lib/shopify.js";
import { verifyAppProxyRequest } from "../_lib/app-proxy.js";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeOrderNumber(value) {
  let orderNumber = String(value || "").trim().replace(/\s+/g, "");
  if (orderNumber && !orderNumber.startsWith("#")) {
    orderNumber = `#${orderNumber}`;
  }
  return orderNumber;
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Map frontend reason strings to Shopify ReturnReason enum
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
 * Order lookup query
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
        customer {
          firstName
          lastName
          email
        }
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

async function findOrder(orderNumber, email) {
  const query = `email:"${escapeSearchValue(email)}"`;
  const data = await shopifyGraphQL(ORDER_STATUS_QUERY, { query });
  const orders = data?.orders?.nodes || [];

  return (
    orders.find((order) => {
      const shopifyOrderNumber = String(order.name || "").trim();
      const shopifyEmail = normalizeEmail(order.email);
      return (
        shopifyOrderNumber === orderNumber &&
        shopifyEmail === email
      );
    }) || null
  );
}

/**
 * Returnable fulfillments query.
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
        });
      }
    });
  });

  return lineItems;
}

/**
 * Return create mutation
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
 * Return approve mutation — triggers customer notification
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

  // Step 2: Approve + notify customer
  const approveData = await shopifyGraphQL(RETURN_APPROVE_MUTATION, {
    input: {
      id: returnId,
      notifyCustomer: true,
    },
  });

  const approvePayload = approveData?.returnApproveRequest;
  const approveErrors = approvePayload?.userErrors || [];

  if (approveErrors.length > 0) {
    console.warn("Return approved but notify failed:", approveErrors);
    return { ok: true, returnData: createPayload?.return };
  }

  return {
    ok: true,
    returnData: approvePayload?.return || createPayload?.return,
  };
}

/**
 * Send merchant notification email via Resend
 */
async function sendMerchantNotification({ order, returnData, items }) {
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
          <td style="padding:8px;border-bottom:1px solid #eee;">
            ${i.title || ""}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">
            ${i.quantity}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;">
            ${i.reason || ""}
          </td>
        </tr>`
    )
    .join("");

  const customerName =
    [order.customer?.firstName, order.customer?.lastName]
      .filter(Boolean)
      .join(" ") || "Customer";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="margin:0 0 16px;">New return request</h2>
      <p>A customer has submitted a return request for <strong>${storeName}</strong>.</p>

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
          <td style="padding:8px;">${customerName} &lt;${order.email || ""}&gt;</td>
        </tr>
      </table>

      <h3 style="margin:24px 0 8px;font-size:16px;">Items</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:center;">Qty</th>
            <th style="padding:8px;text-align:left;">Reason</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

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
New return request

Order: ${order.name}
Return: ${returnName}
Customer: ${customerName} <${order.email}>

Items:
${items.map((i) => `- ${i.title} (Qty ${i.quantity}) — ${i.reason}`).join("\n")}

${orderLink ? `View: ${orderLink}` : ""}
  `.trim();

  try {
    const result = await resend.emails.send({
      from: `${storeName} <${fromEmail}>`,
      to: merchantEmail,
      replyTo: order.email || undefined,
      subject: `New return request — ${order.name} (${returnName})`,
      html,
      text,
    });

    console.log("Merchant notification sent:", result?.data?.id || result);
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error("Resend send failed:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * Serialize order for frontend
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
        ? { url: item.image.url, alt: item.image.altText || null }
        : null,
      unitPrice: item.originalUnitPriceSet?.shopMoney
        ? {
            amount: item.originalUnitPriceSet.shopMoney.amount,
            currency: item.originalUnitPriceSet.shopMoney.currencyCode,
          }
        : null,
      fulfillmentStatus: item.fulfillmentStatus,
    })),
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
 * LOOKUP
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
    return sendJson(res, 400, { ok: false, error: "Invalid order number." });
  }

  const order = await findOrder(orderNumber, email);
  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details.",
    });
  }

  return sendJson(res, 200, { ok: true, order: serializeOrder(order) });
}

/**
 * SUBMIT — create Shopify return + notify merchant
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

  // 1. Find order
  const order = await findOrder(orderNumber, email);
  if (!order) {
    return sendJson(res, 404, { ok: false, error: "Order not found." });
  }

  // 2. Get returnable items
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

  console.log("RETURNABLE ITEMS:", JSON.stringify(returnable, null, 2));
  console.log("REQUESTED ITEMS:", JSON.stringify(items, null, 2));

  // 3. Match by LineItem.id
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
        error: `Item "${requestedItem.title || requestedItem.item_id}" is not eligible for return.`,
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
      returnReasonNote: "",
    });
  }

  // 4. Create return (+ approve + notify customer)
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

  // 5. Notify merchant via Resend (non-blocking — failure won't break the return)
  try {
    await sendMerchantNotification({
      order,
      returnData: result.returnData,
      items,
    });
  } catch (err) {
    console.error("Merchant notification error:", err);
    // Hindi ito fatal — successful pa rin ang return
  }

  return sendJson(res, 200, {
    ok: true,
    message: "Return request submitted.",
    reference: result.returnData?.name || orderNumber,
    returnId: result.returnData?.id,
  });
}

/**
 * Main handler
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    }

    const proxy = verifyAppProxyRequest(req);
    if (!proxy.valid) {
      console.warn("Invalid App Proxy request:", proxy.reason);
      return sendJson(res, 401, { ok: false, error: "Unauthorized." });
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