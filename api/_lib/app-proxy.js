import crypto from "node:crypto";

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

/**
 * Maximum age of a request (in seconds).
 * Requests older than this are rejected (replay protection).
 */
const MAX_REQUEST_AGE_SECONDS = 300; // 5 minutes

/**
 * Maximum clock skew tolerance (in seconds).
 * Allows for slight differences between server clocks.
 */
const MAX_FUTURE_DRIFT_SECONDS = 60; // 1 minute

/**
 * ============================================================
 * UTILITY FUNCTIONS
 * ============================================================
 */

/**
 * Normalize a Shopify shop domain.
 *
 * Accepts:
 *   "nolters"
 *   "nolters.myshopify.com"
 *   "https://nolters.myshopify.com"
 *   "https://nolters.myshopify.com/"
 *
 * Returns:
 *   "nolters.myshopify.com"
 */
function normalizeShop(value) {
  let shop = String(value || "").trim();

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/i, "");

  if (!shop) {
    throw new Error("Invalid Shopify shop.");
  }

  return `${shop}.myshopify.com`;
}

/**
 * Build a full URL object from a request.
 *
 * Handles:
 * - Absolute URLs (already full)
 * - Relative URLs (Vercel serverless)
 * - Missing host header (fallback)
 * - x-forwarded-host (Vercel custom domain)
 */
function buildRequestUrl(request) {
  // Case 1: request.url is already absolute
  if (request.url && /^https?:\/\//i.test(request.url)) {
    return new URL(request.url);
  }

  // Case 2: Build from headers
  const host =
    request.headers["x-forwarded-host"] ||
    request.headers.host ||
    "localhost";

  const protocol =
    request.headers["x-forwarded-proto"] ||
    (host.includes("localhost") ? "http" : "https");

  return new URL(request.url || "/", `${protocol}://${host}`);
}

/**
 * ============================================================
 * MAIN VERIFICATION
 * ============================================================
 */

/**
 * Verify a Shopify App Proxy request.
 *
 * Shopify adds query parameters such as:
 *   shop
 *   timestamp
 *   signature
 *   path_prefix
 *   logged_in_customer_id
 *
 * The signature is calculated from the other query parameters
 * using HMAC-SHA256 with the app's shared secret.
 *
 * @param {object} request - Vercel/Node request object
 * @returns {object} - { valid: boolean, reason?: string, ... }
 */
export function verifyAppProxyRequest(request) {
  let requestUrl;

  try {
    requestUrl = buildRequestUrl(request);
  } catch (err) {
    return {
      valid: false,
      reason: "Could not parse request URL.",
    };
  }

  const params = requestUrl.searchParams;

  const signature = params.get("signature");
  const shop = params.get("shop");
  const timestamp = params.get("timestamp");

  // Step 1: Check required parameters
  if (!signature || !shop || !timestamp) {
    return {
      valid: false,
      reason: "Missing Shopify App Proxy authentication parameters.",
    };
  }

  // Step 2: Validate timestamp format
  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return {
      valid: false,
      reason: "Invalid Shopify timestamp.",
    };
  }

  // Step 3: Validate timestamp freshness
  const now = Math.floor(Date.now() / 1000);
  const age = now - timestampNumber;

  // Reject future timestamps (beyond clock skew tolerance)
  if (age < -MAX_FUTURE_DRIFT_SECONDS) {
    return {
      valid: false,
      reason: "Shopify App Proxy request timestamp is in the future.",
    };
  }

  // Reject expired timestamps
  if (age > MAX_REQUEST_AGE_SECONDS) {
    return {
      valid: false,
      reason: "Shopify App Proxy request expired.",
    };
  }

  // Step 4: Validate shop domain matches our store
  let expectedShop;

  try {
    expectedShop = normalizeShop(process.env.SHOPIFY_SHOP);
  } catch {
    return {
      valid: false,
      reason: "Shopify shop configuration is invalid.",
    };
  }

  if (shop.toLowerCase() !== expectedShop.toLowerCase()) {
    return {
      valid: false,
      reason: "Request came from an unexpected Shopify shop.",
    };
  }

  // Step 5: Compute expected signature
  //
  // Shopify's calculation:
  //   1. Copy all query parameters except "signature"
  //   2. Group duplicate parameters
  //   3. Join duplicate values with commas
  //   4. Sort by parameter name
  //   5. Concatenate key=value pairs without separators
  //
  // IMPORTANT: We don't whitelist specific params because
  // Shopify may add new params in the future.
  const signatureParams = new URLSearchParams(requestUrl.search);
  signatureParams.delete("signature");

  const grouped = {};

  for (const [key, value] of signatureParams.entries()) {
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(value);
  }

  const message = Object.keys(grouped)
    .sort()
    .map((key) => `${key}=${grouped[key].join(",")}`)
    .join("");

  // Step 6: Get the shared secret
  //
  // Uses SHOPIFY_APP_PROXY_SECRET if set, otherwise falls
  // back to SHOPIFY_CLIENT_SECRET for backward compatibility.
  //
  // RECOMMENDED: Set SHOPIFY_APP_PROXY_SECRET explicitly
  // in Vercel env vars using the App Proxy secret from
  // the Shopify Partner Dashboard.
  const secret =
    process.env.SHOPIFY_APP_PROXY_SECRET ||
    process.env.SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    return {
      valid: false,
      reason:
        "Neither SHOPIFY_APP_PROXY_SECRET nor SHOPIFY_CLIENT_SECRET is configured.",
    };
  }

  const calculatedSignature = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  // Step 7: Compare signatures using timing-safe comparison
  const providedBuffer = Buffer.from(signature, "utf8");
  const calculatedBuffer = Buffer.from(calculatedSignature, "utf8");

  // timingSafeEqual requires buffers of identical length
  if (providedBuffer.length !== calculatedBuffer.length) {
    return {
      valid: false,
      reason: "Invalid Shopify App Proxy signature.",
    };
  }

  const valid = crypto.timingSafeEqual(providedBuffer, calculatedBuffer);

  if (!valid) {
    return {
      valid: false,
      reason: "Invalid Shopify App Proxy signature.",
    };
  }

  // Step 8: Success — return metadata
  return {
    valid: true,
    shop,
    loggedInCustomerId: params.get("logged_in_customer_id") || null,
    pathPrefix: params.get("path_prefix") || null,
    timestamp: timestampNumber,
  };
}