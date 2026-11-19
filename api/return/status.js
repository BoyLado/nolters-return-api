import { shopifyGraphQL } from "../_lib/shopify.js";
import { verifyAppProxyRequest } from "../_lib/app-proxy.js";
import { Resend } from "resend";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const RETURN_WINDOW_DAYS = 7;
const DAMAGE_REPORT_WINDOW_HOURS = 48;
const MAX_REQUEST_ITEMS = 100;
const MAX_BODY_BYTES = 64 * 1024;

const FINAL_SALE_TAGS = [
  "final-sale",
  "final sale",
  "no-return",
  "custom",
  "engraved",
  "personalized",
  "customized",
];

const FINAL_SALE_ATTR_KEYWORDS = [
  "engrav",
  "personali",
  "custom",
  "monogram",
];

const REASON_MAP = {
  "doesn't fit": "SIZE_TOO_SMALL",
  "doesn’t fit": "SIZE_TOO_SMALL",
  "not as described": "NOT_AS_DESCRIBED",
  "changed my mind": "UNWANTED",
  "damaged / defective": "DEFECTIVE",
  "wrong item received": "WRONG_ITEM",
  other: "OTHER",
};

/* ============================================================
   UTILITIES
   ============================================================ */

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOrderNumber(value) {
  const number = String(value || "").trim().replace(/\s+/g, "");
  return number && !number.startsWith("#") ? `#${number}` : number;
}

function isValidEmail(value) {
  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function escapeSearchValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeReason(value) {
  return String(value || "").trim().toLowerCase();
}

function isWithinWindow(deliveredAt, milliseconds, now = Date.now()) {
  if (!deliveredAt) return false;

  const timestamp = new Date(deliveredAt).getTime();
  if (!Number.isFinite(timestamp)) return false;

  const elapsed = now - timestamp;
  return elapsed >= 0 && elapsed <= milliseconds;
}

function isWithinReturnWindow(deliveredAt, now) {
  return isWithinWindow(
    deliveredAt,
    RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    now
  );
}

function isWithinDamageWindow(deliveredAt, now) {
  return isWithinWindow(
    deliveredAt,
    DAMAGE_REPORT_WINDOW_HOURS * 60 * 60 * 1000,
    now
  );
}

function isFinalSaleItem(item) {
  const tags = (item.product?.tags || []).map((tag) =>
    String(tag).toLowerCase()
  );

  const tagged = tags.some((tag) =>
    FINAL_SALE_TAGS.some((keyword) => tag.includes(keyword))
  );

  const customized = (item.customAttributes || []).some((attribute) => {
    const key = String(attribute.key || "").toLowerCase();
    const value = String(attribute.value || "").trim();

    return (
      value !== "" &&
      FINAL_SALE_ATTR_KEYWORDS.some((keyword) => key.includes(keyword))
    );
  });

  return tagged || customized;
}

function imageData(image) {
  return image
    ? { url: image.url, alt: image.altText || null }
    : null;
}

function sumQuantity(items) {
  return items.reduce((total, item) => total + item.availableQuantity, 0);
}

async function readBody(req) {
  let body = req.body;

  if (body === undefined || body === null) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;

      if (size > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        throw error;
      }

      chunks.push(buffer);
    }

    body = Buffer.concat(chunks).toString("utf8");
  }

  if (Buffer.isBuffer(body)) body = body.toString("utf8");

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }

    try {
      body = body ? JSON.parse(body) : {};
    } catch {
      const error = new Error("Invalid JSON request body.");
      error.statusCode = 400;
      throw error;
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Invalid request body.");
    error.statusCode = 400;
    throw error;
  }

  return body;
}

/* ============================================================
   GRAPHQL
   ============================================================ */

const FIND_ORDER_QUERY = `
  query FindOrder($query: String!) {
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
      }
    }
  }
`;

const ORDER_ITEMS_QUERY = `
  query OrderItems($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: 100, after: $after) {
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
          customAttributes {
            key
            value
          }
          product {
            tags
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const ORDER_RETURNS_QUERY = `
  query OrderReturns($id: ID!, $after: String) {
    order(id: $id) {
      returns(first: 50, after: $after) {
        nodes {
          id
          name
          status
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const RETURN_DETAILS_QUERY = `
  query ReturnDetails($id: ID!, $after: String) {
    return(id: $id) {
      returnLineItems(first: 100, after: $after) {
        nodes {
          id
          quantity
          returnReason
          customerNote
          ... on ReturnLineItem {
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
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const RETURNABLE_FULFILLMENTS_QUERY = `
  query ReturnableFulfillments($orderId: ID!, $after: String) {
    returnableFulfillments(
      orderId: $orderId
      first: 25
      after: $after
    ) {
      nodes {
        id
        fulfillment {
          id
          deliveredAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const RETURNABLE_ITEMS_QUERY = `
  query ReturnableItems($id: ID!, $after: String) {
    returnableFulfillment(id: $id) {
      returnableFulfillmentLineItems(first: 100, after: $after) {
        nodes {
          quantity
          fulfillmentLineItem {
            id
            lineItem {
              id
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const RETURN_REQUEST_MUTATION = `
  mutation ReturnRequest($input: ReturnRequestInput!) {
    returnRequest(input: $input) {
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

/* ============================================================
   PAGINATION AND DATA FETCHING
   ============================================================ */

async function collectPages(query, variables, getConnection) {
  const results = [];
  let after = null;

  while (true) {
    const data = await shopifyGraphQL(query, {
      ...variables,
      after,
    });

    const connection = getConnection(data);

    if (!connection) {
      throw new Error("Shopify returned an incomplete response.");
    }

    results.push(...(connection.nodes || []));

    if (!connection.pageInfo?.hasNextPage) break;

    const nextCursor = connection.pageInfo.endCursor;

    if (!nextCursor || nextCursor === after) {
      throw new Error("Invalid Shopify pagination cursor.");
    }

    after = nextCursor;
  }

  return results;
}

async function findOrder(orderNumber, email) {
  const data = await shopifyGraphQL(FIND_ORDER_QUERY, {
    query: `name:"${escapeSearchValue(orderNumber)}"`,
  });

  return (data?.orders?.nodes || []).find(
    (order) =>
      String(order.name || "").trim() === orderNumber &&
      normalizeEmail(order.email) === email
  ) || null;
}

async function fetchOrderItems(orderId) {
  return collectPages(
    ORDER_ITEMS_QUERY,
    { id: orderId },
    (data) => data?.order?.lineItems
  );
}

async function fetchExistingReturns(orderId) {
  const returns = await collectPages(
    ORDER_RETURNS_QUERY,
    { id: orderId },
    (data) => data?.order?.returns
  );

  const results = [];

  // Sequential fetching avoids a large burst of GraphQL requests.
  for (const existingReturn of returns) {
    const lines = await collectPages(
      RETURN_DETAILS_QUERY,
      { id: existingReturn.id },
      (data) => data?.return?.returnLineItems
    );

    results.push({
      ...existingReturn,
      items: lines.map((line) => {
        const item = line.fulfillmentLineItem?.lineItem;

        return {
          id: line.id,
          quantity: line.quantity,
          returnReason: line.returnReason,
          returnReasonNote: line.customerNote || "",
          title: item?.name || "Returned item",
          image: imageData(item?.image),
        };
      }),
    });
  }

  return results;
}

async function fetchReturnableItems(orderId) {
  const fulfillments = await collectPages(
    RETURNABLE_FULFILLMENTS_QUERY,
    { orderId },
    (data) => data?.returnableFulfillments
  );

  const results = [];

  for (const fulfillment of fulfillments) {
    const lines = await collectPages(
      RETURNABLE_ITEMS_QUERY,
      { id: fulfillment.id },
      (data) => data?.returnableFulfillment
        ?.returnableFulfillmentLineItems
    );

    for (const line of lines) {
      const fulfillmentLineItem = line.fulfillmentLineItem;
      const quantity = Number(line.quantity);

      if (
        !fulfillmentLineItem?.id ||
        !fulfillmentLineItem.lineItem?.id ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        continue;
      }

      results.push({
        fulfillmentLineItemId: fulfillmentLineItem.id,
        lineItemId: fulfillmentLineItem.lineItem.id,
        deliveredAt: fulfillment.fulfillment?.deliveredAt || null,
        availableQuantity: quantity,
      });
    }
  }

  return results;
}

/* ============================================================
   SHARED ELIGIBILITY
   Used by BOTH lookup and submission.
   ============================================================ */

function getItemEligibility(item, returnableItems, now) {
  const candidates = returnableItems.filter(
    (candidate) => candidate.lineItemId === item.id
  );

  const deliveredCandidates = candidates.filter((candidate) =>
    candidate.deliveredAt &&
    Number.isFinite(new Date(candidate.deliveredAt).getTime()) &&
    new Date(candidate.deliveredAt).getTime() <= now
  );

  const withinWindowCandidates = candidates.filter((candidate) =>
    isWithinReturnWindow(candidate.deliveredAt, now)
  );

  const eligibleCandidates = isFinalSaleItem(item)
    ? []
    : withinWindowCandidates;

  let ineligibilityReason = "";

  if (isFinalSaleItem(item)) {
    ineligibilityReason =
      "This item is final sale or personalized and cannot be returned.";
  } else if (!candidates.length) {
    ineligibilityReason =
      "No quantity is currently available for return. This item may be unfulfilled or already included in a return.";
  } else if (!deliveredCandidates.length) {
    ineligibilityReason =
      "Not eligible yet — this item has not been marked as delivered.";
  } else if (!withinWindowCandidates.length) {
    ineligibilityReason =
      `The ${RETURN_WINDOW_DAYS}-day return window has ended.`;
  }

  const deliveryDates = deliveredCandidates
    .map((candidate) => candidate.deliveredAt)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  return {
    eligible: eligibleCandidates.length > 0,
    ineligibilityReason,
    candidates: eligibleCandidates,
    availableQuantity: sumQuantity(eligibleCandidates),
    deliveredAt: deliveryDates[0] || null,
    finalSale: isFinalSaleItem(item),
    withinWindow: withinWindowCandidates.length > 0,
    withinDamageWindow: eligibleCandidates.some((candidate) =>
      isWithinDamageWindow(candidate.deliveredAt, now)
    ),
  };
}

/* ============================================================
   SERIALIZATION
   ============================================================ */

function serializeOrder(order, items, returnableItems, returns) {
  const now = Date.now();

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

    // Do not filter: all order line items remain visible.
    items: items.map((item) => {
      const eligibility = getItemEligibility(
        item,
        returnableItems,
        now
      );

      return {
        id: item.id,
        title: item.name,

        // Existing frontend uses quantity as the return stepper maximum.
        quantity: eligibility.eligible
          ? eligibility.availableQuantity
          : item.quantity,

        orderedQuantity: item.quantity,
        returnableQuantity: eligibility.availableQuantity,
        eligible: eligibility.eligible,
        ineligibilityReason: eligibility.ineligibilityReason,
        deliveredAt: eligibility.deliveredAt,
        withinWindow: eligibility.withinWindow,
        withinDamageWindow: eligibility.withinDamageWindow,
        finalSale: eligibility.finalSale,
        image: imageData(item.image),
        unitPrice: item.originalUnitPriceSet?.shopMoney
          ? {
              amount: item.originalUnitPriceSet.shopMoney.amount,
              currency: item.originalUnitPriceSet.shopMoney.currencyCode,
            }
          : null,
      };
    }),

    returns,
    hasExistingReturn: returns.length > 0,
  };
}

/* ============================================================
   RETURN CREATION AND APPROVAL
   ============================================================ */

async function createAndApproveReturn(orderId, returnLineItems) {
  const requestData = await shopifyGraphQL(
    RETURN_REQUEST_MUTATION,
    {
      input: {
        orderId,
        returnLineItems,
      },
    }
  );

  const payload = requestData?.returnRequest;
  const errors = payload?.userErrors || [];

  if (errors.length) {
    return { ok: false, errors };
  }

  const createdReturn = payload?.return;

  if (!createdReturn?.id) {
    throw new Error("Shopify did not return a return ID.");
  }

  // After creation succeeds, an approval failure must not tell
  // the customer to recreate the same return request.
  try {
    const approvalData = await shopifyGraphQL(
      RETURN_APPROVE_MUTATION,
      {
        input: {
          id: createdReturn.id,
          notifyCustomer: true,
        },
      }
    );

    const approval = approvalData?.returnApproveRequest;

    if (approval?.userErrors?.length || !approval?.return?.id) {
      console.error(
        "Return created but approval failed:",
        createdReturn.id,
        approval?.userErrors
      );

      return {
        ok: true,
        returnData: createdReturn,
        autoApproved: false,
      };
    }

    return {
      ok: true,
      returnData: approval.return,
      autoApproved: true,
    };
  } catch (error) {
    console.error(
      "Return created but approval request failed:",
      createdReturn.id,
      error
    );

    return {
      ok: true,
      returnData: createdReturn,
      autoApproved: false,
    };
  }
}

/* ============================================================
   MERCHANT NOTIFICATION
   ============================================================ */

async function sendMerchantNotification({
  order,
  returnData,
  items,
  autoApproved,
}) {
  const merchantEmail = process.env.MERCHANT_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  const storeName = process.env.STORE_NAME || "Store";
  const adminBase = (process.env.STORE_ADMIN_URL || "")
    .replace(/\/+$/, "");

  if (!merchantEmail || !fromEmail || !apiKey) {
    console.warn("Merchant notification skipped: missing configuration.");
    return;
  }

  const resend = new Resend(apiKey);
  const orderId = String(order.id).split("/").pop();
  const orderLink = adminBase
    ? `${adminBase}/orders/${orderId}`
    : "";

  const approvalLabel = autoApproved
    ? "Auto-approved"
    : "Awaiting review";

  const rows = items.map((item) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee;">
        ${escapeHtml(item.title)}
      </td>
      <td style="padding:10px;border-bottom:1px solid #eee;">
        ${escapeHtml(item.quantity)}
      </td>
      <td style="padding:10px;border-bottom:1px solid #eee;">
        ${escapeHtml(item.reason)}
      </td>
      <td style="padding:10px;border-bottom:1px solid #eee;">
        ${escapeHtml(item.note || "—")}
      </td>
    </tr>
  `).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px;color:#333;">
      <h2>New return request — ${escapeHtml(approvalLabel)}</h2>
      <p><strong>Store:</strong> ${escapeHtml(storeName)}</p>
      <p><strong>Order:</strong> ${escapeHtml(order.name)}</p>
      <p><strong>Return:</strong> ${escapeHtml(returnData.name)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.email)}</p>

      <table style="width:100%;border-collapse:collapse;text-align:left;">
        <thead>
          <tr>
            <th style="padding:10px;">Item</th>
            <th style="padding:10px;">Qty</th>
            <th style="padding:10px;">Reason</th>
            <th style="padding:10px;">Details</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <p>Return window: ${RETURN_WINDOW_DAYS} days from delivery.</p>
      <p>
        Damage reports: within ${DAMAGE_REPORT_WINDOW_HOURS}
        hours of delivery.
      </p>

      ${orderLink
        ? `<p><a href="${escapeHtml(orderLink)}">View order in Shopify Admin</a></p>`
        : ""}
    </div>
  `;

  const text = [
    `New return request — ${approvalLabel}`,
    `Order: ${order.name}`,
    `Return: ${returnData.name}`,
    `Customer: ${order.email}`,
    "",
    ...items.map(
      (item) =>
        `- ${item.title} (Qty ${item.quantity}) — ${item.reason}` +
        (item.note ? ` — ${item.note}` : "")
    ),
    "",
    orderLink,
  ].join("\n");

  const result = await resend.emails.send({
    from: `${storeName} <${fromEmail}>`,
    to: merchantEmail,
    replyTo: order.email || undefined,
    subject:
      `New return request (${approvalLabel}) — ` +
      `${order.name} (${returnData.name})`,
    html,
    text,
  });

  if (result?.error) {
    console.error("Merchant notification failed:", result.error);
  }
}

/* ============================================================
   LOOKUP
   ============================================================ */

async function handleLookup(res, orderNumber, email) {
  const order = await findOrder(orderNumber, email);

  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details.",
    });
  }

  // Fail closed if Shopify eligibility cannot be retrieved.
  const items = await fetchOrderItems(order.id);
  const returnableItems = await fetchReturnableItems(order.id);
  const returns = await fetchExistingReturns(order.id);

  return sendJson(res, 200, {
    ok: true,
    order: serializeOrder(order, items, returnableItems, returns),
  });
}

/* ============================================================
   SUBMISSION
   ============================================================ */

async function handleSubmit(res, body, orderNumber, email) {
  const requestedItems = Array.isArray(body.items) ? body.items : [];

  if (
    !requestedItems.length ||
    requestedItems.length > MAX_REQUEST_ITEMS
  ) {
    return sendJson(res, 400, {
      ok: false,
      error: `Select between 1 and ${MAX_REQUEST_ITEMS} items.`,
    });
  }

  const order = await findOrder(orderNumber, email);

  if (!order) {
    return sendJson(res, 404, {
      ok: false,
      error: "We couldn't find an order matching those details.",
    });
  }

  // Re-fetch current data. Never trust frontend eligibility.
  const orderItems = await fetchOrderItems(order.id);
  const returnableItems = await fetchReturnableItems(order.id);
  const itemsById = new Map(orderItems.map((item) => [item.id, item]));

  const seenIds = new Set();
  const returnLineItems = [];
  const enrichedItems = [];
  const now = Date.now();

  for (const requested of requestedItems) {
    if (!requested || typeof requested !== "object") {
      return sendJson(res, 400, {
        ok: false,
        error: "Invalid return item.",
      });
    }

    const itemId = String(requested.item_id || "");
    const item = itemsById.get(itemId);

    if (!item || seenIds.has(itemId)) {
      return sendJson(res, 400, {
        ok: false,
        error: "Invalid or duplicate return item.",
      });
    }

    seenIds.add(itemId);

    const reasonKey = normalizeReason(requested.reason);
    const returnReason = REASON_MAP[reasonKey];

    if (!Object.prototype.hasOwnProperty.call(REASON_MAP, reasonKey)) {
      return sendJson(res, 400, {
        ok: false,
        error: `Please select a valid return reason for "${item.name}".`,
      });
    }

    const quantity = Number(requested.quantity);

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return sendJson(res, 400, {
        ok: false,
        error: `Invalid quantity for "${item.name}".`,
      });
    }

    const eligibility = getItemEligibility(
      item,
      returnableItems,
      now
    );

    if (!eligibility.eligible) {
      return sendJson(res, 400, {
        ok: false,
        error: `"${item.name}": ${eligibility.ineligibilityReason}`,
      });
    }

    const isDamaged = returnReason === "DEFECTIVE";

    // For damaged items, allocate only quantities delivered
    // within the damage-report window.
    const candidates = eligibility.candidates
      .filter((candidate) =>
        !isDamaged ||
        isWithinDamageWindow(candidate.deliveredAt, now)
      )
      .sort(
        (a, b) =>
          new Date(a.deliveredAt).getTime() -
          new Date(b.deliveredAt).getTime()
      );

    const availableQuantity = sumQuantity(candidates);

    if (quantity > availableQuantity) {
      return sendJson(res, 400, {
        ok: false,
        error: isDamaged
          ? `"${item.name}": only ${availableQuantity} unit(s) qualify for a damage report within ${DAMAGE_REPORT_WINDOW_HOURS} hours of delivery.`
          : `"${item.name}": only ${availableQuantity} unit(s) are currently eligible for return.`,
      });
    }

    const note = String(requested.details || "").trim().slice(0, 300);
    let remaining = quantity;

    // One order line can span multiple fulfillment line items.
    for (const candidate of candidates) {
      if (remaining === 0) break;

      const allocatedQuantity = Math.min(
        remaining,
        candidate.availableQuantity
      );

      returnLineItems.push({
        fulfillmentLineItemId: candidate.fulfillmentLineItemId,
        quantity: allocatedQuantity,
        returnReason,
        customerNote: note,
      });

      remaining -= allocatedQuantity;
    }

    enrichedItems.push({
      item_id: item.id,
      title: item.name,
      quantity,
      reason: String(requested.reason).trim(),
      note,
    });
  }

  // Shopify input arrays accept at most 250 elements.
  if (returnLineItems.length > 250) {
    return sendJson(res, 400, {
      ok: false,
      error: "Too many fulfillment items. Please submit fewer items.",
    });
  }

  const result = await createAndApproveReturn(
    order.id,
    returnLineItems
  );

  if (!result.ok) {
    return sendJson(res, 400, {
      ok: false,
      error: result.errors?.[0]?.message || "Unable to create the return.",
    });
  }

  try {
    await sendMerchantNotification({
      order,
      returnData: result.returnData,
      items: enrichedItems,
      autoApproved: result.autoApproved,
    });
  } catch (error) {
    // Email failure must not invalidate an already-created return.
    console.error("Merchant notification error:", error);
  }

  return sendJson(res, 200, {
    ok: true,
    message: result.autoApproved
      ? "Return request submitted and approved. Check your email for return instructions."
      : "Return request submitted. Our team will review it shortly.",
    reference: result.returnData.name || orderNumber,
    returnId: result.returnData.id,
    autoApproved: result.autoApproved,
  });
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */

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
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized.",
      });
    }

    const body = await readBody(req);
    const intent = body.intent || "lookup";

    if (intent !== "lookup" && intent !== "submit") {
      return sendJson(res, 400, {
        ok: false,
        error: "Invalid intent.",
      });
    }

    const orderNumber = normalizeOrderNumber(
      body.orderNumber || body.order_number
    );
    const email = normalizeEmail(body.email);

    if (!orderNumber || orderNumber.length > 50) {
      return sendJson(res, 400, {
        ok: false,
        error: "Please enter a valid order number.",
      });
    }

    if (!isValidEmail(email)) {
      return sendJson(res, 400, {
        ok: false,
        error: "Please enter a valid email address.",
      });
    }

    if (intent === "submit") {
      return await handleSubmit(res, body, orderNumber, email);
    }

    return await handleLookup(res, orderNumber, email);
  } catch (error) {
    console.error("RETURN PORTAL ERROR:", error);

    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.statusCode
        ? error.message
        : "An unexpected server error occurred. Please try again.",
    });
  }
}