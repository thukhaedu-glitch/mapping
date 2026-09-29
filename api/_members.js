// Workspace membership operations, shared by the platform admin (/api/admin) and workspace owners/admins (/api/team).
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { db, HttpError, adminApp } from "./_lib.js";

const log = (admin, action, target, extra = {}) =>
  db().collection("adminLog").add({ at: FieldValue.serverTimestamp(), by: admin.email, action, target, ...extra });

/** Ownership transfer: the new owner is recorded on the org and the previous owner becomes admin. */
async function demoteOwner(batch, orgId, newUid, oldUid, newEmail) {
  if (oldUid && oldUid !== newUid) {
    const old = await db().doc(`orgs/${orgId}/members/${oldUid}`).get();
    if (old.exists) batch.update(old.ref, { role: "admin" });
  }
  batch.update(db().doc(`orgs/${orgId}`), { ownerUid: newUid, ownerEmail: newEmail });
}

const methods = {
  /** Create a login for someone (or reuse an existing one) and put them in a workspace with a role. */
  async addMember(admin, { orgId, email, password, role, name }) {
    email = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
    if (!["owner", "admin", "editor", "viewer"].includes(role)) throw new HttpError(400, "Bad role");
    const org = await db().doc(`orgs/${orgId}`).get();
    if (!org.exists) throw new HttpError(404, "Workspace not found");
    const auth = getAuth(adminApp());
    let user, created = false;
    try { user = await auth.getUserByEmail(email); }
    catch {
      if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "New user: set a password of at least 8 characters.");
      user = await auth.createUser({ email, password, emailVerified: true, displayName: String(name || "").slice(0, 80) || undefined });
      created = true;
    }
    const prof = await db().doc(`users/${user.uid}`).get();
    const other = prof.data()?.orgId;
    if (other && other !== orgId) {
      const m = await db().doc(`orgs/${other}/members/${user.uid}`).get();
      if (m.exists) throw new HttpError(409, `${email} already belongs to another workspace. Remove them there first.`);
    }
    const batch = db().batch();
    batch.set(db().doc(`orgs/${orgId}/members/${user.uid}`), { email, role, joinedAt: FieldValue.serverTimestamp(), addedBy: admin.email });
    batch.set(db().doc(`users/${user.uid}`), { email, orgId }, { merge: true });
    if (role === "owner") await demoteOwner(batch, orgId, user.uid, org.data().ownerUid, email);
    await batch.commit();
    await log(admin, "addMember", orgId, { email, role, created });
    return { ok: true, created };
  },

  async setMemberRole(admin, { orgId, uid, role }) {
    if (!["owner", "admin", "editor", "viewer"].includes(role)) throw new HttpError(400, "Bad role");
    const [org, m] = await Promise.all([db().doc(`orgs/${orgId}`).get(), db().doc(`orgs/${orgId}/members/${uid}`).get()]);
    if (!m.exists) throw new HttpError(404, "Member not found");
    if (m.data().role === "owner" && role !== "owner") throw new HttpError(400, "A workspace needs an owner — make someone else the owner first.");
    const batch = db().batch();
    batch.update(m.ref, { role });
    if (role === "owner") await demoteOwner(batch, orgId, uid, org.data().ownerUid, m.data().email);
    await batch.commit();
    await log(admin, "setMemberRole", orgId, { uid, role });
    return { ok: true };
  },

  async removeMember(admin, { orgId, uid }) {
    const m = await db().doc(`orgs/${orgId}/members/${uid}`).get();
    if (!m.exists) throw new HttpError(404, "Member not found");
    if (m.data().role === "owner") throw new HttpError(400, "Can't remove the owner — make someone else the owner first, or delete the workspace.");
    const prof = await db().doc(`users/${uid}`).get();
    const batch = db().batch();
    batch.delete(m.ref);
    if (prof.data()?.orgId === orgId) batch.set(prof.ref, { orgId: FieldValue.delete() }, { merge: true });
    await batch.commit();
    await getAuth(adminApp()).revokeRefreshTokens(uid).catch(() => {});
    await log(admin, "removeMember", orgId, { uid, email: m.data().email });
    return { ok: true };
  },

};
export const { addMember, setMemberRole, removeMember } = methods;
