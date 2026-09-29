// Excel / CSV import & export (SheetJS, loaded as global XLSX from CDN)

export const COLUMNS = [
  ["brand", "Brand"], ["name", "Store name"], ["lat", "Latitude"], ["lng", "Longitude"],
  ["mapsLink", "Google Maps link"], ["address", "Address"], ["township", "Township"], ["city", "City"],
  ["sizeSqft", "Size (sqft)"], ["seats", "Seats"], ["type", "Type"], ["status", "Status"], ["notes", "Notes"],
];

// header aliases (lower-cased, spaces/punctuation removed) → field
const ALIAS = {
  brand: ["brand", "brandname", "company", "chain", "ဘရန်း", "တံဆိပ်"],
  name: ["storename", "store", "name", "branch", "branchname", "outlet", "ဆိုင်", "ဆိုင်အမည်", "ဆိုင်နာမည်"],
  lat: ["lat", "latitude", "y"],
  lng: ["lng", "lon", "long", "longitude", "x"],
  mapsLink: ["googlemapslink", "mapslink", "maplink", "googlemaps", "link", "url", "location"],
  address: ["address", "လိပ်စာ"],
  township: ["township", "မြို့နယ်"],
  city: ["city", "မြို့", "region"],
  sizeSqft: ["sizesqft", "size", "sqft", "area", "areasqft", "floorarea", "အကျယ်"],
  seats: ["seats", "seating", "seat", "capacity", "ထိုင်ခုံ"],
  type: ["type", "format", "storetype"],
  status: ["status"],
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
  if (!map.brand) errors.push('No "Brand" column found — rows will be put under brand "Unknown".');

  const rows = [];
  raw.forEach((r, i) => {
    const get = f => (map[f] ? String(r[map[f]]).trim() : "");
    let lat = parseFloat(get("lat")), lng = parseFloat(get("lng"));
    if (!(isFinite(lat) && isFinite(lng))) {
      const c = coordsFromLink(get("mapsLink"));
      if (c) ({ lat, lng } = c);
    }
    const row = {
      brand: get("brand") || "Unknown", name: get("name") || "", lat, lng,
      address: get("address"), township: get("township"), city: get("city"),
      sizeSqft: parseFloat(get("sizeSqft")) || null, seats: parseInt(get("seats")) || null,
      type: get("type"), status: (get("status") || "verified").toLowerCase(), notes: get("notes"),
    };
    if (!row.name && !row.address) return; // blank line
    if (!(isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
      errors.push(`Row ${i + 2} (${row.name || row.address}): no valid Latitude/Longitude or Google Maps link — skipped.`);
      return;
    }
    rows.push(row);
  });
  return { rows, errors };
}

function download(wb, filename) { XLSX.writeFile(wb, filename, { compression: true }); }

export function exportStores(stores, brandsById) {
  const data = stores.map(s => ({
    Brand: brandsById[s.brandId]?.name || "", "Store name": s.name, Latitude: s.lat, Longitude: s.lng,
    Address: s.address || "", Township: s.township || "", City: s.city || "",
    "Size (sqft)": s.sizeSqft || "", Seats: s.seats || "", Type: s.type || "", Status: s.status || "",
    Source: s.source || "", Notes: s.notes || "",
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = [16, 28, 11, 11, 36, 16, 12, 10, 7, 12, 10, 10, 30].map(w => ({ wch: w }));
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
  const header = COLUMNS.map(c => c[1]);
  const example = ["Example Brand", "Example Branch (delete this row)", 16.8, 96.15, "", "Street, Ward", "Township", "Yangon", 1800, 60, "Dine-in", "verified", "Either Latitude+Longitude OR a Google Maps link is enough"];
  const ws = XLSX.utils.aoa_to_sheet([header, example]);
  ws["!cols"] = [16, 30, 11, 11, 40, 30, 16, 12, 10, 7, 12, 10, 40].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Stores");
  download(wb, "store-import-template.xlsx");
}
