// api/reviews.js

// Kunin ang mga credentials mula sa Vercel Environment Variables
const JUDGEME_API_BASE = 'https://judge.me/api/v1';
const API_TOKEN = process.env.JUDGEME_PRIVATE_API_TOKEN;
const SHOP_DOMAIN = process.env.JUDGEME_SHOP_DOMAIN;

export default async function handler(req, res) {
  // 1. Siguraduhing GET lang ang tinatanggap
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Kunin ang mga query parameters mula sa client
  const { rating, per_page, page, product_id } = req.query;

  // 3. I-set up ang URL para sa Judge.me API
  const url = new URL(`${JUDGEME_API_BASE}/reviews`);

  // Required parameters
  url.searchParams.set('shop_domain', SHOP_DOMAIN);
  url.searchParams.set('api_token', API_TOKEN);

  // Optional parameters (kung ipinasa ng client)
  if (rating) url.searchParams.set('rating', rating);
  if (per_page) url.searchParams.set('per_page', per_page);
  if (page) url.searchParams.set('page', page);
  if (product_id) url.searchParams.set('product_id', product_id);

  try {
    // 4. Tawagin ang Judge.me API
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Api-Token': API_TOKEN, // Inirerekomenda ng Judge.me
      },
    });

    // 5. Kunin ang data at i-check ang status
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Judge.me API error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'Failed to fetch reviews from Judge.me',
        details: errorText,
      });
    }

    const data = await response.json();

    // 6. Ibalik ang data sa client
    // Magdagdag ng cache headers para hindi palaging tumawag sa API
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}