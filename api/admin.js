// POST /api/admin  { action, ... }  — platform admin only (you).
// Access: SUPER_ADMIN_EMAILS env var (comma-separated) AND a verified email (sign in with Google, or verify your email).
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { handle, db, HttpError, adminApp } from "./_lib.js";

const STATUSES = ["active", "hold", "blocked"], PLANS = ["free", "pro", "business"];

async function requireSuperAdmin(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const auth = getAuth(adminApp());
  let u;
  try { u = await auth.verifyIdToken(token, true); } catch { throw new HttpError(401, "Session expired — sign in again."); }
  const allowed = (process.env.SUPER_ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
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
  const [members, stores, brands, usage] = await Promise.all([
    ref.collection("members").get(), ref.collection("stores").count().get(), ref.collection("brands").count().get(), ref.collection("usage").doc(month).get(),
  ]);
  return {
    id: doc.id, name: d.name, plan: d.plan || "free", status: d.status || "active", ownerEmail: d.ownerEmail || "",
    profile: d.profile || {}, createdAt: ts(d.createdAt), statusNote: d.statusNote || "",
    members: members.docs.map(m => ({ uid: m.id, email: m.data().email, role: m.data().role })),
    stores: stores.data().count, brands: brands.data().count, usage: usage.data() || {},
  };
}

const actions = {
  async overview() {
    const snap = await db().collection("orgs").get();
    const orgs = await Promise.all(snap.docs.map(orgSummary));
    return { orgs: orgs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
  },

  async users() {
    const auth = getAuth(adminApp());
    const out = [];
    let page;
    do {
      page = await auth.listUsers(1000, page?.pageToken);
      out.push(...page.users);
    } while (page.pageToken && out.length < 10000);
    const profiles = await db().getAll(...out.map(u => db().doc(`users/${u.uid}`)).slice(0, 10000)).catch(() => []);
    const orgOf = Object.fromEntries(profiles.filter(p => p.exists).map(p => [p.id, p.data().orgId]));
    return {
      users: out.map(u => ({
        uid: u.uid, email: u.email || "", name: u.displayName || "", disabled: u.disabled, verified: u.emailVerified,
        providers: u.providerData.map(p => p.providerId), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime,
        orgId: orgOf[u.uid] || null,
      })),
    };
  },

  async setOrgStatus(admin, { orgId, status, note }) {
    if (!STATUSES.includes(status)) throw new HttpError(400, "Bad status");
    await db().doc(`orgs/${orgId}`).update({ status, statusNote: String(note || "").slice(0, 200), statusChangedAt: FieldValue.serverTimestamp() });
    await log(admin, "setOrgStatus", orgId, { status });
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
    const members = await ref.collection("members").get();
    const invites = await db().collection("invites").where("orgId", "==", orgId).get();
    await db().recursiveDelete(ref);                                   // org + stores, brands, members, settings, secrets, usage
    const batch = db().batch();
    for (const m of members.docs) batch.set(db().doc(`users/${m.id}`), { orgId: FieldValue.delete() }, { merge: true });
    invites.docs.forEach(i => batch.delete(i.ref));
    await batch.commit();
    await log(admin, "deleteOrg", orgId, { name: d.data().name, stores: null });
    return { ok: true };
  },

  async resetLink(admin, { email }) {
    const link = await getAuth(adminApp()).generatePasswordResetLink(email);
    await log(admin, "resetLink", email);
    return { link };
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
