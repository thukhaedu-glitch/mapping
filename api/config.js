// GET /api/config — which server features are switched on (no secrets, just booleans).
export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ places: !!process.env.PLACES_API_KEY });
}
