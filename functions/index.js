// Cloud Functions — Google Places search proxy with per-org monthly quota.
// The Places API key stays on the server; browsers never see it.
//   firebase functions:secrets:set PLACES_API_KEY
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const PLACES_API_KEY = defineSecret("PLACES_API_KEY");

// Searches per org per month, by plan. Each search = up to 3 Places requests (60 results).
const QUOTA = { free: 30, pro: 500, business: 3000 };

exports.placesSearch = onCall({ region: "asia-southeast1", secrets: [PLACES_API_KEY], maxInstances: 5 }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const { orgId, query, bias } = req.data || {};
  if (!orgId || typeof query !== "string" || !query.trim() || query.length > 200)
    throw new HttpsError("invalid-argument", "Missing search text.");

  const [member, org] = await Promise.all([
    db.doc(`orgs/${orgId}/members/${req.auth.uid}`).get(), db.doc(`orgs/${orgId}`).get(),
  ]);
  if (!member.exists || !["owner", "admin", "editor"].includes(member.data().role))
    throw new HttpsError("permission-denied", "You need editor access in this workspace.");

  const month = new Date().toISOString().slice(0, 7);
  const usageRef = db.doc(`orgs/${orgId}/usage/${month}`);
  const limit = QUOTA[org.data()?.plan] ?? QUOTA.free;
  await db.runTransaction(async t => {
    const used = (await t.get(usageRef)).data()?.placesSearches || 0;
    if (used >= limit) throw new HttpsError("resource-exhausted", `Monthly search limit reached (${limit}). Upgrade the plan or wait until next month.`);
    t.set(usageRef, { placesSearches: used + 1 }, { merge: true });
  });

  const places = [];
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const body = { textQuery: query.trim(), pageSize: 20, regionCode: "MM" };
    if (pageToken) body.pageToken = pageToken;
    if (bias?.low && bias?.high) body.locationBias = { rectangle: { low: bias.low, high: bias.high } };
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": PLACES_API_KEY.value(),
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,nextPageToken",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("Places error", res.status, await res.text());
      throw new HttpsError("internal", "Google Places request failed.");
    }
    const json = await res.json();
    for (const p of json.places || []) {
      if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
      places.push({ placeId: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "", lat: p.location.latitude, lng: p.location.longitude });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
    await new Promise(r => setTimeout(r, 1500)); // next page token needs a moment to become valid
  }
  return { places };
});
