export default function handler(req, res) {
  res.status(200).json({
    success: true,
    service: "Nolters Orders & Returns API",
    version: "1.0.0",
    message: "API is running."
  });
}