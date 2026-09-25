// File: api/auth/callback.js

export default async function handler(req, res) {
  console.log("=== CALLBACK ENDPOINT HIT ===");
  console.log("Query params:", JSON.stringify(req.query));
  console.log("Method:", req.method);

  try {
    const { code, shop } = req.query;

    if (!code || !shop) {
      console.error("Missing code or shop parameter");
      return res.status(400).send("Missing code or shop parameter.");
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    console.log("Client ID present:", !!clientId);
    console.log("Client Secret present:", !!clientSecret);

    if (!clientId || !clientSecret) {
      console.error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET");
      return res.status(500).send("Server configuration error: missing credentials.");
    }

    const tokenUrl = `https://${shop}/admin/oauth/access_token`;

    console.log("Exchanging code for token at:", tokenUrl);

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    });

    console.log("Shopify response status:", response.status);

    const responseText = await response.text();
    console.log("Shopify response body:", responseText);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse JSON:", e.message);
      return res.status(500).send("Invalid response from Shopify: " + responseText);
    }

    if (data.access_token) {
      console.log("===========================================");
      console.log("NEW OFFLINE TOKEN:", data.access_token);
      console.log("SCOPES:", data.scope);
      console.log("===========================================");

      // I-redirect ang user sa success page
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