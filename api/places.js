// POST /api/places  { orgId, query, bias? }  →  { places: [{placeId, name, address, lat, lng}] }
import { handle, requireMember, consume, HttpError } from "./_lib.js";

const QUOTA = { free: 30, pro: 500, business: 3000 };   // searches per workspace per month

export default handle(async ({ orgId, query, bias }, req) => {
  if (typeof query !== "string" || !query.trim() || query.length > 200) throw new HttpError(400, "Missing search text.");
  const { org } = await requireMember(req, orgId, ["owner", "admin", "editor"], { requireActive: true });
  const key = process.env.PLACES_API_KEY;
  if (!key) throw new HttpError(500, "Server not configured: PLACES_API_KEY env var is missing.");
  await consume(orgId, "placesSearches", QUOTA[org.plan] ?? QUOTA.free);

  const places = [];
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const body = { textQuery: query.trim(), pageSize: 20, regionCode: "MM" };
    if (pageToken) body.pageToken = pageToken;
    if (bias?.low && bias?.high) body.locationBias = { rectangle: { low: bias.low, high: bias.high } };
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,nextPageToken",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Places error", r.status, JSON.stringify(j));
      // Surface Google's reason (e.g. API not enabled, billing disabled, key restricted) — it tells the admin what to fix
      throw new HttpError(502, `Google Places: ${j.error?.message || r.status}`);
    }
    for (const p of j.places || []) {
      if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
      places.push({ placeId: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "", lat: p.location.latitude, lng: p.location.longitude });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  return { places };
});
