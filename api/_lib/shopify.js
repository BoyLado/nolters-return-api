async function getShopifyAccessToken() {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop) {
    throw new Error(
      "Missing SHOPIFY_SHOP environment variable."
    );
  }

  if (!clientId) {
    throw new Error(
      "Missing SHOPIFY_CLIENT_ID environment variable."
    );
  }

  if (!clientSecret) {
    throw new Error(
      "Missing SHOPIFY_CLIENT_SECRET environment variable."
    );
  }

  const shopDomain = `${shop}.myshopify.com`;

  const tokenUrl =
    `https://${shopDomain}/admin/oauth/access_token`;

  console.log(
    "Requesting Shopify access token for:",
    shopDomain
  );

  const response = await fetch(tokenUrl, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },

    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      "Shopify authentication failed:",
      {
        status: response.status,
        response: responseText
      }
    );

    throw new Error(
      `Unable to authenticate with Shopify. HTTP ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error(
      "Shopify returned invalid JSON:",
      responseText
    );

    throw new Error(
      "Shopify returned an invalid authentication response."
    );
  }

  if (!data.access_token) {
    console.error(
      "Shopify authentication response did not contain an access token:",
      {
        scope: data.scope,
        expires_in: data.expires_in,
        error: data.error
      }
    );

    throw new Error(
      "Shopify did not return an access token."
    );
  }

  console.log(
    "Shopify access token obtained successfully."
  );

  return data.access_token;
}