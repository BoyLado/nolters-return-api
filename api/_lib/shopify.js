const API_VERSION = "2026-07";

/**
 * Configuration constants
 */
const TOKEN_CACHE_BUFFER_MS = 60 * 1000; // Refresh token 60s before expiry
const FETCH_TIMEOUT_MS = 15000;           // 15 second timeout
const MAX_RETRIES = 3;                    // Max retry attempts
const RETRY_BASE_DELAY_MS = 1000;         // Base delay for exponential backoff

/**
 * In-memory token cache
 *
 * Note: Sa Vercel serverless, ang bawat function instance ay
 * may sariling memory. Ang cache na ito ay valid lang sa
 * loob ng isang warm instance. Kung mag-cold start, kukuha
 * ulit ng bagong token — pero mas efficient pa rin kaysa
 * walang cache.
 */
let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  shop: null,
};

/**
 * In-flight token request promise
 *
 * Ito ay para sa concurrent request safety — kung may
 * dalawang requests na sabay na kailangan ng token,
 * hindi sila mag-doble ng fetch. Ang pangalawa ay
 * maghihintay sa pangalawang promise.
 */
let tokenPromise = null;

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
 *
 * Ang native fetch ay walang timeout, kaya pwedeng mag-hang
 * ang Vercel function kung ang Shopify ay slow. Ito ay
 * gumagamit ng AbortController para i-cancel ang request
 * pagkatapos ng specified timeout.
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
 *
 * Retries on:
 * - 429 (rate limit)
 * - 500, 502, 503, 504 (server errors)
 * - Network errors (fetch throws)
 *
 * Uses exponential backoff: 1s, 2s, 4s
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
 * Get Shopify Admin API access token using the
 * client credentials grant.
 *
 * Features:
 * - In-memory caching (valid until expiry)
 * - Concurrent request safety (avoids duplicate fetches)
 * - Auto-refresh 60s before expiry
 */
export async function getShopifyAccessToken() {
  const shop = getShopDomain();
  const now = Date.now();

  // Return cached token if valid
  if (
    tokenCache.accessToken &&
    tokenCache.shop === shop &&
    now < tokenCache.expiresAt
  ) {
    console.log("Using cached Shopify access token.");
    return tokenCache.accessToken;
  }

  // If a token fetch is already in progress, wait for it
  if (tokenPromise) {
    console.log("Waiting for in-flight token request...");
    return tokenPromise;
  }

  // Start a new token fetch
  tokenPromise = (async () => {
    try {
      const clientId = getEnv("SHOPIFY_CLIENT_ID");
      const clientSecret = getEnv("SHOPIFY_CLIENT_SECRET");
      const tokenUrl = `https://${shop}/admin/oauth/access_token`;

      console.log("Requesting new Shopify access token for:", shop);

      const response = await fetchWithRetry(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      const responseText = await response.text();

      if (!response.ok) {
        console.error("Shopify authentication failed:", {
          status: response.status,
          response: responseText,
        });
        throw new Error(
          `Unable to authenticate with Shopify. HTTP ${response.status}`
        );
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        console.error("Shopify returned invalid JSON:", responseText);
        throw new Error("Shopify returned an invalid authentication response.");
      }

      if (!data.access_token) {
        console.error(
          "Shopify authentication response did not contain an access token."
        );
        throw new Error("Shopify did not return an access token.");
      }

      // Cache the token
      const expiresIn = Number(data.expires_in) || 86399; // Default 24h
      tokenCache = {
        accessToken: data.access_token,
        expiresAt: now + expiresIn * 1000 - TOKEN_CACHE_BUFFER_MS,
        shop,
      };

      console.log(
        `Shopify access token obtained. Expires in ${expiresIn}s.`
      );

      return data.access_token;
    } finally {
      // Clear the in-flight promise regardless of success/failure
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

/**
 * Execute Shopify Admin GraphQL request.
 *
 * Features:
 * - Automatic token management (cached)
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

  /**
   * Log query cost (for monitoring query complexity).
   *
   * Ang Shopify ay may 1000-point limit per query.
   * Kung ang cost ay malapit na sa limit, kailangan
   * nating i-optimize ang query.
   */
  const cost = data?.extensions?.cost;
  if (cost) {
    const { requestedQueryCost, actualQueryCost, throttleStatus } = cost;
    console.log("Shopify GraphQL cost:", {
      requested: requestedQueryCost,
      actual: actualQueryCost,
      available: throttleStatus?.currentlyAvailable,
      restoreRate: throttleStatus?.restoreRate,
    });

    // Warn if we're using a lot of the budget
    if (actualQueryCost && actualQueryCost > 500) {
      console.warn(
        `High query cost detected: ${actualQueryCost}. ` +
        `Consider optimizing the GraphQL query.`
      );
    }
  }

  /**
   * GraphQL can return HTTP 200 while still
   * containing GraphQL errors.
   */
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    console.error("Shopify GraphQL errors:", data.errors);

    // Check for throttling errors specifically
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

/**
 * Clear the token cache (for testing or manual reset).
 */
export function clearTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0, shop: null };
  tokenPromise = null;
  console.log("Token cache cleared.");
}