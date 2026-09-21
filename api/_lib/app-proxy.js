import crypto from "node:crypto";

/**
 * Normalize a Shopify shop domain.
 */
function normalizeShop(value) {
  let shop = String(value || "").trim();

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/i, "");

  if (!shop) {
    throw new Error(
      "Invalid Shopify shop."
    );
  }

  return `${shop}.myshopify.com`;
}

/**
 * Verify a Shopify App Proxy request.
 *
 * Shopify adds query parameters such as:
 *
 *   shop
 *   timestamp
 *   signature
 *   path_prefix
 *   logged_in_customer_id
 *
 * The signature is calculated from the other
 * query parameters.
 */
export function verifyAppProxyRequest(
  request
) {
  const requestUrl =
    new URL(
      request.url,
      `https://${request.headers.host}`
    );

  const params =
    requestUrl.searchParams;

  const signature =
    params.get("signature");

  const shop =
    params.get("shop");

  const timestamp =
    params.get("timestamp");

  if (
    !signature ||
    !shop ||
    !timestamp
  ) {
    return {
      valid: false,
      reason:
        "Missing Shopify App Proxy authentication parameters.",
    };
  }

  /**
   * Validate timestamp.
   *
   * Five minutes is our replay window.
   */
  const timestampNumber =
    Number(timestamp);

  if (
    !Number.isFinite(timestampNumber)
  ) {
    return {
      valid: false,
      reason:
        "Invalid Shopify timestamp.",
    };
  }

  const now =
    Math.floor(Date.now() / 1000);

  const age =
    Math.abs(
      now - timestampNumber
    );

  if (age > 300) {
    return {
      valid: false,
      reason:
        "Shopify App Proxy request expired.",
    };
  }

  /**
   * Validate that the request belongs to
   * the Shopify store configured for this API.
   */
  let expectedShop;

  try {
    expectedShop =
      normalizeShop(
        process.env.SHOPIFY_SHOP
      );
  } catch {
    return {
      valid: false,
      reason:
        "Shopify shop configuration is invalid.",
    };
  }

  if (
    shop.toLowerCase() !==
    expectedShop.toLowerCase()
  ) {
    return {
      valid: false,
      reason:
        "Request came from an unexpected Shopify shop.",
    };
  }

  /**
   * Copy all query parameters.
   *
   * IMPORTANT:
   * We remove only "signature".
   *
   * Do not manually whitelist only the parameters
   * we currently know about because Shopify may add
   * additional parameters in the future.
   */
  const signatureParams =
    new URLSearchParams(
      requestUrl.search
    );

  signatureParams.delete(
    "signature"
  );

  /**
   * Shopify's calculation:
   *
   * 1. Group duplicate parameters.
   * 2. Join duplicate values with commas.
   * 3. Sort by parameter name.
   * 4. Concatenate key=value pairs without separators.
   */
  const grouped = {};

  for (
    const [key, value]
    of signatureParams.entries()
  ) {
    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(value);
  }

  const message =
    Object.keys(grouped)
      .sort()
      .map(
        (key) =>
          `${key}=${grouped[key].join(",")}`
      )
      .join("");

  const secret =
    process.env.SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    return {
      valid: false,
      reason:
        "SHOPIFY_CLIENT_SECRET is not configured.",
    };
  }

  const calculatedSignature =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(message)
      .digest("hex");

  /**
   * timingSafeEqual requires buffers of
   * identical length.
   */
  const providedBuffer =
    Buffer.from(
      signature,
      "utf8"
    );

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
      reason:
        "Invalid Shopify App Proxy signature.",
    };
  }

  const valid =
    crypto.timingSafeEqual(
      providedBuffer,
      calculatedBuffer
    );

  if (!valid) {
    return {
      valid: false,
      reason:
        "Invalid Shopify App Proxy signature.",
    };
  }

  return {
    valid: true,

    shop,

    /**
     * Shopify provides this when the
     * customer is logged in.
     *
     * For a guest:
     * null/empty.
     */
    loggedInCustomerId:
      params.get(
        "logged_in_customer_id"
      ) || null,

    pathPrefix:
      params.get(
        "path_prefix"
      ) || null,

    timestamp:
      timestampNumber,
  };
}