// File: api/auth/callback.js

export default async function handler(req, res) {
  console.log("=== CALLBACK ENDPOINT HIT ===");
  console.log("Query params:", JSON.stringify(req.query));

  try {
    const { code, shop } = req.query;

    if (!code || !shop) {
      console.error("Missing code or shop parameter");
      return res.status(400).send("Missing code or shop parameter.");
    }

    // Validate shop domain format
    const shopDomain = String(shop).trim().toLowerCase();
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain)) {
      console.error("Invalid shop domain:", shopDomain);
      return res.status(400).send("Invalid shop domain.");
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    const expectedShop = (process.env.SHOPIFY_SHOP || "").replace(/\.myshopify\.com$/i, "");

    console.log("Client ID present:", !!clientId);
    console.log("Client Secret present:", !!clientSecret);
    console.log("Expected shop:", expectedShop);

    if (!clientId || !clientSecret) {
      console.error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET");
      return res.status(500).send("Server configuration error: missing credentials.");
    }

    // Verify shop matches expected shop
    if (expectedShop && !shopDomain.startsWith(expectedShop.toLowerCase())) {
      console.warn("Shop mismatch. Expected:", expectedShop, "Got:", shopDomain);
      // Don't block — just log a warning
    }

    const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;

    console.log("Exchanging code for token at:", tokenUrl);

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    });

    console.log("Shopify response status:", response.status);
    console.log("Shopify response content-type:", response.headers.get("content-type"));

    const responseText = await response.text();

    // Log first 500 chars of response for debugging
    console.log("Shopify response body (first 500 chars):", responseText.substring(0, 500));

    // Check if response is HTML (error page)
    if (responseText.trim().startsWith("<!DOCTYPE") || responseText.trim().startsWith("<html")) {
      console.error("Shopify returned HTML instead of JSON");
      console.error("This usually means:");
      console.error("  - The shop domain is invalid");
      console.error("  - The app is not installed on this store");
      console.error("  - The OAuth endpoint is incorrect");
      return res.status(500).send(
        "Shopify returned an HTML error page instead of JSON. " +
        "Check that the shop domain is correct and the app is installed."
      );
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse JSON:", e.message);
      return res.status(500).send("Invalid response from Shopify: " + responseText.substring(0, 200));
    }

    if (data.access_token) {
      console.log("===========================================");
      console.log("NEW OFFLINE TOKEN:", data.access_token);
      console.log("SCOPES:", data.scope);
      console.log("===========================================");

      res.redirect(302, "/pages/order-status?installed=1");
    } else {
      console.error("Token exchange failed:", data);
      res.status(500).send("Authentication failed: " + JSON.stringify(data));
    }
  } catch (error) {
    console.error("=== CALLBACK ERROR ===");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
}