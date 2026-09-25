// File: api/_lib/shopify.js

const API_VERSION = "2026-07";

/**
 * Configuration constants
 */
const FETCH_TIMEOUT_MS = 15000;           // 15 second timeout
const MAX_RETRIES = 3;                    // Max retry attempts
const RETRY_BASE_DELAY_MS = 1000;         // Base delay for exponential backoff

/**
 * Get required environment variable.
 */
function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value.trim();
}

/**
 * Get Shopify shop domain.
 *
 * Supported:
 * SHOPIFY_SHOP=nolters
 * SHOPIFY_SHOP=nolters.myshopify.com
 * SHOPIFY_SHOP=https://nolters.myshopify.com
 */
function getShopDomain() {
  let shop = getEnv("SHOPIFY_SHOP");

  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  if (!shop.includes(".")) {
    shop = `${shop}.myshopify.com`;
  }

  return shop;
}

/**
 * Fetch with timeout support.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch with retry logic.
 */
async function fetchWithRetry(url, options = {}, maxRetries = MAX_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);

      // Success — return immediately
      if (response.ok) {
        return response;
      }

      // Retryable status codes
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (retryableStatuses.includes(response.status) && attempt < maxRetries - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `Shopify request failed with HTTP ${response.status}. ` +
          `Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error — return response for caller to handle
      return response;
    } catch (error) {
      lastError = error;

      // Retry on network errors
      if (attempt < maxRetries - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `Network error: ${error.message}. ` +
          `Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError || new Error("Max retries exceeded.");
}

/**
 * Get Shopify Admin API access token.
 *
 * For your single-store setup, this is the offline token
 * you obtained via OAuth and stored in Vercel as
 * SHOPIFY_ADMIN_ACCESS_TOKEN.
 */
export async function getShopifyAccessToken() {
  const token = getEnv("SHOPIFY_ADMIN_ACCESS_TOKEN");
  return token;
}

/**
 * Execute Shopify Admin GraphQL request.
 *
 * Features:
 * - Uses static offline token from env
 * - Retry on transient errors
 * - Timeout protection
 * - Query cost logging
 * - Comprehensive error handling
 */
export async function shopifyGraphQL(query, variables = {}) {
  const shop = getShopDomain();
  const accessToken = await getShopifyAccessToken();
  const graphqlUrl = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetchWithRetry(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Shopify GraphQL HTTP error:", {
      status: response.status,
      response: responseText,
    });
    throw new Error(
      `Shopify GraphQL request failed. HTTP ${response.status}`
    );
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    console.error("Shopify GraphQL returned invalid JSON:", responseText);
    throw new Error("Shopify GraphQL returned invalid JSON.");
  }

  // Query cost logging
  const cost = data?.extensions?.cost;
  if (cost) {
    const { requestedQueryCost, actualQueryCost, throttleStatus } = cost;
    console.log("Shopify GraphQL cost:", {
      requested: requestedQueryCost,
      actual: actualQueryCost,
      available: throttleStatus?.currentlyAvailable,
      restoreRate: throttleStatus?.restoreRate,
    });

    if (actualQueryCost && actualQueryCost > 500) {
      console.warn(
        `High query cost detected: ${actualQueryCost}. ` +
        `Consider optimizing the GraphQL query.`
      );
    }
  }

  // GraphQL-level errors (HTTP 200 but errors present)
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    console.error("Shopify GraphQL errors:", data.errors);

    const isThrottled = data.errors.some((err) =>
      String(err.message || "").toLowerCase().includes("throttl")
    );

    if (isThrottled) {
      throw new Error(
        "Shopify API rate limit exceeded. Please try again later."
      );
    }

    throw new Error(
      data.errors
        .map((error) => error.message || "Unknown Shopify GraphQL error.")
        .join("; ")
    );
  }

  return data.data;
}