export default function handler(req, res) {
  res.status(200).json({
    success: true,
    message: "Shopify App Proxy is reaching Vercel.",
    method: req.method,
    query: req.query || {}
  });
}