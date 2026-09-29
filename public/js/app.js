import { createBackend, hasFirebase } from "./data.js";
import { distance, fmtDist, fmtNum, neighbours, radiusSummary, loadPopGrid, popGridInfo, populationWithin, poiCounts, POI_GROUPS, matchBrand } from "./analysis.js";
import { renderMapCanvas, renderTableCanvas, exportJPG, exportPDF } from "./export.js";
import { parseFile, exportStores, exportAnalysis, downloadTemplate, coordsFromLink } from "./excel.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = (msg, ms = 2600) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms); };

const S = {
  api: null, brands: [], stores: [], brandsById: {}, hidden: new Set(),
  selectedId: null, radius: 1000, placing: false, editingId: null, map: null, markers: {}, circle: null, findResults: [],
};
// Brand mark: logo if uploaded, else a colour dot. size in px.
const mark = (b, size = 10, extra = "") => b?.logo
  ? `<img class="mark" src="${esc(b.logo)}" alt="" style="width:${size + 8}px;height:${size + 8}px;border-color:${esc(b.color || "#888")};${extra}" />`
  : `<span class="swatch" style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;flex:none;background:${esc(b?.color || "#888")};${extra}"></span>`;
S.showLogos = (() => { try { return localStorage.getItem("sr-logos") !== "0"; } catch { return true; } })();

/** Resize an uploaded logo to a small square data URL (stored in Firestore — no Storage bucket needed). */
async function logoToDataURL(file) {
  if (!/^image\//.test(file.type)) throw new Error("Please choose an image (PNG, JPG, SVG, WebP).");
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read that image.")); i.src = url; });
    const N = 128, c = document.createElement("canvas"); c.width = c.height = N;
    const g = c.getContext("2d");
    const w = im.naturalWidth || N, h = im.naturalHeight || N, k = Math.min(N / w, N / h);
    g.imageSmoothingQuality = "high";
    g.drawImage(im, (N - w * k) / 2, (N - h * k) / 2, w * k, h * k);
    let out = c.toDataURL("image/webp", 0.9);
    if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/png");
    if (out.length > 150000) throw new Error("Logo is too detailed — try a simpler PNG.");
    return out;
  } finally { URL.revokeObjectURL(url); }
}

const canEdit = () => ["owner", "admin", "editor"].includes(S.api.org?.role);
const isAdmin = () => ["owner", "admin"].includes(S.api.org?.role);
const MYANMAR_CENTER = [16.8409, 96.1735]; // Yangon

/* =========================================================== BOOT */
window.addEventListener("load", async () => {
  S.api = await createBackend();
  if (!hasFirebase) return startApp();
  $("#app").hidden = true;
  S.api.onAuth(async user => {
    if (!user) return showAuth("login");
    const r = await S.api.resolveOrg().catch(e => ({ error: e }));
    if (r.org) return startApp();
    if (r.invite) return showAuth("invite", r.invite);
    showAuth("org");
  });
  wireAuth();
});

function showAuth(step, invite) {
  $("#auth").hidden = false; $("#app").hidden = true;
  $("#login-form").hidden = step !== "login"; $("#org-form").hidden = step !== "org"; $("#invite-box").hidden = step !== "invite";
  if (invite) { $("#invite-text").textContent = `${invite.invitedBy} invited you to "${invite.orgName}" as ${invite.role}.`; S.pendingInvite = invite; }
}

function wireAuth() {
  const err = m => ($("#auth-error").textContent = m);
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target), act = e.submitter?.dataset.act;
    err("");
    try { act === "signup" ? await S.api.signUp(f.get("email"), f.get("password")) : await S.api.signIn(f.get("email"), f.get("password")); }
    catch (x) { err(x.code === "auth/invalid-credential" ? "Wrong email or password." : x.message); }
  });
  $("#google-btn").onclick = () => S.api.signInGoogle().catch(x => err(x.message));
  $("#reset-btn").onclick = async () => {
    const email = $("#login-form").email.value;
    if (!email) return err("Type your email first.");
    await S.api.resetPassword(email).then(() => err("Password reset email sent."), x => err(x.message));
  };
  $("#org-form").addEventListener("submit", async e => {
    e.preventDefault();
    try { const r = await S.api.createOrg(e.target.org.value.trim()); if (r.org) startApp(); }
    catch (x) { $("#org-error").textContent = x.message; }
  });
  $("#accept-invite").onclick = async () => { const r = await S.api.acceptInvite(S.pendingInvite); if (r.org) startApp(); };
  $("#decline-invite").onclick = () => showAuth("org");
}

let started = false;
function startApp() {
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#org-name").textContent = S.api.org.name;
  $("#user-email").textContent = S.api.user?.email || "";
  const badge = $("#mode-badge");
  badge.textContent = S.api.mode === "demo" ? "DEMO · data stays in this browser" : S.api.org.role;
  badge.classList.toggle("demo", S.api.mode === "demo");
  $("#signout-btn").hidden = S.api.mode === "demo";
  $("#signout-btn").onclick = () => S.api.signOut().then(() => location.reload());
  if (started) return;
  started = true;

  initMap(); wireUI();
  S.api.on("brands", list => { S.brands = list.sort((a, b) => (b.isOwn - a.isOwn) || a.name.localeCompare(b.name)); S.brandsById = Object.fromEntries(list.map(b => [b.id, b])); renderAll(); });
  S.api.on("stores", list => { S.stores = list; renderAll(); });
  loadPopGrid().then(() => renderAnalysis());
  applyRole();
}

function applyRole() {
  document.querySelectorAll("#add-store-btn, label:has(#import-file), #brand-form, #clear-btn, #sample-btn, #find-form button, #store-delete")
    .forEach(el => (el.hidden = !canEdit()));
  $("#invite-form").hidden = !isAdmin();
  $("#sample-btn").hidden = !canEdit() || S.api.mode !== "demo";
}

/* =========================================================== MAP */
function initMap() {
  S.map = L.map("map", { zoomControl: true }).setView(MYANMAR_CENTER, 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  }).addTo(S.map);
  S.map.on("click", e => {
    if (!S.placing) return;
    stopPlacing();
    openStoreDialog(null, { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) });
  });
}

function renderMarkers() {
  Object.values(S.markers).forEach(m => m.remove());
  S.markers = {};
  for (const s of visibleStores()) {
    const b = S.brandsById[s.brandId] || {};
    const cls = ["pin", b.isOwn && "own", s.status === "pending" && "pending", s.id === S.selectedId && "sel"].filter(Boolean).join(" ");
    const useLogo = S.showLogos && b.logo, sz = useLogo ? (b.isOwn ? 40 : 32) : 20;
    const html = useLogo
      ? `<div class="${cls} logo" style="border-color:${esc(b.color || "#888")};width:${sz}px;height:${sz}px"><img src="${esc(b.logo)}" alt="" /></div>`
      : `<div class="${cls}" style="background:${esc(b.color || "#888")}"></div>`;
    const icon = L.divIcon({ className: "", html, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
    const m = L.marker([s.lat, s.lng], { icon, zIndexOffset: b.isOwn ? 500 : 0, title: `${b.name || ""} · ${s.name}` })
      .on("click", () => selectStore(s.id)).addTo(S.map);
    S.markers[s.id] = m;
  }
  drawCircle();
}

function drawCircle() {
  S.circle?.remove(); S.circle = null;
  const s = S.stores.find(x => x.id === S.selectedId);
  if (!s) return;
  const color = S.brandsById[s.brandId]?.color || "#e11d48";
  S.circle = L.circle([s.lat, s.lng], { radius: S.radius, color, weight: 1.5, fillOpacity: 0.07, dashArray: "4 4", interactive: false }).addTo(S.map);
}

function startPlacing() { S.placing = true; $("#map-hint").hidden = false; $("#map").style.cursor = "crosshair"; }
function stopPlacing() { S.placing = false; $("#map-hint").hidden = true; $("#map").style.cursor = ""; }

/* =========================================================== RENDER */
function visibleStores() {
  return S.stores.filter(s => isFinite(s.lat) && isFinite(s.lng) && !S.hidden.has(s.brandId));
}
function renderAll() { renderFilter(); renderStoreList(); renderMarkers(); renderDetail(); renderBrands(); renderAnalysis(); }

function renderFilter() {
  const counts = {};
  S.stores.forEach(s => (counts[s.brandId] = (counts[s.brandId] || 0) + 1));
  $("#brand-filter").innerHTML = S.brands.map(b =>
    `<span class="chip ${S.hidden.has(b.id) ? "off" : ""}" data-id="${b.id}">${b.logo ? mark(b, 10) : `<i style="background:${esc(b.color)}"></i>`}${esc(b.name)} <b>${counts[b.id] || 0}</b></span>`).join("");
}

function renderStoreList() {
  const q = $("#store-search").value.trim().toLowerCase(), pend = $("#pending-only").checked;
  const list = S.stores
    .filter(s => !S.hidden.has(s.brandId))
    .filter(s => !pend || s.status === "pending")
    .filter(s => !q || [s.name, s.township, s.city, s.address, S.brandsById[s.brandId]?.name].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (S.brandsById[b.brandId]?.isOwn || 0) - (S.brandsById[a.brandId]?.isOwn || 0) || (a.name || "").localeCompare(b.name || ""));
  $("#store-count").textContent = `${list.length} of ${S.stores.length} stores`;
  $("#store-list").innerHTML = list.length ? list.map(s => {
    const b = S.brandsById[s.brandId] || {};
    return `<li data-id="${s.id}" class="${s.id === S.selectedId ? "sel" : ""}">
      ${mark(b, 12)}
      <div class="main"><div class="t">${esc(s.name || "(no name)")}</div><div class="s">${esc(b.name || "?")} · ${esc([s.township, s.city].filter(Boolean).join(", ") || s.address || "")}</div></div>
      ${s.status === "pending" ? '<span class="pill pending">pending</span>' : s.status === "closed" ? '<span class="pill closed">closed</span>' : b.isOwn ? '<span class="pill own">ours</span>' : ""}
    </li>`;
  }).join("") : `<li class="muted small" style="cursor:default">No stores yet — add one, import an Excel file, or use the Find tab.</li>`;
}

function selectStore(id, pan = true) {
  S.selectedId = id;
  const s = S.stores.find(x => x.id === id);
  if (s && pan) S.map.setView([s.lat, s.lng], Math.max(S.map.getZoom(), 14));
  renderStoreList(); renderMarkers(); renderDetail();
}

function renderDetail() {
  const el = $("#detail");
  const s = S.stores.find(x => x.id === S.selectedId);
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  const b = S.brandsById[s.brandId] || {};
  const nb = neighbours(s, S.stores.filter(x => x.status !== "closed"), S.brandsById);
  const comp = nb.filter(n => !n.own);
  const sum = radiusSummary(nb, S.radius);
  const pop = populationWithin(s, S.radius);
  const nearest = comp[0];
  const avgCompSize = sum.competitorSizeKnown ? sum.competitorSqft / sum.competitorSizeKnown : null;

  el.innerHTML = `
    <header>
      ${mark(b, b.logo ? 28 : 14, "margin-top:2px")}
      <div class="main"><h3>${esc(s.name)}</h3><div class="muted small">${esc(b.name || "?")}${b.isOwn ? " · ours" : ""} · ${esc(s.status || "verified")}</div></div>
      <button class="btn sm ghost" id="d-close" aria-label="Close">✕</button>
    </header>
    <label class="small">Radius
      <select id="d-radius">${[500, 1000, 2000, 3000, 5000].map(r => `<option value="${r}" ${r === S.radius ? "selected" : ""}>${fmtDist(r)}</option>`).join("")}</select>
    </label>
    <div class="stats">
      <div class="stat"><b>${nearest ? fmtDist(nearest.d) : "—"}</b><span>Nearest competitor${nearest ? ` (${esc(S.brandsById[nearest.store.brandId]?.name || "?")})` : ""}</span></div>
      <div class="stat"><b>${sum.competitors}</b><span>Competitor stores within ${fmtDist(S.radius)}</span></div>
      <div class="stat"><b>${sum.ownOthers}</b><span>${b.isOwn ? "Our other stores" : "Other " + esc(b.name) + " stores"} within ${fmtDist(S.radius)}</span></div>
      <div class="stat"><b>${pop == null ? "—" : fmtNum(pop)}</b><span>${pop == null ? "Population layer not loaded" : `Est. residents within ${fmtDist(S.radius)}`}</span></div>
    </div>
    <dl class="kv">
      <dt>Size</dt><dd>${s.sizeSqft ? fmtNum(s.sizeSqft) + " sqft" : "—"}${avgCompSize && s.sizeSqft ? ` <span class="muted">(${s.sizeSqft >= avgCompSize ? "+" : ""}${Math.round((s.sizeSqft / avgCompSize - 1) * 100)}% vs nearby competitor avg ${fmtNum(avgCompSize)})</span>` : avgCompSize ? ` <span class="muted">(nearby competitor avg ${fmtNum(avgCompSize)} sqft)</span>` : ""}</dd>
      <dt>Seats</dt><dd>${s.seats || "—"}</dd>
      <dt>Type</dt><dd>${esc(s.type || "—")}</dd>
      <dt>Address</dt><dd>${esc([s.address, s.township, s.city].filter(Boolean).join(", ") || "—")}</dd>
      ${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ""}
      <dt>Location</dt><dd><a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</a></dd>
    </dl>
    ${canEdit() ? `<div class="row gap"><button class="btn sm" id="d-edit">Edit</button>${s.status === "pending" ? '<button class="btn sm primary" id="d-verify">Mark verified</button>' : ""}</div>` : ""}

    <div><h4>Competitors in radius by brand</h4>${renderBrandBars(sum.byBrand)}</div>

    <div><h4>Nearest stores</h4>
      ${nb.slice(0, 10).map(n => { const nbB = S.brandsById[n.store.brandId] || {};
        return `<div class="nb" data-id="${n.store.id}"><span>${mark(nbB, 8, "vertical-align:middle")} ${esc(nbB.name)} · ${esc(n.store.name)}${n.store.sizeSqft ? ` <span class="muted">${fmtNum(n.store.sizeSqft)} sqft</span>` : ""}</span><span class="d">${fmtDist(n.d)}</span></div>`; }).join("") || '<p class="muted small">No other stores yet.</p>'}
    </div>

    <div id="poi-box"><h4>Area activity (OpenStreetMap)</h4>
      <p class="muted small">Proxy for daytime foot traffic &amp; jobs — offices, schools, hospitals, malls. OSM coverage in Myanmar is uneven; compare stores against each other rather than reading absolute numbers.</p>
      <button class="btn sm" id="d-poi">Load area data for ${fmtDist(S.radius)}</button>
    </div>`;

  $("#d-close").onclick = () => { S.selectedId = null; renderAll(); };
  $("#d-radius").onchange = e => setRadius(+e.target.value);
  $("#d-edit") && ($("#d-edit").onclick = () => openStoreDialog(s));
  $("#d-verify") && ($("#d-verify").onclick = () => S.api.update("stores", s.id, { status: "verified" }).then(() => toast("Marked verified")));
  el.querySelectorAll(".nb").forEach(n => (n.onclick = () => selectStore(n.dataset.id)));
  $("#d-poi").onclick = async e => {
    e.target.disabled = true; e.target.textContent = "Loading…";
    try {
      const c = await poiCounts(s, S.radius);
      $("#poi-box").querySelector("button").outerHTML = `<dl class="kv">${POI_GROUPS.map(([k, label]) => `<dt>${label}</dt><dd>${fmtNum(c[k])}</dd>`).join("")}</dl>`;
    } catch (x) { e.target.disabled = false; e.target.textContent = "Retry"; toast(x.message, 4000); }
  };
}

function renderBrandBars(byBrand) {
  const entries = Object.entries(byBrand).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="muted small">None within radius.</p>';
  const max = entries[0][1];
  return entries.map(([id, n]) => { const b = S.brandsById[id] || {};
    return `<div class="row gap small" style="margin:4px 0">${mark(b, 8)}<span style="width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.name || "?")}</span><div class="bar" style="flex:1"><i style="width:${(n / max) * 100}%;background:${esc(b.color)}"></i></div><b>${n}</b></div>`; }).join("");
}

function setRadius(r) { S.radius = r; $("#radius").value = String(r); drawCircle(); renderDetail(); renderAnalysis(); }

/* =========================================================== ANALYSIS */
let sortKey = "Competitors in radius", sortDir = -1, analysisRows = [];

function renderAnalysis() {
  const info = popGridInfo();
  $("#pop-status").innerHTML = info
    ? `Population: ${esc(info.source)} ${esc(info.year)} (${fmtNum(info.cells)} grid cells). Estimates only.`
    : `Population layer not loaded. Run <code>tools/build_pop_grid.py</code> to add WorldPop data (see README).`;
  const active = S.stores.filter(s => s.status !== "closed");
  const ownIds = new Set(S.brands.filter(b => b.isOwn).map(b => b.id));
  const targets = active.filter(s => ownIds.size ? ownIds.has(s.brandId) : true);
  const R = S.radius, rkm = fmtDist(R);

  analysisRows = targets.map(s => {
    const nb = neighbours(s, active, S.brandsById);
    const comp = nb.find(n => !n.own);
    const sum = radiusSummary(nb, R);
    const pop = populationWithin(s, R);
    return {
      _id: s.id, Store: s.name, Brand: S.brandsById[s.brandId]?.name || "",
      "Nearest competitor": comp ? S.brandsById[comp.store.brandId]?.name || "" : "",
      "Distance (m)": comp ? Math.round(comp.d) : null,
      "Competitors in radius": sum.competitors,
      "Competitor sqft in radius": sum.competitorSqft || null,
      "Own stores in radius": sum.ownOthers,
      "Size (sqft)": s.sizeSqft || null,
      "Population in radius": pop == null ? null : Math.round(pop),
      "Pop per store": pop == null ? null : Math.round(pop / (sum.competitors + sum.ownOthers + 1)),
    };
  });
  analysisRows.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
  });

  const cols = Object.keys(analysisRows[0] || { Store: 1 }).filter(k => k !== "_id" && !(k.startsWith("Pop") && !info));
  const t = $("#analysis-table");
  if (!analysisRows.length) { t.innerHTML = `<tr><td class="muted">Add stores and mark your brand as "Ours" in Brands &amp; Team.</td></tr>`; return; }
  const comps = analysisRows.map(r => r["Competitors in radius"]), maxC = Math.max(...comps), minC = Math.min(...comps);
  t.innerHTML = `<thead><tr>${cols.map(c => `<th data-k="${esc(c)}">${esc(c.replace("radius", rkm))}${c === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
    <tbody>${analysisRows.map(r => `<tr data-id="${r._id}">${cols.map(c => {
      let v = r[c]; const cls = c === "Competitors in radius" && maxC > minC ? (v === maxC ? "heat-hi" : v === minC ? "heat-lo" : "") : "";
      if (c === "Distance (m)") v = v == null ? "—" : fmtDist(v); else if (typeof v === "number") v = fmtNum(v); else if (v == null) v = "—";
      return `<td class="${cls}">${esc(v)}</td>`; }).join("")}</tr>`).join("")}</tbody>`;
}

/* =========================================================== FIND (Google Places) */
function renderFind() {
  const box = $("#find-results");
  if (!S.findResults.length) { box.innerHTML = ""; return; }
  const opts = id => `<option value="">— skip —</option>` + S.brands.map(b => `<option value="${b.id}" ${b.id === id ? "selected" : ""}>${esc(b.name)}</option>`).join("") + `<option value="__new">+ New brand from name…</option>`;
  box.innerHTML = `<div class="row between small"><span>${S.findResults.length} results · ${S.findResults.filter(r => r.brandId).length} matched</span>
      <button class="btn sm primary" id="find-add">Add matched as pending</button></div>` +
    S.findResults.map((r, i) => `<div class="result ${r.dup ? "dup" : ""}">
      <div class="main"><b>${esc(r.name)}</b><div class="muted small">${esc(r.address || "")}</div>
      ${r.dup ? '<div class="small muted">Already on map</div>' : ""}</div>
      <select data-i="${i}" ${r.dup ? "disabled" : ""}>${opts(r.brandId)}</select></div>`).join("");
  box.querySelectorAll("select").forEach(sel => (sel.onchange = async () => {
    const r = S.findResults[+sel.dataset.i];
    if (sel.value === "__new") {
      const name = prompt("Brand name", r.name.split(/[-–|(]/)[0].trim());
      if (!name) { sel.value = ""; return; }
      r.brandId = await S.api.add("brands", { name, color: randomColor(), isOwn: false, aliases: [] });
      S.findResults.forEach(o => { if (!o.brandId && !o.dup) o.brandId = matchBrand(o.name, [{ id: r.brandId, name }]); });
      renderFind();
    } else r.brandId = sel.value || null;
  }));
  $("#find-add").onclick = async () => {
    const add = S.findResults.filter(r => r.brandId && !r.dup);
    if (!add.length) return toast("Pick a brand for at least one result.");
    await S.api.bulkAdd("stores", add.map(r => ({
      brandId: r.brandId, name: r.name, lat: r.lat, lng: r.lng, address: r.address || "", city: "", township: "",
      status: "pending", source: "google_places", placeId: r.placeId || "", sizeSqft: null, seats: null, type: "", notes: "",
    })));
    toast(`Added ${add.length} stores as pending — verify them in the Stores tab.`);
    S.findResults = []; renderFind();
  };
}

/* =========================================================== STORE DIALOG */
function openStoreDialog(store, preset = {}) {
  const f = $("#store-form"), d = $("#store-dialog");
  if (!S.brands.length) return toast("Add a brand first (Brands & Team tab).");
  S.editingId = store?.id || null;
  f.brandId.innerHTML = S.brands.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  const v = { brandId: S.brands[0].id, status: "verified", ...store, ...preset };
  for (const el of f.elements) if (el.name && el.name in v) el.value = v[el.name] ?? "";
  if (!store) ["name", "address", "township", "city", "sizeSqft", "seats", "notes", "mapsLink", "type"].forEach(k => { if (!(k in preset)) f[k].value = ""; });
  f.mapsLink.value = "";
  $("#store-dialog-title").textContent = store ? "Edit store" : "Add store";
  $("#store-delete").hidden = !store || !canEdit();
  d.returnValue = "";
  d.showModal();
}

/* =========================================================== BRANDS & TEAM */
function renderBrands() {
  $("#brand-list").innerHTML = S.brands.map(b => `<li data-id="${b.id}" style="cursor:default;align-items:flex-start">
    <div class="logo-slot">
      <button type="button" class="logo-btn" data-logo="${b.id}" title="${b.logo ? "Change logo" : "Upload logo"}" style="border-color:${esc(b.color)}" ${canEdit() ? "" : "disabled"}>
        ${b.logo ? `<img src="${esc(b.logo)}" alt="" />` : '<span>+ Logo</span>'}</button>
      <input type="color" value="${esc(b.color)}" data-f="color" title="Pin colour" ${canEdit() ? "" : "disabled"} />
      ${b.logo && canEdit() ? `<button type="button" class="link small" data-unlogo="${b.id}">Remove</button>` : ""}
    </div>
    <div class="main"><input value="${esc(b.name)}" data-f="name" ${canEdit() ? "" : "disabled"} />
      <input class="small" value="${esc((b.aliases || []).join(", "))}" data-f="aliases" placeholder="Aliases, comma-separated" style="margin-top:4px" ${canEdit() ? "" : "disabled"} /></div>
    <label class="small"><input type="checkbox" data-f="isOwn" ${b.isOwn ? "checked" : ""} ${canEdit() ? "" : "disabled"} /> Ours</label>
    ${canEdit() ? `<button class="btn sm ghost" data-del="${b.id}" title="Delete brand">✕</button>` : ""}</li>`).join("");
}

async function renderMembers() {
  const list = await S.api.listMembers().catch(() => []);
  $("#member-list").innerHTML = list.map(m => `<li style="cursor:default"><div class="main"><div class="t">${esc(m.email)}</div></div><span class="pill">${esc(m.role)}</span></li>`).join("");
}

/* =========================================================== WIRING */
function wireUI() {
  document.querySelectorAll(".tab").forEach(t => (t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tabpane").forEach(p => (p.hidden = p.id !== "tab-" + t.dataset.tab));
    if (t.dataset.tab === "settings") renderMembers();
  }));

  $("#brand-filter").onclick = e => { const c = e.target.closest(".chip"); if (!c) return;
    S.hidden.has(c.dataset.id) ? S.hidden.delete(c.dataset.id) : S.hidden.add(c.dataset.id); renderFilter(); renderStoreList(); renderMarkers(); };
  $("#store-search").oninput = renderStoreList;
  $("#pending-only").onchange = renderStoreList;
  $("#store-list").onclick = e => { const li = e.target.closest("li[data-id]"); if (li) selectStore(li.dataset.id); };

  $("#add-store-btn").onclick = () => { if (!S.brands.length) return toast("Add a brand first (Brands & Team tab)."); startPlacing(); toast("Click the map where the store is — or cancel and type coordinates."); };
  $("#cancel-place").onclick = () => { stopPlacing(); openStoreDialog(null, { lat: +S.map.getCenter().lat.toFixed(6), lng: +S.map.getCenter().lng.toFixed(6) }); };
  $("#template-btn").onclick = downloadTemplate;
  $("#export-btn").onclick = () => S.stores.length ? exportStores(S.stores, S.brandsById) : toast("Nothing to export yet.");
  $("#analysis-export").onclick = () => analysisRows.length ? exportAnalysis(analysisRows.map(({ _id, ...r }) => r), S.radius / 1000) : toast("Nothing to export yet.");
  $("#radius").onchange = e => setRadius(+e.target.value);
  $("#analysis-table").onclick = e => {
    const th = e.target.closest("th"); if (th) { sortDir = sortKey === th.dataset.k ? -sortDir : -1; sortKey = th.dataset.k; return renderAnalysis(); }
    const tr = e.target.closest("tr[data-id]"); if (tr) selectStore(tr.dataset.id);
  };

  // Excel import
  $("#import-file").onchange = async e => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      const { rows, errors } = await parseFile(file);
      if (!rows.length) return alert("No importable rows.\n\n" + errors.join("\n"));
      const byName = Object.fromEntries(S.brands.map(b => [b.name.toLowerCase(), b.id]));
      const newBrands = [...new Set(rows.map(r => r.brand))].filter(n => !byName[n.toLowerCase()]);
      const msg = `Import ${rows.length} stores?` + (newBrands.length ? `\n\nNew brands will be created: ${newBrands.join(", ")}` : "") + (errors.length ? `\n\n${errors.length} row(s) skipped:\n${errors.slice(0, 8).join("\n")}${errors.length > 8 ? "\n…" : ""}` : "");
      if (!confirm(msg)) return;
      for (const n of newBrands) byName[n.toLowerCase()] = await S.api.add("brands", { name: n, color: randomColor(), isOwn: false, aliases: [] });
      await S.api.bulkAdd("stores", rows.map(({ brand, ...r }) => ({ ...r, brandId: byName[brand.toLowerCase()], source: "excel" })));
      toast(`Imported ${rows.length} stores.`);
      const pts = rows.map(r => [r.lat, r.lng]); if (pts.length) S.map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    } catch (x) { alert("Could not read that file: " + x.message); }
  };

  // Store dialog
  const f = $("#store-form");
  f.mapsLink.oninput = () => { const c = coordsFromLink(f.mapsLink.value); if (c) { f.lat.value = c.lat; f.lng.value = c.lng; } };
  $("#store-dialog").addEventListener("close", async () => {
    if ($("#store-dialog").returnValue !== "save") return;
    const v = Object.fromEntries(new FormData(f));
    delete v.mapsLink;
    const data = { ...v, lat: +v.lat, lng: +v.lng, sizeSqft: v.sizeSqft ? +v.sizeSqft : null, seats: v.seats ? +v.seats : null };
    try {
      if (S.editingId) { await S.api.update("stores", S.editingId, data); toast("Saved"); }
      else { const id = await S.api.add("stores", { ...data, source: "manual" }); selectStore(id); toast("Store added"); }
    } catch (x) { toast("Save failed: " + x.message, 4000); }
  });
  $("#store-delete").onclick = async () => {
    if (!confirm("Delete this store?")) return;
    await S.api.remove("stores", S.editingId); $("#store-dialog").close("cancel");
    if (S.selectedId === S.editingId) S.selectedId = null; toast("Deleted");
  };

  // Brands
  $("#brand-form").onsubmit = async e => { e.preventDefault();
    await S.api.add("brands", { name: e.target.name.value.trim(), color: e.target.color.value, isOwn: false, aliases: [] });
    e.target.reset(); e.target.color.value = randomColor(); };
  $("#brand-list").onchange = e => { const li = e.target.closest("li"), f = e.target.dataset.f; if (!li || !f) return;
    const val = f === "isOwn" ? e.target.checked : f === "aliases" ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : e.target.value;
    S.api.update("brands", li.dataset.id, { [f]: val }); };
  const logoInput = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", hidden: true });
  document.body.appendChild(logoInput);
  logoInput.onchange = async () => {
    const file = logoInput.files[0], id = logoInput.dataset.brand; logoInput.value = "";
    if (!file) return;
    try { await S.api.update("brands", id, { logo: await logoToDataURL(file) }); toast("Logo saved"); }
    catch (x) { toast(x.message, 4000); }
  };
  $("#brand-list").onclick = async e => {
    const lb = e.target.closest("[data-logo]");
    if (lb) { logoInput.dataset.brand = lb.dataset.logo; return logoInput.click(); }
    const ul = e.target.closest("[data-unlogo]");
    if (ul) return S.api.update("brands", ul.dataset.unlogo, { logo: null });
    const id = e.target.dataset.del; if (!id) return;
    const n = S.stores.filter(s => s.brandId === id).length;
    if (!confirm(n ? `Delete this brand and its ${n} stores?` : "Delete this brand?")) return;
    for (const s of S.stores.filter(s => s.brandId === id)) await S.api.remove("stores", s.id);
    await S.api.remove("brands", id); };

  // Team
  $("#invite-form").onsubmit = async e => { e.preventDefault();
    try { await S.api.invite(e.target.email.value, e.target.role.value);
      $("#invite-msg").textContent = `Invite saved. Ask ${e.target.email.value} to sign up with that email — they'll be offered to join.`; e.target.reset(); }
    catch (x) { $("#invite-msg").textContent = x.message; } };

  $("#clear-btn").onclick = async () => { if (prompt('Type DELETE to remove every store and brand in this workspace.') !== "DELETE") return;
    await S.api.clearAll(); S.selectedId = null; toast("Workspace cleared"); };
  $("#sample-btn").onclick = loadSample;

  // Find
  $("#find-form").onsubmit = async e => { e.preventDefault();
    const fd = new FormData(e.target), btn = e.target.querySelector("button");
    $("#find-error").textContent = ""; btn.disabled = true; btn.textContent = "Searching…";
    try {
      const bnds = S.map.getBounds();
      const bias = fd.get("bias") ? { low: { latitude: bnds.getSouth(), longitude: bnds.getWest() }, high: { latitude: bnds.getNorth(), longitude: bnds.getEast() } } : null;
      const places = await S.api.placesSearch(`${fd.get("q")} ${fd.get("where") || ""}`.trim(), bias);
      S.findResults = places.map(p => ({ ...p, brandId: matchBrand(p.name, S.brands),
        dup: S.stores.some(s => (p.placeId && s.placeId === p.placeId) || distance(s, p) < 40) }));
      renderFind();
    } catch (x) { $("#find-error").textContent = x.message; }
    finally { btn.disabled = false; btn.textContent = "Search"; } };

  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (S.placing) stopPlacing(); $("#export-menu").hidden = true; } });

  // Map export (JPG / PDF)
  $("#logo-toggle").checked = S.showLogos;
  $("#logo-toggle").onchange = e => { S.showLogos = e.target.checked; try { localStorage.setItem("sr-logos", S.showLogos ? "1" : "0"); } catch {} renderMarkers(); };
  $("#export-map-btn").onclick = e => { e.stopPropagation(); $("#export-menu").hidden = !$("#export-menu").hidden; };
  document.addEventListener("click", e => { if (!e.target.closest(".map-export")) $("#export-menu").hidden = true; });
  $("#export-menu").onclick = e => { const b = e.target.closest("button[data-fmt]"); if (b) exportMap(b.dataset.fmt, +b.dataset.size); };
}

/* =========================================================== MAP EXPORT */
async function exportMap(fmt, longSide) {
  $("#export-menu").hidden = true;
  const btn = $("#export-map-btn"), label = btn.textContent;
  btn.disabled = true;
  try {
    await document.fonts.ready;
    const bounds = S.map.getBounds();
    const stores = visibleStores().filter(s => s.status !== "closed" && bounds.contains([s.lat, s.lng]));
    const sel = S.stores.find(x => x.id === S.selectedId) || null;
    let selectedLine = "";
    if (sel) {
      const nb = neighbours(sel, S.stores.filter(x => x.status !== "closed"), S.brandsById);
      const comp = nb.find(n => !n.own), sum = radiusSummary(nb, S.radius), pop = populationWithin(sel, S.radius);
      selectedLine = `${sel.name}: nearest competitor ${comp ? fmtDist(comp.d) + " (" + (S.brandsById[comp.store.brandId]?.name || "") + ")" : "—"}` +
        ` · ${sum.competitors} competitor stores within ${fmtDist(S.radius)}` + (pop != null ? ` · ~${fmtNum(pop)} residents` : "") +
        (sel.sizeSqft ? ` · ${fmtNum(sel.sizeSqft)} sqft` : "");
    }
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const canvas = await renderMapCanvas({
      map: S.map, stores, brandsById: S.brandsById, selected: sel, showLogos: S.showLogos, radius: S.radius, longSide, selectedLine,
      title: `${S.api.org.name} — Competitor map`,
      subtitle: `${date}  ·  ${stores.length} stores in view${sel ? `  ·  radius ${fmtDist(S.radius)} around ${sel.name}` : ""}`,
      onProgress: p => (btn.textContent = `Rendering ${Math.round(p * 100)}%`),
    });
    const base = `competitor-map-${new Date().toISOString().slice(0, 10)}`;
    if (fmt === "jpg") await exportJPG(canvas, `${base}-${longSide}px.jpg`);
    else {
      const pages = [canvas];
      const rows = analysisRows.map(({ _id, ...r }) => r);
      if (rows.length) pages.push(renderTableCanvas(`Trade-area comparison · radius ${fmtDist(S.radius)} · ${date}`, rows, 3000));
      btn.textContent = "Building PDF…";
      await exportPDF(pages, `${base}.pdf`);
    }
    toast("Export ready");
  } catch (x) { toast("Export failed: " + x.message, 5000); console.error(x); }
  finally { btn.disabled = false; btn.textContent = label; }
}

/* =========================================================== HELPERS */
const PALETTE = ["#dc2626", "#2563eb", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d", "#4f46e5", "#b45309", "#0d9488"];
function randomColor() { const used = new Set(S.brands.map(b => b.color)); return PALETTE.find(c => !used.has(c)) || "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"); }

// Fictional brands & positions — for trying the app only.
async function loadSample() {
  if (S.stores.length && !confirm("Add fictional sample data alongside your existing data?")) return;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const spots = [[16.7797, 96.1561, "Kyauktada"], [16.8021, 96.1344, "Kamaryut"], [16.8290, 96.1300, "Hlaing"], [16.8545, 96.1285, "Mayangone"], [16.8667, 96.1950, "North Okkalapa"], [16.8058, 96.1780, "Bahan"], [16.8321, 96.1605, "Yankin"], [16.7880, 96.1900, "Thaketa"], [16.8900, 96.1150, "Insein"], [16.8150, 96.1500, "Sanchaung"]];
  const brands = [["Sample Pizza Co (ours)", "#16a34a", true, 7, 1500], ["Rival Slice", "#dc2626", false, 9, 1100], ["Crust Express", "#2563eb", false, 6, 700], ["Oven Hub", "#9333ea", false, 4, 1900]];
  const rows = [];
  for (const [name, color, isOwn, n, size] of brands) {
    const id = await S.api.add("brands", { name, color, isOwn, aliases: [] });
    for (let i = 0; i < n; i++) { const [la, ln, tsp] = spots[Math.floor(rnd() * spots.length)];
      rows.push({ brandId: id, name: `${name.replace(" (ours)", "")} ${tsp} ${i + 1}`, lat: +(la + (rnd() - .5) * .02).toFixed(6), lng: +(ln + (rnd() - .5) * .02).toFixed(6),
        township: tsp, city: "Yangon", address: "", sizeSqft: Math.round(size * (0.6 + rnd() * 0.8) / 50) * 50, seats: Math.round(size / 25 * (0.6 + rnd() * 0.8)),
        type: rnd() > .8 ? "Delivery only" : "Dine-in", status: "verified", source: "sample", notes: "FICTIONAL SAMPLE" }); }
  }
  await S.api.bulkAdd("stores", rows);
  S.map.setView(MYANMAR_CENTER, 12); toast("Sample loaded — brands and stores are fictional.");
}
