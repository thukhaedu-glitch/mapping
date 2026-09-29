// Spatial analysis — pure functions, no dependencies.

const R_EARTH = 6371008.8;
const rad = d => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export const fmtDist = m => (m < 1000 ? `${Math.round(m)} m` : m % 1000 === 0 ? `${m / 1000} km` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
export const fmtNum = n => (n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US"));

/**
 * For one store, everything else sorted by distance.
 * brandsById lets us split "own" vs "competitor".
 */
export function neighbours(store, stores, brandsById) {
  return stores
    .filter(s => s.id !== store.id && isFinite(s.lat) && isFinite(s.lng))
    .map(s => ({ store: s, d: distance(store, s), own: !!brandsById[s.brandId]?.isOwn }))
    .sort((a, b) => a.d - b.d);
}

export function radiusSummary(nbrs, radiusM) {
  const inside = nbrs.filter(n => n.d <= radiusM);
  const comp = inside.filter(n => !n.own);
  const byBrand = {};
  comp.forEach(n => (byBrand[n.store.brandId] = (byBrand[n.store.brandId] || 0) + 1));
  const compSizes = comp.map(n => +n.store.sizeSqft).filter(v => v > 0);
  return {
    competitors: comp.length,
    ownOthers: inside.length - comp.length,
    byBrand,
    competitorSqft: compSizes.reduce((a, b) => a + b, 0),
    competitorSizeKnown: compSizes.length,
  };
}

/* ---------------------------------------------------------- Population grid
 * public/data/pop_grid.json, built by tools/build_pop_grid.py:
 *   { source, year, cellDeg, points: [[lat, lng, pop], ...] }
 * Each point is the centre of a cell; we sum cells whose centre is within r.
 */
let popGrid = null, popIndex = null;

export async function loadPopGrid(url = "data/pop_grid.json") {
  try {
    const r = await fetch(url, { cache: "force-cache" });
    if (!r.ok) return null;
    popGrid = await r.json();
    // bucket by 0.05° tiles so a radius query only scans nearby cells
    popIndex = new Map();
    for (const p of popGrid.points) {
      const k = `${Math.floor(p[0] / 0.05)},${Math.floor(p[1] / 0.05)}`;
      if (!popIndex.has(k)) popIndex.set(k, []);
      popIndex.get(k).push(p);
    }
    return popGrid;
  } catch { return null; }
}
export const popGridInfo = () => popGrid && { source: popGrid.source, year: popGrid.year, cells: popGrid.points.length };

export function populationWithin(center, radiusM) {
  if (!popIndex) return null;
  const dLat = radiusM / 111320, dLng = radiusM / (111320 * Math.cos(rad(center.lat)));
  let sum = 0, covered = false;
  for (let i = Math.floor((center.lat - dLat) / 0.05); i <= Math.floor((center.lat + dLat) / 0.05); i++)
    for (let j = Math.floor((center.lng - dLng) / 0.05); j <= Math.floor((center.lng + dLng) / 0.05); j++) {
      const bucket = popIndex.get(`${i},${j}`);
      if (!bucket) continue;
      covered = true;
      for (const p of bucket) if (distance(center, { lat: p[0], lng: p[1] }) <= radiusM) sum += p[2];
    }
  return covered ? sum : null; // null = area not in the grid (don't claim zero people)
}

/* ------------------------------------------------ Area activity (OpenStreetMap)
 * Myanmar has no public small-area employment data, so we count places that
 * generate daytime foot traffic. OSM coverage in Myanmar is uneven — treat as
 * a relative signal between stores, not an absolute count.
 */
export const POI_GROUPS = [
  ["offices", "Offices", '["office"]'],
  ["education", "Schools / universities", '["amenity"~"^(school|college|university|kindergarten)$"]'],
  ["health", "Hospitals / clinics", '["amenity"~"^(hospital|clinic|doctors)$"]'],
  ["retail", "Malls / supermarkets / markets", '["shop"~"^(mall|supermarket|department_store)$"]'],
  ["market", "Markets", '["amenity"="marketplace"]'],
  ["food", "Restaurants / cafés / fast food", '["amenity"~"^(restaurant|fast_food|cafe|food_court)$"]'],
  ["banks", "Banks", '["amenity"="bank"]'],
];
const poiCache = new Map();

export async function poiCounts(center, radiusM) {
  const key = `${center.lat.toFixed(5)},${center.lng.toFixed(5)},${radiusM}`;
  if (poiCache.has(key)) return poiCache.get(key);
  const around = `(around:${Math.round(radiusM)},${center.lat},${center.lng})`;
  const q = "[out:json][timeout:25];" + POI_GROUPS.map(([, , f]) => `nwr${around}${f};out count;`).join("");
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`OpenStreetMap (Overpass) error ${res.status} — ခဏနေ ပြန်စမ်းပါ`);
  const json = await res.json();
  const counts = {};
  json.elements.filter(e => e.type === "count").forEach((e, i) => (counts[POI_GROUPS[i][0]] = +e.tags.total));
  poiCache.set(key, counts);
  return counts;
}

/* ---------------------------------------------- Brand matching for search results */
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9က-႟]+/g, " ").trim();

/** Returns brandId whose name/aliases appear in the place name, or null. */
export function matchBrand(placeName, brands) {
  const n = " " + norm(placeName) + " ";
  let best = null, bestLen = 0;
  for (const b of brands) {
    for (const term of [b.name, ...(b.aliases || [])]) {
      const t = norm(term);
      if (t && n.includes(" " + t + " ") && t.length > bestLen) { best = b.id; bestLen = t.length; }
    }
  }
  return best;
}

/* ------------------------------------------------ WorldPop API (automatic population)
 * Total residents inside a circle, from WorldPop's 100 m gridded estimates (2020, latest in the API).
 * https://www.worldpop.org/sdi/advancedapi/  — free, no key. Results are cached on the store doc.
 */
export const WORLDPOP_YEAR = 2020;

export function circleGeoJSON(c, radiusM, steps = 48) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(a)) / 111320, dLng = (radiusM * Math.sin(a)) / (111320 * Math.cos(rad(c.lat)));
    coords.push([+(c.lng + dLng).toFixed(5), +(c.lat + dLat).toFixed(5)]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } }] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Direct browser call. Throws TypeError if the browser blocks it (CORS) — caller falls back to the Cloud Function. */
export async function worldpopDirect(center, radiusM) {
  const u = new URL("https://api.worldpop.org/v1/services/stats");
  u.search = new URLSearchParams({ dataset: "wpgppop", year: String(WORLDPOP_YEAR), geojson: JSON.stringify(circleGeoJSON(center, radiusM)), runasync: "false" });
  let j = await (await fetch(u)).json();
  for (let i = 0; j.status !== "finished" && j.taskid && i < 20; i++) {       // async fallback: poll the task
    await sleep(1500);
    j = await (await fetch(`https://api.worldpop.org/v1/tasks/${j.taskid}`)).json();
  }
  if (j.error || j.data?.total_population == null) throw new Error(j.error_message || "WorldPop returned no data for this area.");
  return j.data.total_population;
}

/* ------------------------------------------------ Road distance (OSRM, OpenStreetMap roads)
 * Public demo server: fine for occasional clicks, not for bulk. Times are free-flow (no traffic).
 */
export async function roadRoute(a, b) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  if (!r.ok) throw new Error("Routing service unavailable");
  const j = await r.json();
  const rt = j.routes?.[0];
  if (!rt) throw new Error("No road route found");
  return { meters: rt.distance, seconds: rt.duration, path: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]) };
}
export const fmtDur = s => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
