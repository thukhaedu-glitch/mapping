import { createBackend, hasFirebase } from "./data.js";
import { distance, fmtDist, fmtNum, neighbours, radiusSummary, loadPopGrid, popGridInfo, populationWithin, poiCounts, POI_GROUPS, matchBrand, worldpopDirect, WORLDPOP_YEAR, roadRoute, fmtDur } from "./analysis.js";
import { TILES } from "./tiles.js";
import { PROVIDERS } from "./ai-core.js";
import { DIVISIONS, divisionOf } from "./myanmar.js";
import { renderMapCanvas, renderTableCanvas, exportJPG, exportPDF } from "./export.js";
import { parseFile, exportStores, exportAnalysis, downloadTemplate, coordsFromLink } from "./excel.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = (msg, ms = 2600) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms); };

const S = {
  api: null, brands: [], stores: [], brandsById: {}, hidden: new Set(),
  selectedId: null, radius: 1000, placing: false, editingId: null, map: null, markers: {}, circle: null, findResults: [],
  filter: { brand: "", division: "", township: "" },
  measure: { on: false, pts: [], items: [], layer: null, temp: null }, popBusy: new Set(), popFailed: new Set(),
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

const active = () => (S.api.org?.status || "active") === "active";
const canEdit = () => active() && ["owner", "admin", "editor"].includes(S.api.org?.role);
const isAdmin = () => active() && ["owner", "admin"].includes(S.api.org?.role);
const MYANMAR_CENTER = [16.8409, 96.1735]; // Yangon

/* =========================================================== BOOT */
// ES modules run after the HTML is parsed, so no need to wait for "load" (fonts, images, tiles).
(async () => {
  try { S.api = await createBackend(); }
  catch (x) {
    console.error(x);
    $("#boot .spinner").hidden = true;
    return setBoot("Could not reach Firebase. Check your internet connection (or VPN / firewall blocking gstatic.com) and reload.");
  }
  if (!hasFirebase) { hideBoot(); return startApp(); }
  $("#app").hidden = true;
  wireAuth();
  S.api.onAuth(async user => {
    if (!user) { hideBoot(); return showAuth("login"); }
    // Returning user: open the workspace straight from cache, verify membership in the background.
    const cached = S.api.cachedOrg();
    if (cached) {
      S.api.org = cached; hideBoot(); startApp();
      S.api.resolveOrg().then(r => { if (!r.org || r.org.id !== cached.id || r.org.role !== cached.role || (r.org.status || "active") !== (cached.status || "active")) location.reload(); }).catch(() => {});
      return;
    }
    setBoot("Opening your workspace…");
    const r = await S.api.resolveOrg().catch(e => ({ error: e }));
    hideBoot();
    if (r.org) return startApp();
    if (r.blocked) return showBlocked();
    if (r.invite) return showAuth("invite", r.invite);
    if (r.error) $("#org-error").textContent = r.error.message;
    showAuth("org");
  });
})();

function showBlocked() {
  hideBoot(); $("#auth").hidden = true; $("#app").hidden = true; $("#blocked").hidden = false;
  $("#blocked-signout").onclick = () => { S.api.forgetOrg?.(); S.api.signOut().then(() => location.reload()); };
}
function setBoot(msg) { $("#boot").hidden = false; $("#boot-msg").textContent = msg; }
function hideBoot() { $("#boot").hidden = true; }

/** Disable a button and show progress text while an async action runs. */
async function busy(btn, text, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = text; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

function showAuth(step, invite) {
  $("#auth").hidden = false; $("#app").hidden = true;
  // When already signed in (workspace / invite step) let them switch account
  $("#auth-who").hidden = step === "login";
  $("#auth-email").textContent = S.api.user?.email || "";
  $("#auth-signout").onclick = () => { S.api.forgetOrg?.(); S.api.signOut().then(() => location.reload()); };
  if (step === "org" && S.api.user?.email && !$("#org-form").contactEmail.value) $("#org-form").contactEmail.value = S.api.user.email;
  $("#login-form").hidden = step !== "login"; $("#org-form").hidden = step !== "org"; $("#invite-box").hidden = step !== "invite";
  if (invite) { $("#invite-text").textContent = `${invite.invitedBy} invited you to "${invite.orgName}" as ${invite.role}.`; S.pendingInvite = invite; }
}

// Firebase Auth error codes → what to actually do about them
function authMsg(x) {
  const m = {
    "auth/configuration-not-found": "Firebase Authentication is not set up yet.\nConsole → Build → Authentication → Get started → enable Email/Password.",
    "auth/operation-not-allowed": "This sign-in method is disabled.\nConsole → Authentication → Sign-in method → enable Email/Password (and Google).",
    "auth/invalid-credential": "Wrong email or password — or no account yet (use Create account).",
    "auth/email-already-in-use": "An account with this email already exists — use Sign in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "That email address is not valid.",
    "auth/unauthorized-domain": "This domain is not authorised.\nConsole → Authentication → Settings → Authorized domains → add it.",
    "auth/popup-closed-by-user": "Google sign-in window was closed.",
    "auth/too-many-requests": "Too many attempts — wait a few minutes.",
    "auth/network-request-failed": "Network error — check your connection.",
  };
  return m[x.code] || `${x.code || ""} ${x.message || x}`.trim();
}

function wireAuth() {
  const err = m => ($("#auth-error").textContent = m);
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target), act = e.submitter?.dataset.act;
    err("");
    try {
      await busy(e.submitter, act === "signup" ? "Creating account…" : "Signing in…", () =>
        act === "signup" ? S.api.signUp(f.get("email"), f.get("password")) : S.api.signIn(f.get("email"), f.get("password")));
    } catch (x) { err(authMsg(x)); }
  });
  $("#reset-btn").onclick = async () => {
    const email = $("#login-form").email.value;
    if (!email) return err("Type your email first.");
    await S.api.resetPassword(email).then(() => err("Password reset email sent."), x => err(x.message));
  };
  $("#org-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#org-error").textContent = "";
    const f = Object.fromEntries(new FormData(e.target));
    const list = v => String(v || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 20);
    const profile = {
      industry: f.industry, branches: +f.branches || 0, contactName: f.contactName.trim(), phone: f.phone.trim(),
      jobTitle: (f.jobTitle || "").trim(), contactEmail: (f.contactEmail || "").trim(), country: f.country, cities: list(f.cities), website: (f.website || "").trim(),
      competitors: list(f.competitors), goal: f.goal,
    };
    try { const r = await busy(e.submitter || e.target.querySelector("button"), "Creating workspace…", () => S.api.createOrg(f.org.trim(), profile)); if (r.org) startApp(); }
    catch (x) { $("#org-error").textContent = x.code === "permission-denied" ? "Permission denied — publish firestore.rules in Firebase Console → Firestore → Rules." : x.message; }
  });
  $("#accept-invite").onclick = async e => { const r = await busy(e.target, "Joining…", () => S.api.acceptInvite(S.pendingInvite)); if (r.org) startApp(); };
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
  if (S.api.org.status === "hold") { $("#status-banner").hidden = false; $("#status-banner").textContent = "This workspace is on hold — read-only. Contact your StoreRadar account manager to reactivate it."; }
  $("#signout-btn").onclick = () => { S.api.forgetOrg?.(); S.api.signOut().then(() => location.reload()); };
  if (started) return;
  started = true;

  initMap(); wireUI();
  checkFeatures();
  checkProfile();
  checkVerified();
  // keep asking until the business details are complete
  setInterval(() => { if (!$("#profile-dialog").open) checkProfile(); }, 10 * 60 * 1000);
  window.addEventListener("focus", () => { if (!$("#profile-dialog").open && Date.now() - (S.lastProfileCheck || 0) > 5 * 60 * 1000) checkProfile(); });
  S.api.on("brands", list => { S.brands = list.sort((a, b) => (b.isOwn - a.isOwn) || a.name.localeCompare(b.name)); S.brandsById = Object.fromEntries(list.map(b => [b.id, b])); renderAll(); });
  S.api.on("stores", list => { S.stores = list; renderAll(); });
  loadPopGrid().then(() => renderAnalysis());
  applyRole();
}

function applyRole() {
  document.querySelectorAll("#add-store-btn, label:has(#import-file), #brand-form, #clear-btn, #sample-btn, #find-form button, #store-delete")
    .forEach(el => (el.hidden = !canEdit()));
  $("#invite-form").hidden = !isAdmin();
  $("#ai-find-form").hidden = !canEdit();
  $("#sample-btn").hidden = !canEdit() || S.api.mode !== "demo";
}

/* =========================================================== MAP */
function initMap() {
  S.map = L.map("map", { zoomControl: true }).setView(MYANMAR_CENTER, 12);
  L.tileLayer(TILES.url, { maxZoom: TILES.maxZoom, subdomains: TILES.subdomains || "abc", attribution: TILES.html, crossOrigin: true }).addTo(S.map);
  S.measure.layer = L.layerGroup().addTo(S.map);
  S.map.on("click", e => {
    if (S.measure.on) return measureClick({ lat: e.latlng.lat, lng: e.latlng.lng });
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
      .on("click", () => (S.measure.on ? measureClick(s) : selectStore(s.id))).addTo(S.map);
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
const tspKey = t => String(t || "").trim().toLowerCase();
/** Brand / division / township filter from the bar under the top bar. */
function passes(s) {
  const f = S.filter;
  return (!f.brand || s.brandId === f.brand) && (!f.division || divisionOf(s) === f.division) && (!f.township || tspKey(s.township) === f.township);
}
function visibleStores() {
  return S.stores.filter(s => isFinite(s.lat) && isFinite(s.lng) && !S.hidden.has(s.brandId) && passes(s));
}
function renderAll() { renderFilterBar(); renderFilter(); renderStoreList(); renderMarkers(); renderDetail(); renderBrands(); renderAnalysis(); }

function renderFilter() {
  $("#brand-names").innerHTML = S.brands.map(b => `<option value="${esc(b.name)}">`).join("");
  const counts = {};
  S.stores.forEach(s => (counts[s.brandId] = (counts[s.brandId] || 0) + 1));
  $("#brand-filter").innerHTML = S.brands.map(b =>
    `<span class="chip ${S.hidden.has(b.id) ? "off" : ""}" data-id="${b.id}">${b.logo ? mark(b, 10) : `<i style="background:${esc(b.color)}"></i>`}${esc(b.name)} <b>${counts[b.id] || 0}</b></span>`).join("");
}

function renderStoreList() {
  const q = $("#store-search").value.trim().toLowerCase(), pend = $("#pending-only").checked;
  const list = S.stores
    .filter(s => !S.hidden.has(s.brandId) && passes(s))
    .filter(s => !pend || s.status === "pending")
    .filter(s => !q || [s.name, s.township, s.city, s.address, S.brandsById[s.brandId]?.name].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (S.brandsById[b.brandId]?.isOwn || 0) - (S.brandsById[a.brandId]?.isOwn || 0) || (a.name || "").localeCompare(b.name || ""));
  $("#store-count").textContent = `${list.length} of ${S.stores.length} stores`;
  $("#store-list").innerHTML = list.length ? list.map(s => {
    const b = S.brandsById[s.brandId] || {};
    return `<li data-id="${s.id}" class="${s.id === S.selectedId ? "sel" : ""}">
      ${mark(b, 12)}
      <div class="main"><div class="t">${esc(s.name || "(no name)")}</div><div class="s">${esc(b.name || "?")} · ${s.rating ? `⭐ ${s.rating}${s.ratingCount != null ? ` (${fmtNum(s.ratingCount)})` : ""} · ` : ""}${esc([s.township, s.city].filter(Boolean).join(", ") || s.address || "")}</div></div>
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
  const pop = getPop(s, S.radius);
  if (pop == null) autoPop(s, S.radius);
  const popLabel = pop != null ? `Est. residents within ${fmtDist(S.radius)}`
    : S.popBusy.has(popKey(s, S.radius)) ? "Loading population (WorldPop)…"
    : S.popFailed.has(popKey(s, S.radius)) ? "Population unavailable — see Analysis tab" : "Population";
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
      <div class="stat"><b>${pop == null ? "—" : fmtNum(pop)}</b><span>${popLabel}</span></div>
    </div>
    <dl class="kv">
      <dt>Size</dt><dd>${s.sizeSqft ? fmtNum(s.sizeSqft) + " sqft" : "—"}${avgCompSize && s.sizeSqft ? ` <span class="muted">(${s.sizeSqft >= avgCompSize ? "+" : ""}${Math.round((s.sizeSqft / avgCompSize - 1) * 100)}% vs nearby competitor avg ${fmtNum(avgCompSize)})</span>` : avgCompSize ? ` <span class="muted">(nearby competitor avg ${fmtNum(avgCompSize)} sqft)</span>` : ""}</dd>
      <dt>Google rating</dt><dd>${s.rating ? `⭐ ${s.rating}${s.ratingCount != null ? ` · ${fmtNum(s.ratingCount)} reviews` : ""}` : "—"}${sum.competitorReviews ? ` <span class="muted">(competitors within ${fmtDist(S.radius)}: ${fmtNum(sum.competitorReviews)} reviews${sum.competitorRating ? `, avg ⭐ ${sum.competitorRating}` : ""})</span>` : ""}</dd>
      ${s.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></dd>` : ""}
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
        return `<div class="nb" data-id="${n.store.id}" title="Click to draw the distance line on the map"><span>${mark(nbB, 8, "vertical-align:middle")} ${esc(nbB.name)} · ${esc(n.store.name)}${n.store.sizeSqft ? ` <span class="muted">${fmtNum(n.store.sizeSqft)} sqft</span>` : ""}${n.store.rating ? ` <span class="muted">⭐${n.store.rating}${n.store.ratingCount != null ? ` (${fmtNum(n.store.ratingCount)})` : ""}</span>` : ""}</span><span class="d">📏 ${fmtDist(n.d)} <button class="link small" data-go="${n.store.id}" title="Open this store">↗</button></span></div>`; }).join("") || '<p class="muted small">No other stores yet.</p>'}
      <p class="muted small">Click a row to draw the line + road distance. Use 📏 Measure on the map for any two points.</p>
    </div>

    <div id="poi-box"><h4>Area activity (OpenStreetMap)</h4>
      <p class="muted small">Proxy for daytime foot traffic &amp; jobs — offices, schools, hospitals, malls. OSM coverage in Myanmar is uneven; compare stores against each other rather than reading absolute numbers.</p>
      <button class="btn sm" id="d-poi">Load area data for ${fmtDist(S.radius)}</button>
    </div>

    <div id="ai-box"><h4>✨ AI insight</h4>
      <div class="row gap"><select id="ai-lang" style="width:auto"><option value="my">မြန်မာ</option><option value="en">English</option></select>
      <button class="btn sm" id="d-ai">Analyse this store</button></div>
      <div id="ai-insight"></div>
    </div>`;

  $("#d-close").onclick = () => { S.selectedId = null; renderAll(); };
  $("#d-radius").onchange = e => setRadius(+e.target.value);
  $("#d-edit") && ($("#d-edit").onclick = () => openStoreDialog(s));
  $("#d-verify") && ($("#d-verify").onclick = () => S.api.update("stores", s.id, { status: "verified" }).then(() => toast("Marked verified")));
  el.querySelectorAll(".nb").forEach(n => (n.onclick = e => {
    const go = e.target.closest("[data-go]");
    if (go) return selectStore(go.dataset.go);
    const other = S.stores.find(x => x.id === n.dataset.id);
    if (other) addMeasure(s, other, true);
  }));
  $("#d-ai").onclick = e => runInsight(s, nb, sum, pop, e.target);
  $("#d-poi").onclick = async e => {
    e.target.disabled = true; e.target.textContent = "Loading…";
    try {
      const c = await poiCounts(s, S.radius);
      S.lastPoi = { id: s.id, radius: S.radius, counts: c };
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
  $("#pop-status").innerHTML = (info
    ? `Population: ${esc(info.source)} ${esc(info.year)} offline grid. Estimates only.`
    : `Population: WorldPop ${WORLDPOP_YEAR} estimates, fetched automatically and saved per store &amp; radius.`);
  const active = S.stores.filter(s => s.status !== "closed");
  const ownIds = new Set(S.brands.filter(b => b.isOwn).map(b => b.id));
  const targets = active.filter(s => (ownIds.size ? ownIds.has(s.brandId) : true) && (!S.filter.division || divisionOf(s) === S.filter.division) && (!S.filter.township || tspKey(s.township) === S.filter.township));
  const R = S.radius, rkm = fmtDist(R);
  const missing = targets.filter(x => getPop(x, R) == null && !S.popFailed.has(popKey(x, R)));
  if (!info && missing.length && canEdit()) $("#pop-status").insertAdjacentHTML("beforeend", ` <button class="btn sm" id="pop-fill">Fill ${missing.length} missing</button>`);
  $("#pop-fill") && ($("#pop-fill").onclick = () => fillPopulation(missing));

  analysisRows = targets.map(s => {
    const nb = neighbours(s, active, S.brandsById);
    const comp = nb.find(n => !n.own);
    const sum = radiusSummary(nb, R);
    const pop = getPop(s, R);
    return {
      _id: s.id, Store: s.name, Brand: S.brandsById[s.brandId]?.name || "",
      "Nearest competitor": comp ? S.brandsById[comp.store.brandId]?.name || "" : "",
      "Distance (m)": comp ? Math.round(comp.d) : null,
      "Competitors in radius": sum.competitors,
      "Competitor sqft in radius": sum.competitorSqft || null,
      "Own stores in radius": sum.ownOthers,
      "Size (sqft)": s.sizeSqft || null,
      "Rating": s.rating || null, "Reviews": s.ratingCount ?? null,
      "Competitor reviews in radius": sum.competitorReviews || null,
      "Population in radius": pop == null ? null : Math.round(pop),
      "Pop per store": pop == null ? null : Math.round(pop / (sum.competitors + sum.ownOthers + 1)),
    };
  });
  analysisRows.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
  });

  const cols = Object.keys(analysisRows[0] || { Store: 1 }).filter(k => k !== "_id");
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
  if (!store) ["name", "address", "township", "city", "sizeSqft", "seats", "notes", "mapsLink", "type", "phone", "rating", "ratingCount", "division"].forEach(k => { if (!(k in preset)) f[k].value = ""; });
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
  const me = S.api.user?.uid;
  const editable = m => isAdmin() && m.role !== "owner" && m.id !== me;
  $("#member-list").innerHTML = list.map(m => `<li style="cursor:default"><div class="main"><div class="t">${esc(m.email)}${m.id === me ? ' <span class="muted small">(you)</span>' : ""}</div></div>
    ${editable(m) ? `<select data-role="${m.id}" style="width:auto;padding:4px 6px;font-size:12px">${["admin", "editor", "viewer"].map(r => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>
      <button class="btn sm ghost" data-remove="${m.id}" title="Remove">✕</button>` : `<span class="pill">${esc(m.role)}</span>`}</li>`).join("");
  $("#member-list").querySelectorAll("[data-role]").forEach(sel => (sel.onchange = () =>
    S.api.team("role", { uid: sel.dataset.role, role: sel.value }).then(() => toast("Role updated"), x => { toast(x.message, 5000); renderMembers(); })));
  $("#member-list").querySelectorAll("[data-remove]").forEach(b => (b.onclick = () => {
    const m = list.find(x => x.id === b.dataset.remove);
    if (!confirm(`Remove ${m.email} from this workspace?`)) return;
    S.api.team("remove", { uid: m.id }).then(() => { toast("Removed"); renderMembers(); }, x => toast(x.message, 5000));
  }));
}

/* =========================================================== WIRING */
function wireUI() {
  document.querySelectorAll(".tab").forEach(t => (t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tabpane").forEach(p => (p.hidden = p.id !== "tab-" + t.dataset.tab));
    if (t.dataset.tab === "settings") { renderMembers(); renderAISettings(); }
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
    let parsed;
    try { parsed = await parseFile(file); } catch (x) { return alert("Could not read that file: " + x.message); }
    if (!parsed.rows.length) return alert("No importable rows.\n\n" + parsed.errors.join("\n"));
    importDialog(parsed);
  };

  // Store dialog
  const f = $("#store-form");
  f.mapsLink.oninput = () => { const c = coordsFromLink(f.mapsLink.value); if (c) { f.lat.value = c.lat; f.lng.value = c.lng; } };
  $("#store-dialog").addEventListener("close", async () => {
    if ($("#store-dialog").returnValue !== "save") return;
    const v = Object.fromEntries(new FormData(f));
    delete v.mapsLink;
    const data = { ...v, lat: +v.lat, lng: +v.lng, sizeSqft: v.sizeSqft ? +v.sizeSqft : null, seats: v.seats ? +v.seats : null,
      rating: v.rating ? Math.min(5, +v.rating) : null, ratingCount: v.ratingCount !== "" && v.ratingCount != null ? +v.ratingCount : null };
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
  const genPw = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 55]).join("");
  $("#invite-form").password.value = genPw();
  $("#invite-form").onsubmit = async e => { e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    $("#invite-msg").textContent = "";
    try {
      const r = await busy(e.submitter, "Adding…", () => S.api.team("add", v));
      $("#invite-msg").innerHTML = `✔ Added. Send this to ${esc(v.email)}:<br><code style="white-space:pre-wrap">${esc(location.origin)}\nEmail: ${esc(v.email)}${r.created ? `\nPassword: ${esc(v.password)}` : "\n(they already had a login — use their existing password)"}</code>`;
      f.reset(); f.password.value = genPw(); renderMembers();
    } catch (x) { $("#invite-msg").textContent = x.message; } };

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

  wireAI();
  wireSearch();
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (S.placing) stopPlacing(); if (S.measure.on) toggleMeasure(false); $("#export-menu").hidden = true; } });
  $("#measure-btn").onclick = () => toggleMeasure(!S.measure.on);
  $("#measure-clear").onclick = clearMeasures;

  // Map export (JPG / PDF)
  $("#logo-toggle").checked = S.showLogos;
  $("#logo-toggle").onchange = e => { S.showLogos = e.target.checked; try { localStorage.setItem("sr-logos", S.showLogos ? "1" : "0"); } catch {} renderMarkers(); };
  $("#export-map-btn").onclick = e => { e.stopPropagation(); $("#export-menu").hidden = !$("#export-menu").hidden; };
  document.addEventListener("click", e => { if (!e.target.closest(".map-export")) $("#export-menu").hidden = true; });
  $("#export-menu").onclick = e => { const b = e.target.closest("button[data-fmt]"); if (b) exportMap(b.dataset.fmt, +b.dataset.size); };
}

/* =========================================================== FILTER BAR */
function renderFilterBar() {
  const count = (list, key) => list.reduce((m, s) => { const k = key(s); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const f = S.filter;
  const byBrand = count(S.stores, s => s.brandId);
  $("#f-brand").innerHTML = `<option value="">All brands</option>` + S.brands.map(b => `<option value="${b.id}" ${f.brand === b.id ? "selected" : ""}>${esc(b.name)} (${byBrand[b.id] || 0})</option>`).join("");
  const inBrand = S.stores.filter(s => !f.brand || s.brandId === f.brand);
  const byDiv = count(inBrand, divisionOf);
  const divs = [...new Set([...DIVISIONS.filter(d => byDiv[d]), ...Object.keys(byDiv)])];
  $("#f-division").innerHTML = `<option value="">All divisions</option>` + divs.map(d => `<option value="${esc(d)}" ${f.division === d ? "selected" : ""}>${esc(d)} (${byDiv[d]})</option>`).join("") +
    (inBrand.some(s => !divisionOf(s)) ? `<option value="" disabled>— ${inBrand.filter(s => !divisionOf(s)).length} without division —</option>` : "");
  const inDiv = inBrand.filter(s => !f.division || divisionOf(s) === f.division);
  const byTsp = {}, label = {};
  inDiv.forEach(s => { const k = tspKey(s.township); if (!k) return; byTsp[k] = (byTsp[k] || 0) + 1; label[k] = label[k] || s.township.trim(); });
  $("#f-township").innerHTML = `<option value="">All townships</option>` + Object.keys(byTsp).sort((a, b) => label[a].localeCompare(label[b]))
    .map(k => `<option value="${esc(k)}" ${f.township === k ? "selected" : ""}>${esc(label[k])} (${byTsp[k]})</option>`).join("");
  ["brand", "division", "township"].forEach(k => $("#f-" + k).classList.toggle("on", !!f[k]));
  const any = f.brand || f.division || f.township;
  $("#f-clear").hidden = !any;
  $("#f-count").textContent = any ? `Showing ${visibleStores().length} of ${S.stores.length} stores` : `${S.stores.length} stores`;
  $("#division-list").innerHTML = DIVISIONS.map(d => `<option value="${d}">`).join("");
}

function setFilter(patch, fit = true) {
  Object.assign(S.filter, patch);
  if ("division" in patch && !("township" in patch)) S.filter.township = "";
  if ("brand" in patch && S.filter.brand) S.hidden.delete(S.filter.brand);
  const sel = S.stores.find(x => x.id === S.selectedId);
  if (sel && !passes(sel)) S.selectedId = null;                 // don't keep a filtered-out store open
  renderAll();
  const pts = visibleStores().map(s => [s.lat, s.lng]);
  if (fit && pts.length && (S.filter.brand || S.filter.division || S.filter.township)) S.map.fitBounds(pts, { padding: [50, 50], maxZoom: 15 });
}

/* =========================================================== UNIVERSAL SEARCH */
function wireSearch() {
  const q = $("#usearch-q"), box = $("#usearch-results");
  let items = [], active = -1, geoTimer, geoSeq = 0;
  $("#f-brand").onchange = e => setFilter({ brand: e.target.value });
  $("#f-division").onchange = e => setFilter({ division: e.target.value });
  $("#f-township").onchange = e => setFilter({ township: e.target.value });
  $("#f-clear").onclick = () => setFilter({ brand: "", division: "", township: "" }, false);

  const icon = t => ({ store: "📍", brand: "🏷️", township: "🏘️", division: "🗺️", city: "🏙️", place: "🌐" }[t] || "•");
  const render = () => {
    if (!q.value.trim()) { box.hidden = true; return; }
    const groups = { store: "Stores", brand: "Brands", township: "Townships", city: "Cities", division: "Divisions", place: "Places on the map" };
    let html = "", i = 0;
    for (const g of Object.keys(groups)) {
      const list = items.filter(x => x.type === g);
      if (!list.length) continue;
      html += `<div class="us-group">${groups[g]}</div>` + list.map(x => `<button class="us-item ${i === active ? "active" : ""}" data-i="${i++}">
        <span class="us-ico">${x.mark || icon(x.type)}</span><span class="main"><div class="t">${esc(x.title)}</div>${x.sub ? `<div class="s">${esc(x.sub)}</div>` : ""}</span></button>`).join("");
    }
    if (S.geoLoading) html += `<div class="us-empty">Searching the map…</div>`;
    box.innerHTML = html || `<div class="us-empty">No matches.</div>`;
    box.hidden = false;
  };
  const localSearch = text => {
    const t = text.toLowerCase(), has = v => String(v || "").toLowerCase().includes(t), out = [];
    const bn = id => S.brandsById[id]?.name || "";
    S.stores.filter(s => [s.name, s.address, s.township, s.city, divisionOf(s), s.phone, s.notes, s.placeId, bn(s.brandId)].some(has))
      .sort((a, b) => (+!!S.brandsById[b.brandId]?.isOwn) - (+!!S.brandsById[a.brandId]?.isOwn) || (b.ratingCount || 0) - (a.ratingCount || 0)).slice(0, 8)
      .forEach(s => out.push({ type: "store", id: s.id, title: s.name, sub: [bn(s.brandId), s.township, s.city, s.rating ? `⭐${s.rating}` : ""].filter(Boolean).join(" · "), mark: mark(S.brandsById[s.brandId], 10) }));
    S.brands.filter(b => [b.name, ...(b.aliases || [])].some(has)).slice(0, 5)
      .forEach(b => out.push({ type: "brand", id: b.id, title: b.name, sub: `${S.stores.filter(s => s.brandId === b.id).length} stores`, mark: mark(b, 10) }));
    const tsp = {}, city = {}, div = {};
    S.stores.forEach(s => {
      if (has(s.township)) { const k = tspKey(s.township); tsp[k] = tsp[k] || { n: 0, label: s.township.trim(), div: divisionOf(s) }; tsp[k].n++; }
      if (has(s.city)) { const k = s.city.trim(); city[k] = (city[k] || 0) + 1; }
      const d = divisionOf(s); if (d && has(d)) div[d] = (div[d] || 0) + 1;
    });
    Object.entries(tsp).slice(0, 5).forEach(([k, v]) => out.push({ type: "township", id: k, div: v.div, title: v.label, sub: `${v.n} stores${v.div ? " · " + v.div : ""}` }));
    Object.entries(city).slice(0, 3).forEach(([k, n]) => out.push({ type: "city", id: k, title: k, sub: `${n} stores` }));
    Object.entries(div).slice(0, 3).forEach(([k, n]) => out.push({ type: "division", id: k, title: k, sub: `${n} stores` }));
    return out;
  };
  // Any place in Myanmar (OpenStreetMap Nominatim — free, low volume, 1 request after typing stops)
  const geoSearch = text => {
    clearTimeout(geoTimer);
    if (text.length < 3) { S.geoLoading = false; return; }
    const seq = ++geoSeq; S.geoLoading = true;
    geoTimer = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=mm&limit=5&accept-language=en&q=${encodeURIComponent(text)}`);
        const j = r.ok ? await r.json() : [];
        if (seq !== geoSeq) return;
        items = items.filter(x => x.type !== "place").concat(j.map(p => ({ type: "place", lat: +p.lat, lng: +p.lon, title: p.name || p.display_name.split(",")[0], sub: p.display_name.split(",").slice(1, 4).join(",").trim() })));
      } catch {}
      if (seq === geoSeq) { S.geoLoading = false; render(); }
    }, 600);
  };
  const choose = x => {
    box.hidden = true; q.blur();
    if (x.type === "store") {
      const s = S.stores.find(z => z.id === x.id); if (!s) return;
      if (!passes(s) || S.hidden.has(s.brandId)) { S.hidden.delete(s.brandId); S.filter = { brand: "", division: "", township: "" }; renderAll(); }
      selectStore(x.id);
    } else if (x.type === "brand") setFilter({ brand: x.id });
    else if (x.type === "township") setFilter({ division: x.div || "", township: x.id });
    else if (x.type === "division") setFilter({ division: x.id });
    else if (x.type === "city") { const pts = S.stores.filter(s => (s.city || "").trim() === x.id).map(s => [s.lat, s.lng]); if (pts.length) S.map.fitBounds(pts, { padding: [50, 50], maxZoom: 15 }); }
    else if (x.type === "place") {
      S.map.setView([x.lat, x.lng], 16);
      S.searchPin?.remove();
      S.searchPin = L.circleMarker([x.lat, x.lng], { radius: 10, color: "#e11d48", weight: 3, fillColor: "#fff", fillOpacity: .9 }).addTo(S.map)
        .bindTooltip(x.title, { permanent: true, direction: "top", offset: [0, -8] });
      setTimeout(() => { S.searchPin?.remove(); S.searchPin = null; }, 15000);
    }
  };
  q.addEventListener("input", () => { active = -1; items = q.value.trim() ? localSearch(q.value.trim()) : []; geoSearch(q.value.trim()); render(); });
  q.addEventListener("focus", () => { if (q.value.trim()) render(); });
  q.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1))); render(); }
    else if (e.key === "Enter") { e.preventDefault(); const x = items[active >= 0 ? active : 0]; if (x) choose(x); }
    else if (e.key === "Escape") { box.hidden = true; q.blur(); }
  });
  box.addEventListener("mousedown", e => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); choose(items[+b.dataset.i]); } });
  document.addEventListener("click", e => { if (!e.target.closest("#usearch")) box.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); } });
}

/* =========================================================== SERVER FEATURES */
// Google Places search needs the platform's PLACES_API_KEY. Hide it when that isn't set, so people use the AI finder instead.
async function checkFeatures() {
  if (S.api.mode === "demo") return;
  try {
    const r = await fetch("/api/config");
    const c = r.ok ? await r.json() : {};
    $("#places-block").hidden = !c.places;
  } catch { $("#places-block").hidden = true; }
}

/* =========================================================== VERIFICATION BADGE */
// Accounts are verified manually by the platform admin (no automatic email). Until then, show a badge.
async function checkVerified() {
  if (S.api.mode === "demo") return;
  const ok = await S.api.isVerified();
  $("#unverified-badge").hidden = ok;
  if (!ok) $("#unverified-badge").onclick = () => toast("Your account is awaiting verification by the StoreRadar team. Contact us to speed it up.", 5000);
}

/* =========================================================== BUSINESS PROFILE */
const REQUIRED = ["contactName", "jobTitle", "phone", "contactEmail", "industry"];

/** Workspaces created before the business form existed (or with gaps) are asked to complete it once. */
async function checkProfile() {
  S.lastProfileCheck = Date.now();
  if (S.api.mode === "demo") return;
  if (!isAdmin()) return checkProfileBanner();
  let org;
  try { org = await S.api.loadOrgDoc(); } catch { return; }
  const p = org.profile || {};
  if (REQUIRED.every(k => String(p[k] ?? "").trim())) return;
  const f = $("#profile-form"), d = $("#profile-dialog");
  for (const el of f.elements) if (el.name && el.name in p) el.value = Array.isArray(p[el.name]) ? p[el.name].join(", ") : p[el.name] ?? "";
  if (!f.contactEmail.value) f.contactEmail.value = S.api.user?.email || "";
  d.addEventListener("cancel", e => e.preventDefault());            // required: Esc can't skip it
  f.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const list = x => String(x || "").split(",").map(t => t.trim()).filter(Boolean).slice(0, 20);
    const profile = { ...p, contactName: v.contactName.trim(), jobTitle: v.jobTitle.trim(), phone: v.phone.trim(), contactEmail: v.contactEmail.trim(),
      industry: v.industry, branches: +v.branches || 0, cities: list(v.cities), website: v.website.trim(), competitors: list(v.competitors) };
    try { await busy(e.submitter, "Saving…", () => S.api.saveProfile(profile)); d.close(); toast("Business details saved"); }
    catch (x) { $("#profile-error").textContent = x.message; }
  };
  d.showModal();
}

// Members who can't edit the profile still see a reminder banner so they nudge their owner.
async function checkProfileBanner() {
  let org; try { org = await S.api.loadOrgDoc(); } catch { return; }
  const p = org.profile || {};
  if (REQUIRED.every(k => String(p[k] ?? "").trim()) || S.api.org.status === "hold") return;
  $("#status-banner").hidden = false;
  $("#status-banner").textContent = "Your workspace's business details are incomplete — please ask the workspace owner to complete them.";
}

/* =========================================================== AI (bring your own key) */
async function renderAISettings() {
  const f = $("#ai-form");
  f.provider.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("");
  let cfg = {};
  try { cfg = await S.api.getAISettings(); } catch {}
  S.aiCfg = cfg;
  const setModels = () => {
    const p = PROVIDERS[f.provider.value];
    $("#ai-models").innerHTML = p.models.map(m => `<option value="${m}">`).join("");
    $("#ai-key-link").innerHTML = `· <a href="${p.keyUrl}" target="_blank" rel="noopener">get a key</a>`;
  };
  f.provider.value = cfg.provider || "claude"; setModels();
  f.model.value = cfg.model || PROVIDERS[f.provider.value].models[0];
  f.key.value = "";
  f.key.placeholder = cfg.keyHint ? `Saved key ${cfg.keyHint} — paste a new one to replace` : "Paste your API key";
  f.provider.onchange = () => { setModels(); f.model.value = PROVIDERS[f.provider.value].models[0]; };
  $("#ai-view").textContent = cfg.provider ? `Connected: ${PROVIDERS[cfg.provider]?.label} · ${cfg.model}${cfg.keyHint ? " · key " + cfg.keyHint : ""}` : "No key saved yet.";

  const demo = S.api.mode === "demo";
  const mode = demo ? "own" : cfg.mode || (cfg.provider ? "own" : "platform");   // same default as the server
  document.querySelectorAll('input[name="ai-mode"]').forEach(r => { r.checked = r.value === mode; r.disabled = !isAdmin() || (demo && r.value === "platform"); });
  $("#ai-platform").hidden = mode !== "platform";
  f.hidden = mode !== "own" || (!isAdmin() && !demo);
  if (mode === "platform") renderCredits();
}

async function renderCredits() {
  let c;
  try { c = await S.api.getCredits(); } catch (x) { $("#credit-balance").textContent = "—"; $("#ai-offers").textContent = x.message; return; }
  if (!c) return;
  const mmk = n => `${Math.round(n || 0).toLocaleString("en-US")} MMK`;
  $("#credit-balance").textContent = mmk(c.balance);
  $("#credit-balance").style.color = c.balance <= 0 ? "var(--danger)" : "";
  // AI options offered by StoreRadar — the workspace picks one (each has its own price)
  const offers = (Array.isArray(c.pricing?.offers) ? c.pricing.offers : Object.entries(c.pricing?.offers || {}).map(([k, o]) => ({ id: k, ...o })))
    .filter(o => o.enabled);
  const cfg = S.aiCfg || {};
  const chosen = offers.find(o => o.id === cfg.platformProvider)?.id || offers.find(o => o.id === c.pricing?.defaultProvider)?.id || offers[0]?.id;
  $("#ai-offers").innerHTML = offers.length ? offers.map(o => `<label class="ai-mode"><input type="radio" name="ai-offer" value="${esc(o.id)}" ${o.id === chosen ? "checked" : ""} ${isAdmin() ? "" : "disabled"} />
      <span><b>${esc(o.label)}</b><br><span class="muted small">AI insight ${mmk(o.prices?.insight)} · branch search ${mmk(o.prices?.branches)} per use</span></span></label>`).join("") +
      '<p class="muted small">Charged only when the AI answers.</p>'
    : '<p class="muted small">StoreRadar AI options will appear here soon.</p>';
  $("#ai-offers").querySelectorAll('input[name="ai-offer"]').forEach(r => (r.onchange = () =>
    S.api.saveAISettings({ platformProvider: r.value }).then(() => { S.aiCfg = { ...cfg, platformProvider: r.value }; toast(`Using ${offers.find(o => o.id === r.value)?.label}`); }, x => toast(x.message, 5000))));
  const pkgs = c.pricing?.packages?.length ? c.pricing.packages : [{ name: "Starter", mmk: 50000 }, { name: "Growth", mmk: 150000 }];
  $("#credit-packages").innerHTML = isAdmin()
    ? pkgs.map((p, i) => `<div class="pkg"><span><b>${esc(p.name)}</b> · ${mmk(p.mmk)}</span><button class="btn sm" data-pkg="${i}">Request top-up</button></div>`).join("")
    : '<p class="muted small">Ask your workspace owner to top up credits.</p>';
  $("#credit-contact").textContent = c.pricing?.contact || "After requesting, pay by KBZPay / WavePay and send the receipt to your StoreRadar contact. Credits are added once payment is confirmed.";
  $("#credit-pending").innerHTML = c.pending.length
    ? `<p class="small"><span class="pill pending">pending</span> Top-up requested: ${c.pending.map(r => `${esc(r.package)} (${mmk(r.mmk)})`).join(", ")} — waiting for payment confirmation.</p>` : "";
  $("#credit-log").innerHTML = c.log.length
    ? c.log.map(l => `<tr><td>${l.at?.toDate ? l.at.toDate().toLocaleDateString("en-GB") : ""}</td><td>${esc(l.type === "charge" ? "AI " + (l.task || "") : l.type === "topup" ? "Top-up" : "Adjustment")}</td><td>${l.amount > 0 ? "+" : ""}${Math.round(l.amount).toLocaleString("en-US")}</td><td>${Math.round(l.balanceAfter).toLocaleString("en-US")}</td></tr>`).join("")
    : '<tr><td class="muted">No credit activity yet.</td></tr>';
  $("#credit-packages").querySelectorAll("[data-pkg]").forEach(b => (b.onclick = async () => {
    const p = pkgs[+b.dataset.pkg];
    try { await busy(b, "Sending…", () => S.api.requestTopup(p)); toast(`Top-up request for ${p.name} sent. Please pay and send the receipt.`, 5000); renderCredits(); }
    catch (x) { toast(x.message, 5000); }
  }));
}

function wireAI() {
  const f = $("#ai-form"), msg = t => ($("#ai-msg").textContent = t);
  f.onsubmit = async e => {
    e.preventDefault(); msg("");
    try {
      await busy(e.submitter, "Saving…", () => S.api.saveAISettings({ provider: f.provider.value, model: f.model.value.trim(), key: f.key.value.trim() }));
      msg("Saved. Click Test connection to check it."); renderAISettings();
    } catch (x) { msg(x.message); }
  };
  $("#ai-test").onclick = async e => {
    msg("");
    try { const r = await busy(e.target, "Testing…", () => S.api.ai("test")); msg(`✔ Working (${r.mode === "platform" ? "StoreRadar AI" : "your key"}) — model replied "${r.reply}"`); }
    catch (x) { msg("✖ " + x.message); }
  };
  document.querySelectorAll('input[name="ai-mode"]').forEach(r => (r.onchange = async () => {
    msg("");
    try { await S.api.saveAISettings({ mode: r.value }); renderAISettings(); } catch (x) { msg(x.message); }
  }));

  $("#ai-find-form").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $("#ai-find-error").textContent = ""; $("#ai-find-results").innerHTML = "";
    try {
      const r = await busy(e.submitter, "AI is searching (≈30–90 s)…", () => S.api.ai("branches", { brand: fd.get("brand"), area: fd.get("area") }));
      if (r.charged) toast(`Charged ${r.charged.toLocaleString("en-US")} MMK · balance ${Math.round(r.balance).toLocaleString("en-US")} MMK`, 4000);
      S.aiBrand = fd.get("brand").trim();
      S.aiFound = (r.items || []).filter(i => i && (i.name || i.address)).map(i => {
        let lat = +i.lat, lng = +i.lng;
        if (!(isFinite(lat) && isFinite(lng) && lat && lng)) { const c = coordsFromLink(i.mapsUrl); lat = c?.lat; lng = c?.lng; }
        const has = isFinite(lat) && isFinite(lng);
        return { ...i, lat: has ? lat : null, lng: has ? lng : null, pick: has, dup: has && S.stores.some(s => distance(s, { lat, lng }) < 40) };
      });
      S.aiSources = r.sources || [];
      renderAIFind();
    } catch (x) { $("#ai-find-error").textContent = x.message; }
  };
}

function renderAIFind() {
  const box = $("#ai-find-results"), list = S.aiFound || [];
  if (!list.length) { box.innerHTML = '<p class="muted small">The AI found no branches with a source. Try a different spelling or area.</p>'; return; }
  const existing = S.brands.find(b => [b.name, ...(b.aliases || [])].some(n => n.toLowerCase() === S.aiBrand.toLowerCase()));
  const placed = list.filter(i => i.lat != null).length;
  box.innerHTML = `<div class="row between small"><span>${list.length} found · ${placed} with location</span>
      <button class="btn sm primary" id="ai-add">Add ticked as pending</button></div>
    <p class="small muted">Brand: <b>${esc(existing?.name || S.aiBrand)}</b>${existing ? "" : " (will be created)"}. AI results can be wrong — verify each one.</p>` +
    list.map((i, k) => `<div class="result ${i.dup ? "dup" : ""}">
      <input type="checkbox" data-k="${k}" ${i.pick && !i.dup ? "checked" : ""} ${i.lat == null || i.dup ? "disabled" : ""} />
      <div class="main"><b>${esc(i.name || "(no name)")}</b>${i.status && i.status !== "open" ? ` <span class="pill">${esc(i.status)}</span>` : ""}
        <div class="muted small">${esc([i.address, i.township, i.city].filter(Boolean).join(", "))}</div>
        ${i.dup ? '<div class="small muted">Already on map</div>' : i.lat == null ? `<input class="maps" data-maps="${k}" placeholder="Paste Google Maps link to place it" />` : `<div class="small muted">📍 ${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}</div>`}
        ${i.source ? `<a class="src" href="${esc(i.source)}" target="_blank" rel="noopener">source</a>` : ""}
      </div></div>`).join("") +
    (S.aiSources?.length ? `<div class="ai-src"><b class="muted">Searched:</b>${S.aiSources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`).join("")}</div>` : "");
  box.querySelectorAll("[data-maps]").forEach(inp => (inp.oninput = () => {
    const c = coordsFromLink(inp.value); if (!c) return;
    Object.assign(list[+inp.dataset.maps], { lat: c.lat, lng: c.lng, pick: true }); renderAIFind();
  }));
  box.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.onchange = () => (list[+cb.dataset.k].pick = cb.checked)));
  $("#ai-add").onclick = async e => {
    const add = list.filter(i => i.pick && !i.dup && i.lat != null);
    if (!add.length) return toast("Tick at least one branch that has a location.");
    await busy(e.target, "Adding…", async () => {
      const brandId = existing?.id || await S.api.add("brands", { name: S.aiBrand, color: randomColor(), isOwn: false, aliases: [] });
      await S.api.bulkAdd("stores", add.map(i => ({
        brandId, name: i.name || `${S.aiBrand} ${i.township || ""}`.trim(), lat: i.lat, lng: i.lng, address: i.address || "",
        township: i.township || "", city: i.city || "", status: "pending", source: "ai", notes: i.source ? `AI source: ${i.source}` : "AI",
        sizeSqft: null, seats: null, type: "",
      })));
    });
    toast(`Added ${add.length} branches as pending.`); S.aiFound = []; renderAIFind(); $("#ai-find-results").innerHTML = "";
  };
}

async function runInsight(s, nb, sum, pop, btn) {
  const out = $("#ai-insight");
  const bName = id => S.brandsById[id]?.name || "?";
  const stats = {
    store: { name: s.name, brand: bName(s.brandId), ours: !!S.brandsById[s.brandId]?.isOwn, township: s.township, city: s.city, sizeSqft: s.sizeSqft, seats: s.seats, type: s.type, googleRating: s.rating || null, googleReviews: s.ratingCount ?? null },
    competitorGoogleReviewsInRadius: sum.competitorReviews || null, competitorAvgRatingInRadius: sum.competitorRating || null,
    radiusMeters: S.radius,
    competitorsInRadius: sum.competitors, competitorsByBrand: Object.fromEntries(Object.entries(sum.byBrand).map(([k, v]) => [bName(k), v])),
    competitorSqftInRadius: sum.competitorSqft || null, ownOtherStoresInRadius: sum.ownOthers,
    nearest: nb.slice(0, 6).map(n => ({ brand: bName(n.store.brandId), name: n.store.name, meters: Math.round(n.d), sizeSqft: n.store.sizeSqft || null, rating: n.store.rating || null, reviews: n.store.ratingCount ?? null, ours: n.own })),
    populationInRadius: pop == null ? null : Math.round(pop),
    populationPerStoreInRadius: pop == null ? null : Math.round(pop / (sum.competitors + sum.ownOthers + 1)),
    areaActivityOSM: S.lastPoi?.id === s.id && S.lastPoi.radius === S.radius ? S.lastPoi.counts : null,
  };
  out.innerHTML = "";
  try {
    const r = await busy(btn, "Thinking…", () => S.api.ai("insight", { stats, lang: $("#ai-lang").value }));
    if (r.charged) toast(`Charged ${r.charged.toLocaleString("en-US")} MMK · balance ${Math.round(r.balance).toLocaleString("en-US")} MMK`, 4000);
    out.innerHTML = `<div class="ai-out">${esc(r.text)}</div><div class="row gap" style="margin-top:6px"><button class="btn sm ghost" id="ai-copy">Copy</button></div>`;
    $("#ai-copy").onclick = () => navigator.clipboard.writeText(r.text).then(() => toast("Copied"));
  } catch (x) { out.innerHTML = `<p class="error">${esc(x.message)}</p>`; }
}

/* =========================================================== POPULATION (auto) */
const popKey = (s, r) => `${s.id}:${r}`;

/** Offline grid if present, else the WorldPop value cached on the store (pop[radius]). */
function getPop(s, r) {
  const g = populationWithin(s, r);
  if (g != null) return g;
  const c = s.pop?.[String(r)];
  // cache is only valid if the store hasn't moved since it was computed
  return c && Math.abs(c.lat - s.lat) < 1e-6 && Math.abs(c.lng - s.lng) < 1e-6 ? c.v : null;
}

async function fetchPop(s, r) {
  let v;
  try { v = await worldpopDirect(s, r); }
  catch (x) { if (x instanceof TypeError) v = await S.api.popStats(s.lat, s.lng, r); else throw x; } // CORS → Cloud Function
  const cur = S.stores.find(x => x.id === s.id) || s;
  const pop = { ...(cur.pop || {}), [String(r)]: { v: Math.round(v), lat: s.lat, lng: s.lng, year: WORLDPOP_YEAR } };
  if (canEdit()) await S.api.update("stores", s.id, { pop });
  else Object.assign(cur, { pop });                       // viewers: keep in memory only
  return v;
}

function autoPop(s, r) {
  const k = popKey(s, r);
  if (popGridInfo() || S.popBusy.has(k) || S.popFailed.has(k)) return;
  S.popBusy.add(k);
  fetchPop(s, r)
    .catch(x => { S.popFailed.add(k); console.warn("WorldPop", x); })
    .finally(() => { S.popBusy.delete(k); if (S.selectedId === s.id) renderDetail(); renderAnalysis(); });
}

async function fillPopulation(list) {
  const btn = $("#pop-fill"); if (btn) btn.disabled = true;
  let ok = 0, fail = 0;
  for (const [i, s] of list.entries()) {
    if (btn) btn.textContent = `Fetching ${i + 1}/${list.length}…`;
    const k = popKey(s, S.radius);
    S.popBusy.add(k);
    try { await fetchPop(s, S.radius); ok++; } catch { S.popFailed.add(k); fail++; }
    S.popBusy.delete(k);
    await new Promise(r => setTimeout(r, 300));            // be polite to the free API
  }
  toast(`Population filled for ${ok} stores${fail ? `, ${fail} failed` : ""}.`, 4000);
  renderAnalysis(); renderDetail();
}

/* =========================================================== MEASURE */
function toggleMeasure(on) {
  S.measure.on = on; S.measure.pts = [];
  S.measure.temp?.remove(); S.measure.temp = null;
  $("#measure-btn").classList.toggle("active", on);
  $("#map").style.cursor = on ? "crosshair" : "";
  if (on) { stopPlacing(); toast("Click a store (or anywhere), then a second one. Esc to finish.", 3500); }
}

function measureClick(p) {
  const pt = { lat: p.lat, lng: p.lng, name: p.name || "" };
  if (!S.measure.pts.length) {
    S.measure.pts.push(pt);
    S.measure.temp = L.circleMarker([pt.lat, pt.lng], { radius: 7, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(S.map);
    return;
  }
  const a = S.measure.pts[0];
  S.measure.pts = []; S.measure.temp?.remove(); S.measure.temp = null;
  addMeasure(a, pt, false);
}

function addMeasure(a, b, fit) {
  const d = distance(a, b);
  const item = { a: { lat: a.lat, lng: a.lng, name: a.name }, b: { lat: b.lat, lng: b.lng, name: b.name }, d, road: null, text: `${fmtDist(d)} straight` };
  const grp = L.layerGroup().addTo(S.measure.layer);
  L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: "#111", weight: 2.5, dashArray: "6 6", interactive: false }).addTo(grp);
  [a, b].forEach(p => L.circleMarker([p.lat, p.lng], { radius: 5, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(grp));
  const mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
  const tip = L.tooltip({ permanent: true, direction: "top", className: "measure-tip", interactive: true }).setLatLng(mid);
  const html = () => `<b>${fmtDist(item.d)}</b> straight${item.road ? ` · <b>${fmtDist(item.road.meters)}</b> by road · ~${fmtDur(item.road.seconds)}` : item.roadErr ? "" : " · <i>road…</i>"}` +
    (a.name && b.name ? `<div class="mt-names">${esc(a.name)} → ${esc(b.name)}</div>` : "") + ` <button class="mt-x" title="Remove">✕</button>`;
  tip.setContent(html()).addTo(grp);
  item.grp = grp; S.measure.items.push(item);
  $("#measure-clear").hidden = false;
  const bind = () => tip.getElement()?.querySelector(".mt-x")?.addEventListener("click", ev => { ev.stopPropagation(); removeMeasure(item); });
  bind();
  if (fit) S.map.fitBounds([[a.lat, a.lng], [b.lat, b.lng]], { padding: [80, 80], maxZoom: 16 });
  roadRoute(a, b).then(r => {
    item.road = r;
    item.text = `${fmtDist(d)} straight · ${fmtDist(r.meters)} by road · ~${fmtDur(r.seconds)}`;
    L.polyline(r.path, { color: "#0ea5e9", weight: 5, opacity: 0.75, interactive: false }).addTo(grp);
  }).catch(() => { item.roadErr = true; })
    .finally(() => { tip.setContent(html()); bind(); });
}

function removeMeasure(item) {
  item.grp.remove();
  S.measure.items = S.measure.items.filter(x => x !== item);
  $("#measure-clear").hidden = !S.measure.items.length;
}
function clearMeasures() { S.measure.items.forEach(i => i.grp.remove()); S.measure.items = []; $("#measure-clear").hidden = true; }

/* =========================================================== MAP EXPORT */
async function exportMap(fmt, longSide) {
  $("#export-menu").hidden = true;
  if (TILES.maxExport && longSide > TILES.maxExport) {
    toast(`Free OpenStreetMap tiles are limited to ${TILES.maxExport}px exports — add a MapTiler key in firebase-config.js for print size.`, 6000);
    longSide = TILES.maxExport;
  }
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
      const comp = nb.find(n => !n.own), sum = radiusSummary(nb, S.radius), pop = getPop(sel, S.radius);
      selectedLine = `${sel.name}: nearest competitor ${comp ? fmtDist(comp.d) + " (" + (S.brandsById[comp.store.brandId]?.name || "") + ")" : "—"}` +
        ` · ${sum.competitors} competitor stores within ${fmtDist(S.radius)}` + (pop != null ? ` · ~${fmtNum(pop)} residents` : "") +
        (sel.sizeSqft ? ` · ${fmtNum(sel.sizeSqft)} sqft` : "");
    }
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const canvas = await renderMapCanvas({
      map: S.map, stores, brandsById: S.brandsById, selected: sel, showLogos: S.showLogos, measures: S.measure.items.map(m => ({ a: m.a, b: m.b, path: m.road?.path, label: m.text })), radius: S.radius, longSide, selectedLine,
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

/* =========================================================== EXCEL IMPORT */
function importDialog({ rows, errors, hasBrand, columns }) {
  const d = document.createElement("dialog");
  const brandOpts = S.brands.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  d.innerHTML = `<form method="dialog" class="stack">
    <h3>Import ${rows.length} stores</h3>
    <p class="muted small">Columns found: ${columns.map(c => `<code>${esc(c)}</code>`).join(" ")}</p>
    ${hasBrand ? "" : `
      <label>Which brand are these stores?
        <select name="brand">${brandOpts}<option value="__new" ${S.brands.length ? "" : "selected"}>+ New brand…</option></select></label>
      <input name="newBrand" placeholder="New brand name, e.g. Pizza Hut" ${S.brands.length ? "hidden" : ""} />
      <label class="small" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="auto" checked />
        Auto-detect the brand from the store name when it matches one of your brands (e.g. “Pizza Hut Hledan” → Pizza Hut)</label>`}
    <p class="small" id="imp-summary"></p>
    ${errors.length ? `<details><summary class="small">${errors.length} row(s) skipped</summary><div class="small muted">${errors.slice(0, 30).map(esc).join("<br>")}</div></details>` : ""}
    <div class="row gap" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Import</button></div>
  </form>`;
  document.body.appendChild(d);
  const f = d.querySelector("form");
  // brand for each row → then drop rows already on the map (same Google place ID, or same brand within 40 m)
  const plan = () => {
    const byName = Object.fromEntries(S.brands.map(b => [b.name.toLowerCase(), b.id]));
    const fallback = hasBrand ? null : f.brand.value === "__new" ? "new:" + (f.newBrand.value.trim() || "Imported") : f.brand.value;
    const out = rows.map(r => {
      let brandId = r.brand ? byName[r.brand.toLowerCase()] || "new:" + r.brand : null;
      if (!brandId && !hasBrand && f.auto?.checked) brandId = matchBrand(r.name, S.brands);
      return { ...r, brandId: brandId || fallback };
    });
    const dup = r => S.stores.some(s => (r.placeId && s.placeId === r.placeId) || (s.brandId === r.brandId && distance(s, r) < 40));
    const fresh = [];
    for (const r of out)                                  // also drop repeats inside the same file
      if (!dup(r) && !fresh.some(x => (r.placeId && x.placeId === r.placeId) || (x.brandId === r.brandId && distance(x, r) < 40))) fresh.push(r);
    const skipped = out.length - fresh.length;
    const newBrands = [...new Set(fresh.map(r => r.brandId).filter(b => b?.startsWith("new:")).map(b => b.slice(4)))];
    const auto = hasBrand ? 0 : fresh.filter(r => r.brandId !== fallback).length;
    $("#imp-summary").innerHTML = `<b>${fresh.length}</b> will be added` + (skipped ? ` · <b>${skipped}</b> duplicates skipped (already on the map or repeated in the file)` : "") +
      (auto ? ` · ${auto} matched to a brand by name` : "") + (newBrands.length ? `<br>New brand: ${newBrands.map(esc).join(", ")}` : "") +
      (rows.some(r => r.ratingCount != null) ? `<br>Google rating &amp; review counts included.` : "");
    return { fresh, newBrands };
  };
  if (!hasBrand) {
    f.brand.onchange = () => { f.newBrand.hidden = f.brand.value !== "__new"; plan(); };
    f.newBrand.oninput = plan; f.auto.onchange = plan;
  }
  plan();
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok";
    const { fresh, newBrands } = plan();
    d.remove();
    if (!ok || !fresh.length) return;
    try {
      const ids = {};
      for (const n of newBrands) ids["new:" + n] = await S.api.add("brands", { name: n, color: randomColor(), isOwn: false, aliases: [] });
      await S.api.bulkAdd("stores", fresh.map(({ brand, brandId, ...r }) => ({ ...r, brandId: ids[brandId] || brandId, source: "excel" })));
      toast(`Imported ${fresh.length} stores.`);
      S.map.fitBounds(fresh.map(r => [r.lat, r.lng]), { padding: [40, 40], maxZoom: 15 });
    } catch (x) { alert("Import failed: " + x.message); }
  });
  d.showModal();
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
