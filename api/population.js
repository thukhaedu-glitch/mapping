// POST /api/population  { orgId, lat, lng, radius }  →  { total, year }
// Proxy for WorldPop (https://www.worldpop.org/sdi/advancedapi/) when the browser can't call it directly.
import { handle, requireMember, HttpError } from "./_lib.js";

export default handle(async ({ orgId, lat, lng, radius }, req) => {
  if (![lat, lng, radius].every(Number.isFinite) || radius <= 0 || radius > 20000) throw new HttpError(400, "Bad location/radius.");
  await requireMember(req, orgId);
  const coords = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    coords.push([+(lng + (radius * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180))).toFixed(5), +(lat + (radius * Math.cos(a)) / 111320).toFixed(5)]);
  }
  const geojson = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } }] };
  const u = new URL("https://api.worldpop.org/v1/services/stats");
  u.search = new URLSearchParams({ dataset: "wpgppop", year: "2020", geojson: JSON.stringify(geojson), runasync: "false" });
  let j = await (await fetch(u)).json();
  for (let i = 0; j.status !== "finished" && j.taskid && i < 12; i++) {       // Vercel Hobby functions time out at ~60s
    await new Promise(r => setTimeout(r, 1500));
    j = await (await fetch(`https://api.worldpop.org/v1/tasks/${j.taskid}`)).json();
  }
  if (j.error || j.data?.total_population == null) throw new HttpError(502, "WorldPop returned no data.");
  return { total: j.data.total_population, year: 2020 };
});
