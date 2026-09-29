// Shared helpers for Vercel API routes: Firebase Admin, auth check, membership, quotas.
// Env vars (Vercel → Project → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT  – full JSON of a service-account key (Firebase Console → Project settings → Service accounts → Generate new private key)
//   PLACES_API_KEY            – Google Maps Platform key with "Places API (New)" enabled
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export function adminApp() { return app(); }
function app() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpError(500, "Server not configured: FIREBASE_SERVICE_ACCOUNT env var is missing.");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}
export const db = () => getFirestore(app());

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/** Verifies the Firebase ID token and that the user is a member of orgId with one of `roles`. */
export async function requireMember(req, orgId, roles = ["owner", "admin", "editor", "viewer"], { requireActive = false } = {}) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const auth = getAuth(app());          // throws a clear 500 if the service account env var is missing
  let user;
  try { user = await auth.verifyIdToken(token); } catch { throw new HttpError(401, "Session expired — sign in again."); }
  if (!orgId || typeof orgId !== "string") throw new HttpError(400, "Missing workspace.");
  const [member, org] = await Promise.all([db().doc(`orgs/${orgId}/members/${user.uid}`).get(), db().doc(`orgs/${orgId}`).get()]);
  if (!member.exists || !roles.includes(member.data().role)) throw new HttpError(403, "You don't have access to do this in this workspace.");
  const status = org.data()?.status || "active";
  if (status === "blocked") throw new HttpError(403, "This workspace is blocked. Contact support.");
  if (requireActive && status !== "active") throw new HttpError(403, "This workspace is on hold (read-only). Contact support.");
  return { user, org: org.data() || {} };
}

/** Monthly per-workspace counter; throws 429 when the plan limit is reached. */
export async function consume(orgId, field, limit) {
  const ref = db().doc(`orgs/${orgId}/usage/${new Date().toISOString().slice(0, 7)}`);
  await db().runTransaction(async t => {
    const used = (await t.get(ref)).data()?.[field] || 0;
    if (used >= limit) throw new HttpError(429, `Monthly limit reached (${limit}). Upgrade the plan or wait until next month.`);
    t.set(ref, { [field]: used + 1 }, { merge: true });
  });
}

export function handle(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    try { res.status(200).json(await fn(req.body || {}, req)); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      res.status(status).json({ error: e.message || "Server error" });
    }
  };
}
