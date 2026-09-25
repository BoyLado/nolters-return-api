export default async function handler(req, res) {
  const { code, shop } = req.query;

  if (!code || !shop) {
    return res.status(400).send("Missing code or shop parameter.");
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  const tokenUrl = `https://${shop}/admin/oauth/access_token`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
    }),
  });

  const data = await response.json();

  if (data.access_token) {
    // 🔐 MAHALAGA: Ito ang offline token. Kailangan itong i-save.
    console.log("===========================================");
    console.log("NEW OFFLINE TOKEN:", data.access_token);
    console.log("SCOPES:", data.scope);
    console.log("===========================================");

    // I-redirect ang user sa success page
    res.redirect("/pages/order-status?installed=1");
  } else {
    console.error("Token exchange failed:", data);
    res.status(500).send("Authentication failed.");
  }
}