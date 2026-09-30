// Platform admin console (you only). All privileged work happens in /api/admin, which checks SUPER_ADMIN_EMAILS.
import { firebaseConfig, apiBase } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toast = (m, ms = 2800) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms); };
const date = s => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const ago = s => { if (!s) return "never"; const d = (Date.now() - new Date(s)) / 864e5; return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)} d ago`; };

const A = { auth: null, m: null, orgs: [], users: [] };

(async () => {
  const [app, auth] = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-auth.js")]);
  A.m = auth;
  A.auth = auth.getAuth(app.initializeApp(firebaseConfig));
  auth.onAuthStateChanged(A.auth, async u => {
    if (!u) { $("#login").hidden = false; $("#admin").hidden = true; return; }
    $("#me").textContent = u.email;
    try { await loadOrgs(); $("#login").hidden = true; $("#admin").hidden = false; }
    catch (x) {
      $("#login").hidden = false; $("#admin").hidden = true; $("#login-error").textContent = x.message;
      // Password accounts must verify their email before they can be admin
      if (/not verified/i.test(x.message) && !u.emailVerified) {
        $("#verify-box").hidden = false;
        $("#verify-btn").onclick = () => auth.sendEmailVerification(u)
          .then(() => ($("#login-error").textContent = `Verification email sent to ${u.email}. Click the link in it (check spam), then come back and press "I've verified".`))
          .catch(e => ($("#login-error").textContent = e.message));
        $("#verified-btn").onclick = async () => { await u.reload(); await u.getIdToken(true); location.reload(); };
      }
    }
  });
  $("#pw-form").onsubmit = e => { e.preventDefault(); const f = e.target; auth.signInWithEmailAndPassword(A.auth, f.email.value, f.password.value).catch(x => ($("#login-error").textContent = x.code === "auth/invalid-credential" ? "Wrong email or password." : x.message)); };
  $("#signout").onclick = () => auth.signOut(A.auth);
  $("#login-signout").onclick = () => auth.signOut(A.auth).then(() => { $("#verify-box").hidden = true; $("#login-error").textContent = ""; });
  $("#forgot").onclick = () => {
    const email = $("#pw-form").email.value.trim();
    if (!email) return ($("#login-error").textContent = "Type your email first.");
    auth.sendPasswordResetEmail(A.auth, email).then(() => ($("#login-error").textContent = `Password reset email sent to ${email} (check spam).`)).catch(e => ($("#login-error").textContent = e.message));
  };
  wire();
})();

async function api(action, body = {}) {
  const token = await A.auth.currentUser.getIdToken();
  const r = await fetch(`${apiBase || "/api"}/admin`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}

/* ------------------------------------------------------------ workspaces */
async function loadOrgs() {
  // Show the last result instantly (this browser only), then refresh from the server
  if (!A.orgs.length) {
    try { const c = JSON.parse(sessionStorage.getItem("sr-admin-overview") || "null"); if (c) { A.orgs = c.orgs; A.pricing = c.pricing; A.platformAI = c.platformAI; renderKpis(); renderOrgs(); } } catch {}
    if (!A.orgs.length) $("#orgs").innerHTML = '<div class="org-grid">' + '<div class="org-card skeleton"></div>'.repeat(3) + "</div>";
  }
  const r = await api("overview");
  api("users").then(u => { A.users = u.users; renderKpis(); if (!$("#tab-users").hidden) renderUsers(); }).catch(() => {});
  try { sessionStorage.setItem("sr-admin-overview", JSON.stringify(r)); } catch {}
  A.orgs = r.orgs; A.pricing = r.pricing; A.platformAI = r.platformAI; A.loaded = true;
  renderKpis(); renderOrgs();
}

function renderKpis() {
  const o = A.orgs, count = st => o.filter(x => x.status === st).length;
  const stores = o.reduce((a, x) => a + x.stores, 0), users = new Set(o.flatMap(x => x.members.map(m => m.uid))).size;
  const unused = o.filter(x => !x.inUse).length, reqs = o.reduce((a, x) => a + (x.requests?.length || 0), 0);
  const newWeek = o.filter(x => x.createdAt && Date.now() - new Date(x.createdAt) < 7 * 864e5).length;
  $("#kpis").innerHTML = [
    [o.length, "Workspaces"], [count("active"), "Active"], [count("hold"), "On hold"], [count("blocked"), "Blocked"],
    [users, "Members"], ...(A.users.length ? [[A.users.length, "Login accounts"], [A.users.filter(u => !u.orgId || !o.some(x => x.id === u.orgId)).length, "Logins without workspace"]] : []), ...(unused ? [[unused, "Not in use (duplicates?)"]] : []), ...(reqs ? [[reqs, "Top-up requests"]] : []), [stores.toLocaleString(), "Stores mapped"], [newWeek, "New this week"],
  ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("");
}

function renderOrgs() {
  const box = $("#orgs");
  const open = A.openId && A.orgs.find(o => o.id === A.openId);
  if (A.openId && !open && A.orgs.length >= 0 && A.loaded) { A.openId = null; history.replaceState(null, "", location.pathname); }
  $("#tab-orgs .toolbar").hidden = !!open;
  if (open) return renderOrgDetail(open);
  const q = $("#org-q").value.trim().toLowerCase(), st = $("#org-status-filter").value;
  const list = A.orgs.filter(o => (!st || o.status === st) &&
    (!q || [o.name, o.ownerEmail, o.profile.contactName, o.profile.phone, o.profile.contactEmail, o.profile.industry, (o.profile.cities || []).join(" ")].join(" ").toLowerCase().includes(q)));
  if (!list.length) { box.innerHTML = '<p class="muted">No workspaces match.</p>'; return; }
  box.innerHTML = `<div class="org-grid">${list.map(o => { const p = o.profile || {};
    const flags = [
      !o.inUse && '<span class="st unused">not in use</span>',
      missing(p).length && '<span class="st hold">incomplete</span>',
      ...(o.duplicateOf || []).map(d => `<span class="st blocked">dup ${d.key}</span>`),
      o.requests?.length && `<span class="st hold">${o.requests.length} top-up</span>`,
    ].filter(Boolean).join(" ");
    return `<button class="org-card st-${o.status}" data-open="${o.id}">
      <div class="oc-head"><span class="oc-avatar">${esc((o.name || "?").trim()[0] || "?")}</span>
        <div class="oc-title"><b>${esc(o.name)}</b><span class="muted small">${esc(p.industry || "—")}</span></div>
        <span class="st ${o.status}">${o.status}</span></div>
      <div class="oc-contact">${p.contactName ? `${esc(p.contactName)}${p.jobTitle ? ` · ${esc(p.jobTitle)}` : ""}` : '<span class="muted">No contact yet</span>'}
        <div class="muted small">${esc(p.phone || "")}${p.phone && (p.contactEmail || o.ownerEmail) ? " · " : ""}${esc(p.contactEmail || o.ownerEmail || "")}</div></div>
      <div class="oc-stats"><span><b>${o.members.length}</b> users</span><span><b>${o.stores}</b> stores</span><span><b>${mmk(o.credits)}</b></span><span class="muted">${esc(o.plan)}</span></div>
      ${flags ? `<div class="oc-flags">${flags}</div>` : ""}
    </button>`; }).join("")}</div>`;
}

function renderOrgDetail(o) {
  const p = o.profile || {};
  const btn = (st, label, cls) => o.status === st ? "" : `<button class="btn sm ${cls}" data-act="status" data-id="${o.id}" data-status="${st}">${label}</button>`;
  const row = (k, v, raw) => `<div><dt>${k}</dt><dd>${v === undefined || v === null || v === "" ? '<span class="muted">—</span>' : raw ? v : esc(v)}</dd></div>`;
  const miss = missing(p);
  $("#orgs").innerHTML = `
    <div class="od">
      <button class="link" data-back>← All workspaces</button>
      <div class="od-head">
        <span class="oc-avatar lg">${esc((o.name || "?").trim()[0] || "?")}</span>
        <div class="main">
          <div class="row gap wrap"><h2>${esc(o.name)}</h2><span class="st ${o.status}">${o.status}</span>
            ${(o.duplicateOf || []).map(d => `<span class="st blocked" title="Same ${d.key} as “${esc(A.orgs.find(x => x.id === d.orgId)?.name || d.orgId)}”">duplicate ${d.key}</span>`).join(" ")}</div>
          <div class="muted small">${esc(p.industry || "")}${p.industry ? " · " : ""}Created ${date(o.createdAt)} · ID <code>${o.id}</code>${o.statusNote ? ` · Note: <b>${esc(o.statusNote)}</b>` : ""}</div>
        </div>
        <div class="org-actions">
          <label class="small muted">Plan <select data-act="plan" data-id="${o.id}">${["free", "pro", "business"].map(x => `<option ${x === o.plan ? "selected" : ""}>${x}</option>`).join("")}</select></label>
          ${btn("active", "Activate", "ok")}${btn("hold", "Hold", "warn")}${btn("blocked", "Block", "danger")}
          <button class="btn sm danger" data-act="delete" data-id="${o.id}">Delete</button>
        </div>
      </div>

      ${o.inUse ? "" : `<div class="od-alert">The owner's account currently isn't linked to this workspace (they'd be asked to create a new one).
        <button class="btn sm ok" data-act="useowner" data-id="${o.id}">Make owner's workspace</button></div>`}
      ${miss.length ? `<div class="od-alert warn">Business details incomplete: ${miss.join(", ")}. The owner is asked every time they open the app.</div>` : ""}

      <div class="kpis">
        ${[[o.members.length, "Users"], [o.stores, "Stores"], [o.brands, "Brands"], [mmk(o.credits), "AI credits"], [o.usage.aiCalls || 0, "AI uses this month"], [o.usage.placesSearches || 0, "Places searches this month"]]
          .map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("")}
      </div>

      <div class="od-cols">
        <section class="org">
          <div class="row between"><h3>Business details</h3><button class="btn sm" data-act="edit" data-id="${o.id}">Edit</button></div>
          <dl class="od-dl">
            ${row("Contact person", p.contactName)}${row("Position", p.jobTitle)}
            ${row("Phone", p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : "", true)}
            ${row("Email", (p.contactEmail || o.ownerEmail) ? `<a href="mailto:${esc(p.contactEmail || o.ownerEmail)}">${esc(p.contactEmail || o.ownerEmail)}</a>` : "", true)}
            ${row("Business type", p.industry)}${row("Branches", p.branches)}${row("Country", p.country)}${row("Cities", (p.cities || []).join(", "))}
            ${row("Website / FB", p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>` : "", true)}
            ${row("Competitors", (p.competitors || []).join(", "))}${row("Goal", p.goal)}${row("Owner login", o.ownerEmail)}
          </dl>
        </section>

        <section class="org">
          <div class="row between"><h3>Team</h3><button class="btn sm" data-act="adduser" data-id="${o.id}">+ Add user</button></div>
          <div class="od-members">
            ${o.members.map(m => `<div class="mrow"><span class="grow">${esc(m.email)}</span>
              <select data-mrole="${m.uid}" data-org="${o.id}">${["owner", "admin", "editor", "viewer"].map(r => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>
              ${m.role === "owner" ? '<span style="width:30px"></span>' : `<button class="btn sm ghost danger" data-mremove="${m.uid}" data-org="${o.id}" title="Remove from workspace">✕</button>`}</div>`).join("")}
          </div>

          <div class="row between" style="margin-top:14px"><h3>AI &amp; credits</h3><button class="btn sm" data-act="topup" data-id="${o.id}">Top up / adjust</button></div>
          <p class="small">Mode: <b>${o.aiMode === "platform" ? "StoreRadar AI (credits)" : "own API key"}</b> · Balance <b>${mmk(o.credits)}</b></p>
          ${o.requests?.length ? o.requests.map(r => `<div class="od-alert warn"><span>Top-up request: <b>${esc(r.package)} ${mmk(r.mmk)}</b> by ${esc(r.by)} (${date(r.at)})</span>
            <span class="acts"><button class="btn sm ok" data-req="${r.id}" data-org="${o.id}" data-do="approve">Approve &amp; top up</button><button class="btn sm" data-req="${r.id}" data-org="${o.id}" data-do="dismiss">Dismiss</button></span></div>`).join("") : ""}
          <div id="od-clog" class="small muted">Loading credit history…</div>
        </section>
      </div>
    </div>`;
  api("creditLog", { orgId: o.id }).then(r => {
    const el = $("#od-clog"); if (!el) return;
    el.innerHTML = r.log.length ? `<table class="admin-table"><thead><tr><th>Date</th><th>What</th><th>MMK</th><th>Balance</th><th>By</th></tr></thead><tbody>${r.log.slice(0, 15).map(l =>
      `<tr><td>${date(l.at)}</td><td>${esc(l.type === "charge" ? "AI " + (l.task || "") : l.type)}${l.note ? ` · ${esc(l.note)}` : ""}</td><td>${l.amount > 0 ? "+" : ""}${Math.round(l.amount).toLocaleString()}</td><td>${Math.round(l.balanceAfter).toLocaleString()}</td><td>${esc(l.by || "")}</td></tr>`).join("")}</tbody></table>` : "No credit activity yet.";
  }).catch(x => { const el = $("#od-clog"); if (el) el.textContent = x.message; });
}

function showTab(name) {
  document.querySelectorAll(".admin-tabs .tab").forEach(x => x.classList.toggle("active", x.dataset.tab === name));
  ["orgs", "biz", "credits", "users"].forEach(k => ($("#tab-" + k).hidden = k !== name));
}
function openOrg(id) { A.openId = id; if (location.hash !== "#w/" + id) history.pushState(null, "", "#w/" + id); showTab("orgs"); renderOrgs(); window.scrollTo(0, 0); }
function closeOrg() { A.openId = null; if (location.hash) history.pushState(null, "", location.pathname); renderOrgs(); }

/* ------------------------------------------------------------ users */
async function loadUsers() {
  $("#users").innerHTML = '<tr><td class="muted">Loading…</td></tr>';
  A.users = (await api("users")).users;
  renderUsers();
}

function renderUsers() {
  const orgName = id => A.orgs.find(o => o.id === id)?.name || "";
  const role = (uid, id) => A.orgs.find(o => o.id === id)?.members.find(m => m.uid === uid)?.role || "";
  const q = $("#user-q").value.trim().toLowerCase();
  const list = A.users.filter(u => !q || [u.email, u.name, u.phone, orgName(u.orgId)].join(" ").toLowerCase().includes(q))
    .sort((a, b) => new Date(b.created) - new Date(a.created));
  $("#users").innerHTML = `<thead><tr><th>Email</th><th>Workspace</th><th>Role</th><th>Sign-in</th><th>Created</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr></thead><tbody>` +
    list.map(u => `<tr>
      <td>${u.name ? `<b>${esc(u.name)}</b>${u.position ? ` <span class="muted small">· ${esc(u.position)}</span>` : ""}<br>` : ""}${esc(u.email)}${u.phone ? ` <span class="muted small">· ${esc(u.phone)}</span>` : ""}${u.superAdmin ? ' <span class="st super">super admin</span>' : ""}${u.verified ? "" : ' <span class="pill" title="Email not verified">unverified</span>'}</td>
      <td>${u.orgId && orgName(u.orgId) ? `<button class="link" data-open-org="${u.orgId}">${esc(orgName(u.orgId))}</button>` : '<span class="st unused">no workspace</span>'}</td>
      <td>${esc(role(u.uid, u.orgId))}</td>
      <td class="small">${u.providers.map(p => (p === "google.com" ? "Google" : p === "password" ? "Password" : p)).join(", ")}</td>
      <td>${date(u.created)}</td><td>${ago(u.lastSignIn)}</td>
      <td>${u.disabled ? '<span class="st blocked">disabled</span>' : '<span class="st active">active</span>'}</td>
      <td><div class="acts">
        ${u.verified ? "" : `<button class="btn ok" data-uact="verify" data-uid="${u.uid}">Mark verified</button>`}
        <button class="btn" data-uact="link" data-uid="${u.uid}">Reset link</button>
        <button class="btn" data-uact="email" data-uid="${u.uid}">Email reset</button>
        <button class="btn" data-uact="setpw" data-uid="${u.uid}">Set password</button>
        <button class="btn ${u.disabled ? "ok" : "warn"}" data-uact="toggle" data-uid="${u.uid}">${u.disabled ? "Enable" : "Disable"}</button>
        <button class="btn danger" data-uact="delete" data-uid="${u.uid}">Delete</button>
      </div></td></tr>`).join("") + "</tbody>";
}

/* ------------------------------------------------------------ dialogs */
function dialog(html, onOk) {
  const d = $("#dlg"), f = $("#dlg-form");
  f.innerHTML = html + `<div class="row gap" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Confirm</button></div>`;
  d.returnValue = "";
  d.onclose = () => { if (d.returnValue === "ok") onOk(Object.fromEntries(new FormData(f))); };
  d.showModal();
}
function info(html) {
  const d = $("#dlg"), f = $("#dlg-form");
  f.innerHTML = html + `<div class="row" style="justify-content:flex-end"><button class="btn primary" value="ok">Done</button></div>`;
  d.onclose = null; d.showModal();
}
async function run(label, fn, reload = loadOrgs) {
  try { await fn(); toast(label); await reload(); } catch (x) { toast("✖ " + x.message, 5000); }
}

function wire() {
  window.addEventListener("popstate", () => { const m = location.hash.match(/^#w\/(.+)$/); A.openId = m ? m[1] : null; renderOrgs(); });
  const m0 = location.hash.match(/^#w\/(.+)$/); if (m0) A.openId = m0[1];
  document.querySelectorAll(".admin-tabs .tab").forEach(t => (t.onclick = () => {
    if (t.dataset.tab === "orgs" && A.openId) closeOrg();
    document.querySelectorAll(".admin-tabs .tab").forEach(x => x.classList.toggle("active", x === t));
    ["orgs", "biz", "credits", "users"].forEach(k => ($("#tab-" + k).hidden = t.dataset.tab !== k));
    if (t.dataset.tab === "biz") renderBiz();
    if (t.dataset.tab === "credits") renderCredits();
    if (t.dataset.tab === "users") A.users.length ? renderUsers() : loadUsers().catch(x => toast(x.message, 5000));
  }));
  $("#org-q").oninput = renderOrgs; $("#org-status-filter").onchange = renderOrgs;
  $("#user-q").oninput = renderUsers;
  $("#biz-q").oninput = renderBiz;
  $("#export-biz").onclick = exportCSV;
  $("#pricing-form").onsubmit = savePricing;
  $("#add-offer").onclick = () => { readOffers(); A.offers.push({ id: "", label: "", via: "openrouter", model: "", enabled: true, prices: { insight: 800, branches: 3000 } }); renderOffers(); };
  $("#requests").addEventListener("click", e => {
    const b = e.target.closest("[data-req]"); if (!b) return;
    const o = A.orgs.find(x => x.id === b.dataset.org), r = o.requests.find(x => x.id === b.dataset.req);
    if (b.dataset.do === "approve") topUpDialog(o, r);
    else run("Request dismissed", () => api("dismissRequest", { orgId: o.id, requestId: r.id }), async () => { await loadOrgs(); renderCredits(); });
  });
  $("#biz").addEventListener("click", e => { const ob = e.target.closest("[data-open-biz]"); if (ob) openOrg(ob.dataset.openBiz); });
  $("#users").addEventListener("click", e => { const ou = e.target.closest("[data-open-org]"); if (ou) openOrg(ou.dataset.openOrg); });
  $("#biz").addEventListener("click", e => { const b = e.target.closest("[data-edit]"); if (b) editProfile(A.orgs.find(o => o.id === b.dataset.edit)); });
  $("#refresh").onclick = () => loadOrgs().catch(x => toast(x.message, 5000));
  $("#refresh-users").onclick = () => loadUsers().catch(x => toast(x.message, 5000));
  $("#export-orgs").onclick = exportCSV;

  $("#orgs").addEventListener("change", e => {
    const rs = e.target.closest("[data-mrole]");
    if (rs) return run(`Role changed to ${rs.value}`, () => api("setMemberRole", { orgId: rs.dataset.org, uid: rs.dataset.mrole, role: rs.value }));
    const el = e.target.closest("[data-act=plan]"); if (!el) return;
    run(`Plan set to ${el.value}`, () => api("setOrgPlan", { orgId: el.dataset.id, plan: el.value }));
  });
  $("#orgs").addEventListener("click", e => {
    const op = e.target.closest("[data-open]"); if (op) return openOrg(op.dataset.open);
    if (e.target.closest("[data-back]")) return closeOrg();
    const rq = e.target.closest("[data-req]");
    if (rq) {
      const o = A.orgs.find(x => x.id === rq.dataset.org), r = o.requests.find(x => x.id === rq.dataset.req);
      return rq.dataset.do === "approve" ? topUpDialog(o, r) : run("Request dismissed", () => api("dismissRequest", { orgId: o.id, requestId: r.id }));
    }
    const rm = e.target.closest("[data-mremove]");
    if (rm) {
      const o = A.orgs.find(x => x.id === rm.dataset.org), m = o.members.find(x => x.uid === rm.dataset.mremove);
      return dialog(`<h3>Remove ${esc(m.email)} from “${esc(o.name)}”?</h3><p class="muted small">Their login stays; they just lose access to this workspace.</p>`,
        () => run("User removed", () => api("removeMember", { orgId: o.id, uid: m.uid })));
    }
    const el = e.target.closest("button[data-act]"); if (!el) return;
    const o = A.orgs.find(x => x.id === el.dataset.id);
    if (el.dataset.act === "status") {
      const s = el.dataset.status;
      const what = { active: "Reactivate — full access restored.", hold: "Hold — members can view but not change anything.", blocked: "Block — members can't open the workspace at all." }[s];
      dialog(`<h3>${s === "active" ? "Activate" : s === "hold" ? "Hold" : "Block"} “${esc(o.name)}”?</h3><p class="muted small">${what}</p>
        <label>Note (visible to you only)<input name="note" maxlength="200" placeholder="e.g. invoice #12 unpaid" value="${esc(o.statusNote)}" /></label>`,
        v => run(`Workspace ${s}`, () => api("setOrgStatus", { orgId: o.id, status: s, note: v.note })));
    }
    if (el.dataset.act === "edit") return editProfile(o);
    if (el.dataset.act === "topup") return topUpDialog(o);
    if (el.dataset.act === "useowner") return run("Owner now opens this workspace", () => api("useAsOwnerWorkspace", { orgId: o.id }));
    if (el.dataset.act === "adduser") return addUserDialog(o);
    if (el.dataset.act === "delete") {
      dialog(`<h3>Delete “${esc(o.name)}” permanently?</h3><p class="muted small">Deletes all ${o.stores} stores, ${o.brands} brands, settings and AI key. Member logins stay (they'll see “create workspace”). This cannot be undone.</p>
        <label>Type the workspace name to confirm<input name="confirmName" required autocomplete="off" /></label>`,
        v => run("Workspace deleted", () => api("deleteOrg", { orgId: o.id, confirmName: v.confirmName })));
    }
  });

  $("#users").addEventListener("click", e => {
    const el = e.target.closest("button[data-uact]"); if (!el) return;
    const u = A.users.find(x => x.uid === el.dataset.uid), act = el.dataset.uact;
    const reloadUsers = () => loadUsers();
    if (act === "link") {
      api("resetLink", { email: u.email }).then(r => info(`<h3>Password reset link</h3><p class="muted small">Send this to ${esc(u.email)} (Viber / Telegram). It expires in about an hour and can be used once.</p>
        <div class="linkbox" id="rl">${esc(r.link)}</div><button type="button" class="btn sm" id="copy-rl">Copy link</button>`))
        .then(() => ($("#copy-rl").onclick = () => navigator.clipboard.writeText($("#rl").textContent).then(() => toast("Copied"))))
        .catch(x => toast("✖ " + x.message, 5000));
    }
    if (act === "verify") return run("Marked as verified", () => api("verifyUser", { uid: u.uid }), reloadUsers);
    if (act === "email") {
      A.m.sendPasswordResetEmail(A.auth, u.email).then(() => toast(`Reset email sent to ${u.email} (check spam)`)).catch(x => toast("✖ " + x.message, 5000));
    }
    if (act === "setpw") {
      dialog(`<h3>Set a new password for ${esc(u.email)}</h3><p class="muted small">They'll be signed out everywhere and must use this password.</p>
        <label>New password (min 8)<input name="password" type="text" minlength="8" required autocomplete="off" /></label>`,
        v => run("Password updated", () => api("setPassword", { uid: u.uid, password: v.password }), reloadUsers));
    }
    if (act === "toggle") {
      run(u.disabled ? "User enabled" : "User disabled", () => api("setUserDisabled", { uid: u.uid, disabled: !u.disabled }), reloadUsers);
    }
    if (act === "delete") {
      dialog(`<h3>Delete user ${esc(u.email)}?</h3><p class="muted small">Removes their login and workspace membership. Workspace owners can't be deleted until their workspace is deleted.</p>`,
        () => run("User deleted", () => api("deleteUser", { uid: u.uid }), reloadUsers));
    }
  });
}

const mmk = n => `${Math.round(n || 0).toLocaleString("en-US")} MMK`;
const genPw = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 55]).join("");

function addUserDialog(o) {
  const pw = genPw();
  dialog(`<h3>Add user to “${esc(o.name)}”</h3>
    <p class="muted small">Creates the login (already verified) and adds it to this workspace. If the email already has a login, it's just added.</p>
    <div class="grid2">
      <label>Email<input name="email" type="email" required /></label>
      <label>Name<input name="name" /></label>
      <label>Password (new users)<input name="password" value="${pw}" minlength="8" /></label>
      <label>Role<select name="role"><option>editor</option><option>viewer</option><option>admin</option><option>owner</option></select></label>
    </div>`,
    v => api("addMember", { orgId: o.id, ...v })
      .then(r => { info(`<h3>User added</h3><p class="muted small">Send these login details to the user (e.g. Viber):</p>
          <div class="linkbox" id="cred">App: ${esc(location.origin)}\nEmail: ${esc(v.email)}${r.created ? `\nPassword: ${esc(v.password)}` : "\n(existing login — password unchanged)"}</div>
          <button type="button" class="btn sm" id="copy-cred">Copy</button>`);
        $("#copy-cred").onclick = () => navigator.clipboard.writeText($("#cred").innerText).then(() => toast("Copied"));
        loadOrgs(); })
      .catch(x => toast("✖ " + x.message, 6000)));
}

function topUpDialog(o, req) {
  dialog(`<h3>AI credits — ${esc(o.name)}</h3>
    <p class="muted small">Balance: <b>${mmk(o.credits)}</b>. Use a negative amount to deduct.${req ? ` Request: <b>${esc(req.package)} ${mmk(req.mmk)}</b> by ${esc(req.by)}.` : ""}</p>
    <div class="grid2">
      <label>Amount (MMK)<input name="amount" type="number" step="500" required value="${req?.mmk || ""}" /></label>
      <label>Note<input name="note" placeholder="e.g. KBZPay receipt #1234" /></label>
    </div>
    <div class="row gap wrap">${(A.pricing?.packages || []).map(p => `<button type="button" class="btn sm" onclick="this.form.amount.value=${p.mmk}">${esc(p.name)} ${mmk(p.mmk)}</button>`).join("")}</div>
    <details id="clog"><summary class="small muted">Credit history</summary><div class="small muted">Loading…</div></details>`,
    v => run(`Credits updated`, () => api("topUp", { orgId: o.id, amount: +v.amount, note: v.note, requestId: req?.id }), async () => { await loadOrgs(); if (!$("#tab-credits").hidden) renderCredits(); }));
  $("#clog").ontoggle = async () => {
    const box = $("#clog div");
    try { const r = await api("creditLog", { orgId: o.id });
      box.innerHTML = r.log.length ? `<table class="admin-table">${r.log.map(l => `<tr><td>${date(l.at)}</td><td>${esc(l.type)}${l.task ? " · " + esc(l.task) : ""}</td><td>${l.amount > 0 ? "+" : ""}${Math.round(l.amount).toLocaleString()}</td><td>${Math.round(l.balanceAfter).toLocaleString()}</td><td>${esc(l.by || "")}</td><td>${esc(l.note || "")}</td></tr>`).join("")}</table>` : "No history yet."; }
    catch (x) { box.textContent = x.message; }
  };
}

function renderCredits() {
  const reqs = A.orgs.flatMap(o => (o.requests || []).map(r => ({ o, r })));
  $("#requests").innerHTML = reqs.length ? `<table class="admin-table"><thead><tr><th>Workspace</th><th>Package</th><th>Amount</th><th>By</th><th>Requested</th><th></th></tr></thead><tbody>${
    reqs.map(({ o, r }) => `<tr><td>${esc(o.name)}</td><td>${esc(r.package)}</td><td>${mmk(r.mmk)}</td><td>${esc(r.by)}</td><td>${date(r.at)}</td>
      <td><div class="acts"><button class="btn ok" data-req="${r.id}" data-org="${o.id}" data-do="approve">Approve &amp; top up</button><button class="btn" data-req="${r.id}" data-org="${o.id}" data-do="dismiss">Dismiss</button></div></td></tr>`).join("")}</tbody></table>`
    : '<p class="muted small">No pending requests.</p>';
  const p = A.pricing || {}, f = $("#pricing-form");
  const have = A.platformAI?.providers || [];
  A.offers = (Array.isArray(p.offers) ? p.offers : Object.entries(p.offers || {}).map(([k, o]) => ({ id: k, via: k, ...o }))).map(o => ({ ...o }));
  A.defaultOffer = p.defaultProvider;
  renderOffers();
  f.packages.value = (p.packages || []).map(x => `${x.name} | ${x.mmk}`).join("\n");
  f.contact.value = p.contact || "";
  $("#platform-ai-status").innerHTML = (have.length ? `✔ Keys found: <b>${have.map(x => GW[x]).join(", ")}</b>. ` : "✖ No AI keys yet. ") +
    `Keys are Vercel env vars: ${Object.keys(GW).map(g => `<code>PLATFORM_${g.toUpperCase()}_KEY</code>`).join(", ")} — add only the ones you use, then redeploy.`;
}

const GW = { gemini: "Gemini (Google)", claude: "Claude (Anthropic)", openai: "OpenAI", openrouter: "OpenRouter", fal: "fal" };

function readOffers() {
  document.querySelectorAll("#offer-rows tr").forEach((tr, i) => {
    const v = n => tr.querySelector(`[data-f=${n}]`), o = A.offers[i];
    Object.assign(o, { enabled: v("enabled").checked, label: v("label").value.trim(), via: v("via").value, model: v("model").value.trim(),
      prices: { insight: +v("insight").value, branches: +v("branches").value } });
    if (!o.id) o.id = o.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "option-" + i;
  });
  A.defaultOffer = document.querySelector("[name=defaultProvider]:checked")?.value || A.defaultOffer;
}

function renderOffers() {
  const have = A.platformAI?.providers || [];
  $("#offer-rows").innerHTML = A.offers.map((o, i) => `<tr>
    <td><input type="checkbox" data-f="enabled" ${o.enabled ? "checked" : ""} /></td>
    <td><input data-f="label" value="${esc(o.label || "")}" placeholder="e.g. Claude" /></td>
    <td><select data-f="via">${Object.entries(GW).map(([k, n]) => `<option value="${k}" ${o.via === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      ${have.includes(o.via) ? '<span class="st active">key ✔</span>' : '<span class="st blocked">no key</span>'}</td>
    <td><input data-f="model" list="platform-models" value="${esc(o.model || "")}" /></td>
    <td><input data-f="insight" type="number" min="0" step="50" value="${o.prices?.insight ?? ""}" /></td>
    <td><input data-f="branches" type="number" min="0" step="50" value="${o.prices?.branches ?? ""}" /></td>
    <td><input type="radio" name="defaultProvider" value="${esc(o.id || "")}" ${A.defaultOffer === o.id ? "checked" : ""} /></td>
    <td><button type="button" class="btn sm ghost danger" data-del-offer="${i}">✕</button></td></tr>`).join("");
  $("#offer-rows").querySelectorAll("[data-f=via]").forEach(sel => (sel.onchange = () => { readOffers(); renderOffers(); }));
  $("#offer-rows").querySelectorAll("[data-del-offer]").forEach(b => (b.onclick = () => { readOffers(); A.offers.splice(+b.dataset.delOffer, 1); renderOffers(); }));
}

function savePricing(e) {
  e.preventDefault();
  const f = e.target;
  const packages = f.packages.value.split("\n").map(l => l.split("|")).filter(x => x.length === 2).map(([n, m]) => ({ name: n.trim(), mmk: +m.replace(/[^0-9]/g, "") }));
  readOffers();
  const pricing = { offers: A.offers, defaultProvider: A.defaultOffer, packages, contact: f.contact.value.trim() };
  run("Pricing saved", () => api("setPricing", { pricing }), async () => { await loadOrgs(); renderCredits(); });
}

const REQUIRED = { contactName: "name", jobTitle: "position", phone: "phone", contactEmail: "email", industry: "business type" };
const missing = p => Object.entries(REQUIRED).filter(([k]) => !String(p?.[k] ?? "").trim()).map(([, l]) => l);

function renderBiz() {
  const q = $("#biz-q").value.trim().toLowerCase();
  const list = A.orgs.filter(o => { const p = o.profile || {};
    return !q || [o.name, p.contactName, p.jobTitle, p.phone, p.contactEmail, o.ownerEmail, p.industry, (p.cities || []).join(" ")].join(" ").toLowerCase().includes(q); });
  const cell = v => (v === undefined || v === null || v === "" ? '<span class="muted">—</span>' : esc(v));
  $("#biz").innerHTML = `<thead><tr><th>Company</th><th>Contact</th><th>Position</th><th>Phone</th><th>Email</th><th>Business type</th><th>Branches</th><th>Cities</th><th>Website / FB</th><th>Competitors</th><th>Goal</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>` +
    list.map(o => { const p = o.profile || {}, miss = missing(p);
      return `<tr>
        <td><button class="link" data-open-biz="${o.id}"><b>${esc(o.name)}</b></button>${miss.length ? `<div><span class="st hold" title="Missing: ${miss.join(", ")}">incomplete</span></div>` : ""}</td>
        <td>${cell(p.contactName)}</td><td>${cell(p.jobTitle)}</td>
        <td>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : cell()}</td>
        <td>${p.contactEmail || o.ownerEmail ? `<a href="mailto:${esc(p.contactEmail || o.ownerEmail)}">${esc(p.contactEmail || o.ownerEmail)}</a>` : cell()}</td>
        <td>${cell(p.industry)}</td><td>${cell(p.branches)}</td><td>${cell((p.cities || []).join(", "))}</td>
        <td>${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">link</a>` : cell()}</td>
        <td>${cell((p.competitors || []).join(", "))}</td><td>${cell(p.goal)}</td>
        <td><span class="st ${o.status}">${o.status}</span></td><td>${date(o.createdAt)}</td>
        <td><button class="btn" data-edit="${o.id}">Edit</button></td></tr>`; }).join("") + "</tbody>";
}

function editProfile(o) {
  const p = o.profile || {}, v = x => esc(Array.isArray(x) ? x.join(", ") : x ?? "");
  dialog(`<h3>Business details — ${esc(o.name)}</h3>
    <div class="grid2">
      <label>Contact person<input name="contactName" value="${v(p.contactName)}" /></label>
      <label>Position<input name="jobTitle" value="${v(p.jobTitle)}" /></label>
      <label>Phone<input name="phone" value="${v(p.phone)}" /></label>
      <label>Email<input name="contactEmail" type="email" value="${v(p.contactEmail || o.ownerEmail)}" /></label>
      <label>Business type<input name="industry" value="${v(p.industry)}" /></label>
      <label>Branches<input name="branches" type="number" min="0" value="${v(p.branches)}" /></label>
    </div>
    <label>Cities<input name="cities" value="${v(p.cities)}" /></label>
    <label>Website / Facebook<input name="website" value="${v(p.website)}" /></label>
    <label>Competitors<input name="competitors" value="${v(p.competitors)}" /></label>`,
    f => {
      const list = x => String(x || "").split(",").map(t => t.trim()).filter(Boolean);
      const profile = { ...p, ...f, cities: list(f.cities), competitors: list(f.competitors), branches: +f.branches || 0 };
      run("Details saved", () => api("setProfile", { orgId: o.id, profile }), async () => { await loadOrgs(); if (!$("#tab-biz").hidden) renderBiz(); });
    });
}

function exportCSV() {
  const rows = [["Workspace", "Status", "Plan", "Owner", "Contact", "Position", "Phone", "Email", "Industry", "Branches", "Cities", "Website", "Competitors", "Members", "Stores", "Created"]]
    .concat(A.orgs.map(o => { const p = o.profile || {}; return [o.name, o.status, o.plan, o.ownerEmail, p.contactName, p.jobTitle, p.phone, p.contactEmail, p.industry, p.branches, (p.cities || []).join("; "), p.website, (p.competitors || []).join("; "), o.members.length, o.stores, date(o.createdAt)]; }));
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `storeradar-clients-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
