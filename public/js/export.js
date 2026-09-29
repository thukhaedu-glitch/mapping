// High-resolution map export (JPG / PDF).
// Redraws the current view on a canvas at higher zoom (fresh tiles, not a screenshot),
// then adds pins, the radius circle, a legend and attribution. Text is drawn with the
// page's own fonts, so Burmese store names render correctly in both JPG and PDF.

const TILE_URL = (z, x, y) => `https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;
const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const FONT = '"Inter", "Noto Sans Myanmar", system-ui, sans-serif';

function loadImg(src) {
  return new Promise(res => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/**
 * opts: { map, stores, brandsById, selected, radius, title, subtitle, selectedLine, longSide, onProgress }
 * Returns a canvas.
 */
export async function renderMapCanvas(opts) {
  const { map, stores, brandsById, selected, radius, longSide = 3000, onProgress = () => {} } = opts;
  const view = map.getSize();
  const s = longSide / Math.max(view.x, view.y);           // output px per screen px
  const W = Math.round(view.x * s), H = Math.round(view.y * s);
  const z2 = map.getZoom() + Math.log2(s);                 // fractional zoom of the output
  const tz = Math.min(19, Math.max(0, Math.round(z2)));    // tile zoom actually fetched
  const k = Math.pow(2, z2 - tz), ts = 256 * k;            // drawn tile size in output px
  const origin = map.project(map.getBounds().getNorthWest(), z2);

  // legend band height depends on number of brands
  const brandIds = [...new Set(stores.map(x => x.brandId))];
  const u = longSide / 1500;                               // layout unit
  const legendLabel = b => `${b.name}${b.isOwn && !/\bours\b/i.test(b.name) ? " (ours)" : ""}  ·  ${stores.filter(st => st.brandId === b.id).length}`;
  const mg = document.createElement("canvas").getContext("2d");
  mg.font = `500 ${17 * u}px ${FONT}`;
  const colW = Math.max(220 * u, ...brandIds.map(id => brandsById[id]).filter(Boolean).map(b => mg.measureText(legendLabel(b)).width + 60 * u));
  const perRow = Math.max(1, Math.floor((W - 80 * u) / colW));
  const legendRows = Math.ceil(brandIds.length / perRow) || 1;
  const headerH = Math.round(110 * u);
  const footerH = Math.round((40 + legendRows * 34 + (opts.selectedLine ? 34 : 0) + 30) * u);

  // preload brand logos (data URLs — no cross-origin issues)
  const logos = {};
  await Promise.all(brandIds.map(async id => { const b = brandsById[id]; if (b?.logo) logos[id] = await loadImg(b.logo); }));
  const useLogos = opts.showLogos !== false;

  const c = document.createElement("canvas");
  c.width = W; c.height = H + headerH + footerH;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);

  // --- tiles
  g.save(); g.translate(0, headerH);
  g.beginPath(); g.rect(0, 0, W, H); g.clip();
  g.fillStyle = "#eef0f3"; g.fillRect(0, 0, W, H);
  const n = Math.pow(2, tz), jobs = [];
  for (let x = Math.floor(origin.x / ts); x <= Math.floor((origin.x + W) / ts); x++)
    for (let y = Math.max(0, Math.floor(origin.y / ts)); y <= Math.min(n - 1, Math.floor((origin.y + H) / ts)); y++)
      jobs.push([x, y]);
  let done = 0, failed = 0;
  await pool(jobs, 12, async ([x, y]) => {
    const im = await loadImg(TILE_URL(tz, ((x % n) + n) % n, y));
    if (im) g.drawImage(im, Math.round(x * ts - origin.x), Math.round(y * ts - origin.y), Math.ceil(ts) + 1, Math.ceil(ts) + 1);
    else failed++;
    onProgress(++done / jobs.length);
  });

  const px = ll => { const p = map.project(ll, z2); return [p.x - origin.x, p.y - origin.y]; };

  // --- radius circle
  if (selected) {
    const [cx, cy] = px([selected.lat, selected.lng]);
    const [, ey] = px([selected.lat + radius / 111320, selected.lng]);
    const r = Math.abs(cy - ey);
    const col = brandsById[selected.brandId]?.color || "#e11d48";
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = col + "18"; g.fill();
    g.setLineDash([8 * u, 6 * u]); g.lineWidth = 2.5 * u; g.strokeStyle = col; g.stroke(); g.setLineDash([]);
  }

  // --- pins (competitors first, own brand on top)
  const sorted = [...stores].sort((a, b) => (brandsById[a.brandId]?.isOwn ? 1 : 0) - (brandsById[b.brandId]?.isOwn ? 1 : 0));
  for (const st of sorted) {
    const [x, y] = px([st.lat, st.lng]);
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const b = brandsById[st.brandId] || {};
    const logo = useLogos && logos[st.brandId];
    if (logo) {                                   // logo badge: white disc/rounded square, brand-colour ring
      const r = (b.isOwn ? 20 : 16) * u;
      const shape = () => { g.beginPath(); b.isOwn ? g.roundRect(x - r, y - r, 2 * r, 2 * r, 5 * u) : g.arc(x, y, r, 0, Math.PI * 2); };
      g.save(); g.shadowColor = "rgba(0,0,0,.4)"; g.shadowBlur = 5 * u; g.shadowOffsetY = 1.5 * u;
      shape(); g.fillStyle = "#fff"; g.fill(); g.restore();
      g.save(); shape(); g.clip();
      const pad = 4 * u, s2 = 2 * (r - pad);
      g.drawImage(logo, x - s2 / 2, y - s2 / 2, s2, s2); g.restore();
      shape(); g.lineWidth = 3 * u; g.strokeStyle = b.color || "#888";
      if (st.status === "pending") g.setLineDash([4 * u, 3 * u]);
      g.stroke(); g.setLineDash([]);
      if (selected && st.id === selected.id) { g.beginPath(); g.arc(x, y, r * 1.45 + 4 * u, 0, Math.PI * 2); g.lineWidth = 3 * u; g.strokeStyle = "#e11d48"; g.stroke(); }
      continue;
    }
    const r = (b.isOwn ? 11 : 8.5) * u;
    g.save(); g.translate(x, y);
    g.shadowColor = "rgba(0,0,0,.4)"; g.shadowBlur = 4 * u; g.shadowOffsetY = 1.5 * u;
    g.beginPath();
    if (b.isOwn) { g.rotate(Math.PI / 4); g.roundRect(-r, -r, 2 * r, 2 * r, 3 * u); } else g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = b.color || "#888"; g.fill();
    g.shadowColor = "transparent"; g.lineWidth = 2.5 * u; g.strokeStyle = "#fff";
    if (st.status === "pending") g.setLineDash([3 * u, 3 * u]);
    g.stroke(); g.restore();
    if (selected && st.id === selected.id) { g.beginPath(); g.arc(x, y, r + 7 * u, 0, Math.PI * 2); g.lineWidth = 3 * u; g.strokeStyle = "#e11d48"; g.stroke(); }
  }
  // selected store label
  if (selected) {
    const [x, y] = px([selected.lat, selected.lng]);
    g.font = `600 ${16 * u}px ${FONT}`;
    const t = selected.name || "", tw = g.measureText(t).width;
    g.fillStyle = "rgba(255,255,255,.92)"; g.beginPath(); g.roundRect(x - tw / 2 - 8 * u, y - 46 * u, tw + 16 * u, 26 * u, 6 * u); g.fill();
    g.fillStyle = "#15181d"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, x, y - 33 * u);
  }
  g.restore();

  // --- header
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  g.fillStyle = "#15181d"; g.font = `700 ${34 * u}px ${FONT}`; g.fillText(opts.title, 40 * u, 55 * u);
  g.fillStyle = "#6b7280"; g.font = `400 ${18 * u}px ${FONT}`; g.fillText(opts.subtitle, 40 * u, 88 * u);
  g.fillStyle = "#e11d48"; g.fillRect(0, headerH - 4 * u, W, 4 * u);

  // --- legend
  let y0 = headerH + H + 40 * u;
  g.font = `500 ${17 * u}px ${FONT}`; g.textBaseline = "middle";
  brandIds.map(id => brandsById[id]).filter(Boolean)
    .sort((a, b) => (b.isOwn - a.isOwn) || a.name.localeCompare(b.name))
    .forEach((b, i) => {
      const x = 40 * u + (i % perRow) * colW, y = y0 + Math.floor(i / perRow) * 34 * u;
      if (logos[b.id]) {
        g.save(); g.beginPath(); g.arc(x + 10 * u, y, 13 * u, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill(); g.clip();
        g.drawImage(logos[b.id], x - 1 * u, y - 11 * u, 22 * u, 22 * u); g.restore();
        g.beginPath(); g.arc(x + 10 * u, y, 13 * u, 0, Math.PI * 2); g.lineWidth = 2 * u; g.strokeStyle = b.color; g.stroke();
        g.fillStyle = "#15181d"; g.fillText(legendLabel(b), x + 32 * u, y);
        return;
      }
      g.beginPath();
      if (b.isOwn) { g.save(); g.translate(x + 8 * u, y); g.rotate(Math.PI / 4); g.rect(-7 * u, -7 * u, 14 * u, 14 * u); g.restore(); }
      else g.arc(x + 8 * u, y, 7.5 * u, 0, Math.PI * 2);
      g.fillStyle = b.color; g.fill();
      g.fillStyle = "#15181d"; g.fillText(legendLabel(b), x + 24 * u, y);
    });
  y0 += legendRows * 34 * u;
  if (opts.selectedLine) { g.font = `600 ${17 * u}px ${FONT}`; g.fillStyle = "#15181d"; g.fillText(opts.selectedLine, 40 * u, y0 + 4 * u); y0 += 34 * u; }
  g.font = `400 ${13 * u}px ${FONT}`; g.fillStyle = "#6b7280";
  g.fillText("Map data © OpenStreetMap contributors · © CARTO · Generated with StoreRadar" + (failed ? `  ·  ${failed} map tiles failed to load` : ""), 40 * u, c.height - 22 * u);

  return c;
}

/** Analysis table → canvas (so Burmese names render in the PDF). */
export function renderTableCanvas(title, rows, width = 3000) {
  const cols = Object.keys(rows[0] || {});
  const u = width / 1500, rowH = 34 * u, padX = 40 * u;
  const c = document.createElement("canvas");
  c.width = width; c.height = Math.round(130 * u + rowH * (rows.length + 1) + 40 * u);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#15181d"; g.font = `700 ${30 * u}px ${FONT}`; g.fillText(title, padX, 60 * u);

  g.font = `600 ${14 * u}px ${FONT}`;
  const widths = cols.map(k => Math.max(g.measureText(k).width, ...rows.map(r => { g.font = `400 ${15 * u}px ${FONT}`; return g.measureText(String(r[k] ?? "—")).width; })) + 24 * u);
  const isText = cols.map(k => rows.some(r => typeof r[k] === "string" && r[k] !== ""));
  const tx = (i, w) => isText[i] ? xs[i] + 10 * u : xs[i] + w - 12 * u;
  const scale = Math.min(1, (width - 2 * padX) / widths.reduce((a, b) => a + b, 0));
  const xs = []; widths.reduce((x, w) => (xs.push(x), x + w * scale), padX);

  let y = 110 * u;
  g.fillStyle = "#f1f3f6"; g.fillRect(padX, y, width - 2 * padX, rowH);
  g.textBaseline = "middle";
  cols.forEach((k, i) => { g.fillStyle = "#6b7280"; g.font = `600 ${14 * u * scale}px ${FONT}`; g.textAlign = isText[i] ? "left" : "right";
    g.fillText(k, tx(i, widths[i] * scale), y + rowH / 2); });
  rows.forEach((r, ri) => {
    y += rowH;
    if (ri % 2) { g.fillStyle = "#fafbfc"; g.fillRect(padX, y, width - 2 * padX, rowH); }
    cols.forEach((k, i) => { let v = r[k]; v = v == null ? "—" : typeof v === "number" ? Math.round(v).toLocaleString("en-US") : String(v);
      g.fillStyle = "#15181d"; g.font = `${i ? 400 : 500} ${15 * u * scale}px ${FONT}`; g.textAlign = isText[i] ? "left" : "right";
      g.fillText(v, tx(i, widths[i] * scale), y + rowH / 2); });
    g.strokeStyle = "#e3e6eb"; g.lineWidth = 1; g.beginPath(); g.moveTo(padX, y); g.lineTo(width - padX, y); g.stroke();
  });
  return c;
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function exportJPG(canvas, name) {
  const blob = await new Promise((res, rej) => {
    try { canvas.toBlob(b => (b ? res(b) : rej(new Error("Image too large for this browser — try the smaller size."))), "image/jpeg", 0.92); }
    catch { rej(new Error("Map tiles blocked the export (cross-origin). Try again or check your network.")); }
  });
  saveBlob(blob, name);
}

let jsPDFLoaded;
function loadJsPDF() {
  if (window.jspdf) return Promise.resolve();
  return (jsPDFLoaded ||= new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = JSPDF; sc.onload = res; sc.onerror = () => rej(new Error("Could not load the PDF library."));
    document.head.appendChild(sc);
  }));
}

/** One page per canvas; each page is A3 in the canvas' orientation. */
export async function exportPDF(canvases, name) {
  await loadJsPDF();
  const { jsPDF } = window.jspdf;
  let doc;
  for (const cv of canvases) {
    const land = cv.width >= cv.height, pw = land ? 420 : 297, ph = land ? 297 : 420;
    if (!doc) doc = new jsPDF({ orientation: land ? "landscape" : "portrait", unit: "mm", format: "a3", compress: true });
    else doc.addPage("a3", land ? "landscape" : "portrait");
    const m = 8, fit = Math.min((pw - 2 * m) / cv.width, (ph - 2 * m) / cv.height);
    const w = cv.width * fit, h = cv.height * fit;
    doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", (pw - w) / 2, (ph - h) / 2, w, h, undefined, "FAST");
  }
  doc.save(name);
}
