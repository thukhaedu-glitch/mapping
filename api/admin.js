// POST /api/admin  { action, ... }  — platform admin only (you).
// Access: SUPER_ADMIN_EMAILS env var (comma-separated) AND a verified email (sign in with Google, or verify your email).
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { handle, db, HttpError, adminApp } from "./_lib.js";
import { getPricing, platformAI, adjust, GATEWAYS } from "./_credits.js";
import * as members from "./_members.js";

const STATUSES = ["active", "hold", "blocked"], PLANS = ["free", "pro", "business"];

const superAdmins = () => (process.env.SUPER_ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

async function requireSuperAdmin(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const auth = getAuth(adminApp());
  let u;
  // signature check only (no revocation lookup) — saves a round trip to Google on every admin request
  try { u = await auth.verifyIdToken(token); } catch { throw new HttpError(401, "Session expired — sign in again."); }
  const allowed = superAdmins();
  if (!allowed.length) throw new HttpError(500, "SUPER_ADMIN_EMAILS env var is not set on the server.");
  if (!allowed.includes((u.email || "").toLowerCase())) throw new HttpError(403, "Not a platform admin.");
  if (!u.email_verified) throw new HttpError(403, "Your admin email is not verified — sign in with Google or verify the email first.");
  return u;
}

const ts = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const log = (admin, action, target, extra = {}) =>
  db().collection("adminLog").add({ at: FieldValue.serverTimestamp(), by: admin.email, action, target, ...extra });

async function orgSummary(doc) {
  const ref = doc.ref, d = doc.data();
  const month = new Date().toISOString().slice(0, 7);
  const [members, stores, brands, usage, owner, billing, aiSettings, requests] = await Promise.all([
    ref.collection("members").get(), ref.collection("stores").count().get(), ref.collection("brands").count().get(), ref.collection("usage").doc(month).get(),
    d.ownerUid ? db().doc(`users/${d.ownerUid}`).get() : null,
    ref.collection("billing").doc("ai").get(), ref.collection("settings").doc("ai").get(),
    ref.collection("topupRequests").where("status", "==", "pending").get(),
  ]);
  return {
    id: doc.id, name: d.name, ownerUid: d.ownerUid || "", plan: d.plan || "free", status: d.status || "active", ownerEmail: d.ownerEmail || "",
    profile: d.profile || {}, createdAt: ts(d.createdAt), statusNote: d.statusNote || "",
    members: members.docs.map(m => ({ uid: m.id, email: m.data().email, role: m.data().role })),
    stores: stores.data().count, brands: brands.data().count, usage: usage.data() || {},
    // false = the owner's account points at a different workspace (e.g. a duplicate created by double-clicking)
    inUse: owner?.exists ? owner.data().orgId === doc.id : false,
    credits: billing.data()?.balance || 0, aiMode: aiSettings.data()?.mode || "own",
    requests: requests.docs.map(r => ({ id: r.id, ...r.data(), at: ts(r.data().at) })),
  };
}

/** Same normalisation as the client (public/js/data.js registryKeys). */
function registryKeys(name, phone) {
  let n = String(name || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
  for (let prev; prev !== n;) { prev = n; n = n.replace(/(coltd|limited|ltd|co|company|myanmar)$/u, ""); }
  const digits = String(phone || "").replace(/\D/g, "");
  const ph = digits.length >= 7 ? digits.slice(-9) : "";
  return [n && `name:${n}`, ph && `phone:${ph}`].filter(Boolean);
}

/** Workspaces created before the registry existed get their name/phone reserved; clashes are flagged. */
async function backfillRegistry(orgs) {
  const pairs = orgs.flatMap(o => { o.duplicateOf = []; return registryKeys(o.name, o.profile?.phone).map(k => ({ o, k })); });
  if (!pairs.length) return;
  const docs = await db().getAll(...pairs.map(p => db().doc(`registry/${p.k}`)));      // one round trip for all keys
  const batch = db().batch();
  let writes = 0;
  docs.forEach((cur, i) => {
    const { o, k } = pairs[i];
    if (!cur.exists) { batch.set(cur.ref, { ownerUid: o.ownerUid || "", orgId: o.id, type: k.split(":")[0], at: FieldValue.serverTimestamp() }); writes++; }
    else if (cur.data().orgId !== o.id) o.duplicateOf.push({ key: k.split(":")[0], orgId: cur.data().orgId });
  });
  if (writes) await batch.commit();
}

const actions = {
  async overview() {
    const [snap, pricing] = await Promise.all([db().collection("orgs").get(), getPricing()]);
    const orgs = await Promise.all(snap.docs.map(orgSummary));
    await backfillRegistry(orgs).catch(e => console.error("registry backfill", e));
    const p = platformAI();
    return {
      orgs: orgs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      pricing, platformAI: p,
    };
  },

  async setPricing(admin, { pricing }) {
    const seen = new Set();
    const offers = (pricing?.offers || []).slice(0, 8).map(o => ({
      id: String(o.id || o.label || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30),
      label: String(o.label || "").slice(0, 40), via: GATEWAYS.includes(o.via) ? o.via : "gemini", model: String(o.model || "").slice(0, 80),
      enabled: !!o.enabled, prices: { insight: Math.max(0, Math.round(+o.prices?.insight || 0)), branches: Math.max(0, Math.round(+o.prices?.branches || 0)) },
    })).filter(o => o.id && o.label && o.model && !seen.has(o.id) && seen.add(o.id));
    if (!offers.length) throw new HttpError(400, "Add at least one AI option (name + model).");
    const packages = (pricing?.packages || []).slice(0, 10).map(x => ({ name: String(x.name).slice(0, 40), mmk: Math.max(0, Math.round(+x.mmk || 0)) })).filter(x => x.name && x.mmk);
    const def = offers.find(o => o.id === pricing?.defaultProvider && o.enabled) || offers.find(o => o.enabled) || offers[0];
    await db().doc("platform/pricing").set({ offers, defaultProvider: def.id, packages, contact: String(pricing?.contact || "").slice(0, 500) });
    await log(admin, "setPricing", "platform");
    return { ok: true };
  },

  async topUp(admin, { orgId, amount, note, requestId }) {
    amount = Math.round(+amount);
    if (!amount || Math.abs(amount) > 100000000) throw new HttpError(400, "Enter an amount in MMK (negative to deduct).");
    const bal = await adjust(orgId, amount, { type: amount > 0 ? "topup" : "adjust", by: admin.email, note: String(note || "").slice(0, 200) });
    if (requestId) await db().doc(`orgs/${orgId}/topupRequests/${requestId}`).update({ status: "done", doneBy: admin.email, doneAt: FieldValue.serverTimestamp(), credited: amount });
    await log(admin, "topUp", orgId, { amount });
    return { ok: true, balance: bal };
  },

  async dismissRequest(admin, { orgId, requestId }) {
    await db().doc(`orgs/${orgId}/topupRequests/${requestId}`).update({ status: "dismissed", doneBy: admin.email, doneAt: FieldValue.serverTimestamp() });
    return { ok: true };
  },

  addMember: (admin, b) => members.addMember(admin, b),
  setMemberRole: (admin, b) => members.setMemberRole(admin, b),
  removeMember: (admin, b) => members.removeMember(admin, b),

  async creditLog(admin, { orgId }) {
    const snap = await db().collection(`orgs/${orgId}/creditLog`).orderBy("at", "desc").limit(50).get();
    return { log: snap.docs.map(d => ({ ...d.data(), at: ts(d.data().at) })) };
  },

  async users() {
    const auth = getAuth(adminApp());
    const out = [];
    let page;
    do {
      page = await auth.listUsers(1000, page?.pageToken);
      out.push(...page.users);
    } while (page.pageToken && out.length < 10000);
    // Platform admins are not clients — keep them out of the list
    const admins = superAdmins();
    const clients = out.filter(u => !admins.includes((u.email || "").toLowerCase()));
    out.length = 0; out.push(...clients);
    const profiles = await db().getAll(...out.map(u => db().doc(`users/${u.uid}`)).slice(0, 10000)).catch(() => []);
    const orgOf = Object.fromEntries(profiles.filter(p => p.exists).map(p => [p.id, p.data().orgId]));
    return {
      users: out.map(u => ({
        uid: u.uid, email: u.email || "", name: u.displayName || "", disabled: u.disabled, verified: u.emailVerified,
        providers: u.providerData.map(p => p.providerId), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime,
        orgId: orgOf[u.uid] || null, superAdmin: superAdmins().includes((u.email || "").toLowerCase()),
      })),
    };
  },

  async setOrgStatus(admin, { orgId, status, note }) {
    if (!STATUSES.includes(status)) throw new HttpError(400, "Bad status");
    await db().doc(`orgs/${orgId}`).update({ status, statusNote: String(note || "").slice(0, 200), statusChangedAt: FieldValue.serverTimestamp() });
    await log(admin, "setOrgStatus", orgId, { status });
    return { ok: true };
  },

  /** Point the owner's account at this workspace (fixes "not in use"). */
  async useAsOwnerWorkspace(admin, { orgId }) {
    const org = await db().doc(`orgs/${orgId}`).get();
    const uid = org.data()?.ownerUid;
    if (!uid) throw new HttpError(400, "This workspace has no owner.");
    const m = db().doc(`orgs/${orgId}/members/${uid}`);
    const batch = db().batch();
    if (!(await m.get()).exists) batch.set(m, { email: org.data().ownerEmail || "", role: "owner", joinedAt: FieldValue.serverTimestamp() });
    batch.set(db().doc(`users/${uid}`), { orgId, email: org.data().ownerEmail || "" }, { merge: true });
    await batch.commit();
    await log(admin, "useAsOwnerWorkspace", orgId);
    return { ok: true };
  },

  async setOrgPlan(admin, { orgId, plan }) {
    if (!PLANS.includes(plan)) throw new HttpError(400, "Bad plan");
    await db().doc(`orgs/${orgId}`).update({ plan });
    await log(admin, "setOrgPlan", orgId, { plan });
    return { ok: true };
  },

  async deleteOrg(admin, { orgId, confirmName }) {
    const ref = db().doc(`orgs/${orgId}`);
    const d = await ref.get();
    if (!d.exists) throw new HttpError(404, "Workspace not found");
    if (confirmName !== d.data().name) throw new HttpError(400, "Type the exact workspace name to confirm.");
    const [members, invites, reg, allOrgs] = await Promise.all([
      ref.collection("members").get(), db().collection("invites").where("orgId", "==", orgId).get(),
      db().collection("registry").where("orgId", "==", orgId).get(), db().collection("orgs").get(),
    ]);
    await db().recursiveDelete(ref);                                   // org + stores, brands, members, settings, secrets, usage
    const batch = db().batch();
    // Members whose "current workspace" was this one are pointed at another workspace they belong to (if any)
    for (const m of members.docs) {
      const prof = await db().doc(`users/${m.id}`).get();
      if (prof.exists && prof.data().orgId && prof.data().orgId !== orgId) continue;
      let other = null;
      for (const o of allOrgs.docs) if (o.id !== orgId && (await o.ref.collection("members").doc(m.id).get()).exists) { other = o.id; break; }
      batch.set(prof.ref, { orgId: other || FieldValue.delete() }, { merge: true });
    }
    invites.docs.forEach(i => batch.delete(i.ref));
    reg.docs.forEach(r => batch.delete(r.ref));                         // free the business name / phone
    await batch.commit();
    await log(admin, "deleteOrg", orgId, { name: d.data().name, stores: null });
    return { ok: true };
  },

  async resetLink(admin, { email }) {
    const link = await getAuth(adminApp()).generatePasswordResetLink(email);
    await log(admin, "resetLink", email);
    return { link };
  },

  async verifyUser(admin, { uid }) {
    await getAuth(adminApp()).updateUser(uid, { emailVerified: true });
    await log(admin, "verifyUser", uid);
    return { ok: true };
  },

  async setProfile(admin, { orgId, profile }) {
    const keys = ["contactName", "jobTitle", "phone", "contactEmail", "industry", "branches", "country", "cities", "website", "competitors", "goal"];
    const clean = {};
    for (const k of keys) if (profile?.[k] !== undefined) clean[k] = Array.isArray(profile[k]) ? profile[k].slice(0, 20).map(String) : k === "branches" ? +profile[k] || 0 : String(profile[k]).slice(0, 300);
    await db().doc(`orgs/${orgId}`).set({ profile: clean }, { merge: true });
    await log(admin, "setProfile", orgId);
    return { ok: true };
  },

  async setPassword(admin, { uid, password }) {
    if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    await getAuth(adminApp()).updateUser(uid, { password });
    await getAuth(adminApp()).revokeRefreshTokens(uid);                 // sign them out everywhere
    await log(admin, "setPassword", uid);
    return { ok: true };
  },

  async setUserDisabled(admin, { uid, disabled }) {
    if (uid === admin.uid) throw new HttpError(400, "You can't disable yourself.");
    await getAuth(adminApp()).updateUser(uid, { disabled: !!disabled });
    if (disabled) await getAuth(adminApp()).revokeRefreshTokens(uid);
    await log(admin, disabled ? "disableUser" : "enableUser", uid);
    return { ok: true };
  },

  async deleteUser(admin, { uid }) {
    if (uid === admin.uid) throw new HttpError(400, "You can't delete yourself.");
    const prof = await db().doc(`users/${uid}`).get();
    const orgId = prof.data()?.orgId;
    if (orgId) {
      const m = await db().doc(`orgs/${orgId}/members/${uid}`).get();
      if (m.data()?.role === "owner") throw new HttpError(400, "This user owns a workspace — delete or transfer the workspace first.");
      await m.ref.delete().catch(() => {});
    }
    await db().doc(`users/${uid}`).delete().catch(() => {});
    await getAuth(adminApp()).deleteUser(uid);
    await log(admin, "deleteUser", uid);
    return { ok: true };
  },
};

export default handle(async (body, req) => {
  const admin = await requireSuperAdmin(req);
  const fn = actions[body.action];
  if (!fn) throw new HttpError(400, "Unknown action");
  return fn.length ? fn(admin, body) : fn();
});
