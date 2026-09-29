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
  $("#google").onclick = () => auth.signInWithPopup(A.auth, new auth.GoogleAuthProvider()).catch(x => ($("#login-error").textContent = x.message));
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
  $("#orgs").innerHTML = '<p class="muted">Loading…</p>';
  A.orgs = (await api("overview")).orgs;
  renderKpis(); renderOrgs();
}

function renderKpis() {
  const o = A.orgs, count = st => o.filter(x => x.status === st).length;
  const stores = o.reduce((a, x) => a + x.stores, 0), users = new Set(o.flatMap(x => x.members.map(m => m.uid))).size;
  const newWeek = o.filter(x => x.createdAt && Date.now() - new Date(x.createdAt) < 7 * 864e5).length;
  $("#kpis").innerHTML = [
    [o.length, "Workspaces"], [count("active"), "Active"], [count("hold"), "On hold"], [count("blocked"), "Blocked"],
    [users, "Members"], [stores.toLocaleString(), "Stores mapped"], [newWeek, "New this week"],
  ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("");
}

function renderOrgs() {
  const q = $("#org-q").value.trim().toLowerCase(), st = $("#org-status-filter").value;
  const list = A.orgs.filter(o => (!st || o.status === st) &&
    (!q || [o.name, o.ownerEmail, o.profile.contactName, o.profile.phone, o.profile.industry, (o.profile.cities || []).join(" ")].join(" ").toLowerCase().includes(q)));
  if (!list.length) { $("#orgs").innerHTML = '<p class="muted">No workspaces match.</p>'; return; }
  $("#orgs").innerHTML = list.map(o => {
    const p = o.profile || {};
    const btn = (s, label, cls) => o.status === s ? "" : `<button class="btn sm ${cls}" data-act="status" data-id="${o.id}" data-status="${s}">${label}</button>`;
    return `<div class="org st-${o.status}">
      <div class="org-head">
        <div class="main">
          <div class="row gap"><h3>${esc(o.name)}</h3><span class="st ${o.status}">${o.status}</span></div>
          <div class="org-meta">
            <span>Owner <b>${esc(o.ownerEmail || o.members.find(m => m.role === "owner")?.email || "—")}</b></span>
            ${p.contactName ? `<span>Contact <b>${esc(p.contactName)}</b>${p.jobTitle ? ` (${esc(p.jobTitle)})` : ""}</span>` : ""}
            ${p.phone ? `<span>Phone <b><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a></b></span>` : ""}
            ${p.industry ? `<span>${esc(p.industry)}</span>` : ""}
            <span>Created <b>${date(o.createdAt)}</b></span>
          </div>
          <div class="org-meta">
            <span><b>${o.members.length}</b> members</span><span><b>${o.stores}</b> stores</span><span><b>${o.brands}</b> brands</span>
            <span>This month: <b>${o.usage.placesSearches || 0}</b> Places · <b>${o.usage.aiCalls || 0}</b> AI</span>
            ${o.statusNote ? `<span>Note: <b>${esc(o.statusNote)}</b></span>` : ""}
          </div>
        </div>
        <div class="org-actions">
          <select data-act="plan" data-id="${o.id}" title="Plan">${["free", "pro", "business"].map(x => `<option ${x === o.plan ? "selected" : ""}>${x}</option>`).join("")}</select>
          ${btn("active", "Activate", "ok")}${btn("hold", "Hold", "warn")}${btn("blocked", "Block", "danger")}
          <button class="btn sm danger" data-act="delete" data-id="${o.id}">Delete</button>
        </div>
      </div>
      <details><summary>Business details &amp; members</summary>
        <dl class="profile-grid">
          ${[["Branches", p.branches], ["Country", p.country], ["Cities", (p.cities || []).join(", ")], ["Website / FB", p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>` : ""],
            ["Competitors", (p.competitors || []).join(", ")], ["Goal", p.goal], ["Workspace ID", `<code>${o.id}</code>`]]
            .map(([k, v]) => `<div><dt>${k}</dt><dd>${v === undefined || v === "" ? "—" : k === "Website / FB" || k === "Workspace ID" ? v : esc(v)}</dd></div>`).join("")}
        </dl>
        <div class="members">${o.members.map(m => `<span class="pill">${esc(m.email)} · ${m.role}</span>`).join("")}</div>
      </details>
    </div>`;
  }).join("");
}

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
  const list = A.users.filter(u => !q || [u.email, u.name, orgName(u.orgId)].join(" ").toLowerCase().includes(q))
    .sort((a, b) => new Date(b.created) - new Date(a.created));
  $("#users").innerHTML = `<thead><tr><th>Email</th><th>Workspace</th><th>Role</th><th>Sign-in</th><th>Created</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr></thead><tbody>` +
    list.map(u => `<tr>
      <td>${esc(u.email)}${u.verified ? "" : ' <span class="pill" title="Email not verified">unverified</span>'}</td>
      <td>${esc(orgName(u.orgId)) || '<span class="muted">—</span>'}</td>
      <td>${esc(role(u.uid, u.orgId))}</td>
      <td class="small">${u.providers.map(p => (p === "google.com" ? "Google" : p === "password" ? "Password" : p)).join(", ")}</td>
      <td>${date(u.created)}</td><td>${ago(u.lastSignIn)}</td>
      <td>${u.disabled ? '<span class="st blocked">disabled</span>' : '<span class="st active">active</span>'}</td>
      <td><div class="acts">
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
  document.querySelectorAll(".admin-tabs .tab").forEach(t => (t.onclick = () => {
    document.querySelectorAll(".admin-tabs .tab").forEach(x => x.classList.toggle("active", x === t));
    $("#tab-orgs").hidden = t.dataset.tab !== "orgs"; $("#tab-users").hidden = t.dataset.tab !== "users";
    if (t.dataset.tab === "users" && !A.users.length) loadUsers().catch(x => toast(x.message, 5000));
  }));
  $("#org-q").oninput = renderOrgs; $("#org-status-filter").onchange = renderOrgs;
  $("#user-q").oninput = renderUsers;
  $("#refresh").onclick = () => loadOrgs().catch(x => toast(x.message, 5000));
  $("#refresh-users").onclick = () => loadUsers().catch(x => toast(x.message, 5000));
  $("#export-orgs").onclick = exportCSV;

  $("#orgs").addEventListener("change", e => {
    const el = e.target.closest("[data-act=plan]"); if (!el) return;
    run(`Plan set to ${el.value}`, () => api("setOrgPlan", { orgId: el.dataset.id, plan: el.value }));
  });
  $("#orgs").addEventListener("click", e => {
    const el = e.target.closest("button[data-act]"); if (!el) return;
    const o = A.orgs.find(x => x.id === el.dataset.id);
    if (el.dataset.act === "status") {
      const s = el.dataset.status;
      const what = { active: "Reactivate — full access restored.", hold: "Hold — members can view but not change anything.", blocked: "Block — members can't open the workspace at all." }[s];
      dialog(`<h3>${s === "active" ? "Activate" : s === "hold" ? "Hold" : "Block"} “${esc(o.name)}”?</h3><p class="muted small">${what}</p>
        <label>Note (visible to you only)<input name="note" maxlength="200" placeholder="e.g. invoice #12 unpaid" value="${esc(o.statusNote)}" /></label>`,
        v => run(`Workspace ${s}`, () => api("setOrgStatus", { orgId: o.id, status: s, note: v.note })));
    }
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

function exportCSV() {
  const rows = [["Workspace", "Status", "Plan", "Owner", "Contact", "Phone", "Industry", "Branches", "Cities", "Website", "Competitors", "Members", "Stores", "Created"]]
    .concat(A.orgs.map(o => { const p = o.profile || {}; return [o.name, o.status, o.plan, o.ownerEmail, p.contactName, p.phone, p.industry, p.branches, (p.cities || []).join("; "), p.website, (p.competitors || []).join("; "), o.members.length, o.stores, date(o.createdAt)]; }));
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `storeradar-clients-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
