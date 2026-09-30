// Excel / CSV import & export (SheetJS, loaded as global XLSX from CDN)
import { divisionOf } from "./myanmar.js";

export const COLUMNS = [
  ["brand", "Brand"], ["name", "Store name"], ["lat", "Latitude"], ["lng", "Longitude"],
  ["mapsLink", "Google Maps link"], ["address", "Address"], ["township", "Township / Area"], ["city", "City"], ["division", "Division"],
  ["phone", "Phone"], ["rating", "Google rating"], ["ratingCount", "Rating count"], ["placeId", "Google place ID"],
  ["sizeSqft", "Size (sqft)"], ["seats", "Seats"], ["type", "Type"], ["status", "Status"], ["closedAt", "Closed date"], ["closedReason", "Closed reason"], ["notes", "Notes"],
];

// header aliases (lower-cased, spaces/punctuation removed) → field
const ALIAS = {
  brand: ["brand", "brandname", "company", "chain", "ဘရန်း", "တံဆိပ်"],
  name: ["storename", "store", "name", "branch", "branchname", "outlet", "ဆိုင်", "ဆိုင်အမည်", "ဆိုင်နာမည်"],
  lat: ["lat", "latitude", "y"],
  lng: ["lng", "lon", "long", "longitude", "x"],
  mapsLink: ["googlemapslink", "mapslink", "maplink", "googlemaps", "link", "url", "location"],
  address: ["address", "လိပ်စာ"],
  township: ["township", "townshiparea", "area", "district", "ward", "quarter", "neighbourhood", "neighborhood", "မြို့နယ်", "ရပ်ကွက်"],
  city: ["city", "မြို့", "town"],
  division: ["division", "region", "state", "stateregion", "divisionstate", "တိုင်း", "ပြည်နယ်", "တိုင်းဒေသကြီး"],
  sizeSqft: ["sizesqft", "size", "sqft", "areasqft", "floorarea", "floorareasqft", "အကျယ်"],
  phone: ["phone", "phonenumber", "tel", "telephone", "mobile", "contact", "ဖုန်း"],
  rating: ["googlerating", "rating", "stars", "avgrating", "averagerating"],
  ratingCount: ["ratingcount", "ratingscount", "reviews", "reviewcount", "reviewscount", "userratingcount", "userratingstotal", "googlereviews", "numreviews", "totalreviews"],
  placeId: ["googleplaceid", "placeid", "gplaceid"],
  seats: ["seats", "seating", "seat", "capacity", "ထိုင်ခုံ"],
  type: ["type", "format", "storetype"],
  status: ["status"],
  closedAt: ["closeddate", "closedon", "closedat", "dateclosed", "closingdate", "ပိတ်သည့်ရက်"],
  closedReason: ["closedreason", "closurereason", "reasonclosed", "whyclosed", "ပိတ်ရသည့်အကြောင်း"],
  notes: ["notes", "note", "remark", "remarks", "မှတ်ချက်"],
};
const key = s => String(s || "").toLowerCase().replace(/[\s_\-()./]+/g, "");
const fieldFor = header => Object.keys(ALIAS).find(f => ALIAS[f].includes(key(header)));

/** Pull lat/lng out of the common Google Maps URL shapes. */
export function coordsFromLink(link) {
  const s = String(link || "");
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/];
  for (const p of pats) { const m = s.match(p); if (m) return { lat: +m[1], lng: +m[2] }; }
  return null;
}

/**
 * Parse a workbook into rows the app can save.
 * Returns { rows: [{brand, name, lat, lng, ...}], errors: ["Row 5: ..."] }
 */
export async function parseFile(file) {
  const wb = XLSX.read(await file.arrayBuffer());
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!raw.length) return { rows: [], errors: ["The first sheet is empty."] };

  const map = {};
  Object.keys(raw[0]).forEach(h => { const f = fieldFor(h); if (f && !map[f]) map[f] = h; });
  const errors = [];

  const rows = [];
  raw.forEach((r, i) => {
    const get = f => (map[f] ? String(r[map[f]]).trim() : "");
    let lat = parseFloat(get("lat")), lng = parseFloat(get("lng"));
    if (!(isFinite(lat) && isFinite(lng))) {
      const c = coordsFromLink(get("mapsLink"));
      if (c) ({ lat, lng } = c);
    }
    const row = {
      brand: get("brand"), name: get("name") || "", lat, lng,
      phone: get("phone"), placeId: get("placeId"),
      rating: (v => (isFinite(v) && v > 0 && v <= 5 ? Math.round(v * 10) / 10 : null))(parseFloat(get("rating"))),
      ratingCount: (v => (isFinite(v) && v >= 0 ? v : null))(parseInt(get("ratingCount").replace(/[^0-9]/g, ""))),
      address: get("address"), township: get("township"), city: get("city"), division: get("division"),
      sizeSqft: parseFloat(get("sizeSqft")) || null, seats: parseInt(get("seats")) || null,
      type: get("type"), status: (get("status") || "verified").toLowerCase(), notes: get("notes"),
      closedAt: (v => { if (!v) return ""; if (/^\d{4,5}(\.\d+)?$/.test(v)) { const d = new Date(Math.round((+v - 25569) * 864e5)); return d.toISOString().slice(0, 10); } return v.slice(0, 10); })(get("closedAt")),
      closedReason: get("closedReason"),
    };
    if (!row.name && !row.address) return; // blank line
    if (row.closedAt && row.status !== "closed") row.status = "closed";
    if (!["verified", "pending", "closed"].includes(row.status)) row.status = /close|shut|ပိတ်/.test(row.status) ? "closed" : /open|active|verified/.test(row.status) ? "verified" : "pending";
    if (!(isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
      errors.push(`Row ${i + 2} (${row.name || row.address}): no valid Latitude/Longitude or Google Maps link — skipped.`);
      return;
    }
    rows.push(row);
  });
  return { rows, errors, hasBrand: !!map.brand, columns: Object.keys(map) };
}

function download(wb, filename) { XLSX.writeFile(wb, filename, { compression: true }); }

export function exportStores(stores, brandsById) {
  const data = stores.map(s => ({
    Brand: brandsById[s.brandId]?.name || "", "Store name": s.name, Latitude: s.lat, Longitude: s.lng,
    Address: s.address || "", Township: s.township || "", City: s.city || "", Division: divisionOf(s),
    Phone: s.phone || "", "Google rating": s.rating ?? "", "Rating count": s.ratingCount ?? "", "Google place ID": s.placeId || "",
    "Size (sqft)": s.sizeSqft || "", Seats: s.seats || "", Type: s.type || "", Status: s.status || "", "Closed date": s.closedAt || "", "Closed reason": s.closedReason || "",
    Source: s.source || "", Notes: s.notes || "",
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = [16, 28, 11, 11, 36, 16, 12, 16, 14, 8, 10, 24, 10, 7, 12, 10, 12, 24, 10, 30].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, "Stores");
  download(wb, `stores-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function exportAnalysis(rows, radiusKm) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.max(12, k.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, `Analysis ${radiusKm}km`);
  download(wb, `competitor-analysis-${radiusKm}km-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function downloadTemplate() {
  // Formatted template (required columns in red, dropdowns, "How to fill" sheet) — public/templates/
  const a = Object.assign(document.createElement("a"), { href: "templates/storeradar-import-template.xlsx", download: "storeradar-import-template.xlsx" });
  document.body.appendChild(a); a.click(); a.remove();
}
