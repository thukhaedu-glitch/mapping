// Data layer — one API, two backends:
//   FirebaseBackend: multi-tenant Firestore (orgs/{orgId}/brands|stores|members)
//   DemoBackend:     in-browser only (localStorage), for trying the app without Firebase
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
export const hasFirebase = !!(firebaseConfig.apiKey && firebaseConfig.projectId);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ------------------------------------------------------------------ DEMO */
class DemoBackend {
  constructor() {
    this.mode = "demo";
    this.key = "storeradar-demo-v1";
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) || "null"); } catch {}
    this.db = saved || { brands: {}, stores: {} };
    this.subs = { brands: [], stores: [] };
    this.user = { uid: "demo", email: "demo@local" };
    this.org = { id: "demo", name: "Demo workspace", role: "owner" };
  }
  _save() { try { localStorage.setItem(this.key, JSON.stringify(this.db)); } catch {} }
  _emit(col) { const list = Object.entries(this.db[col]).map(([id, d]) => ({ id, ...d })); this.subs[col].forEach(cb => cb(list)); }
  async init() { return { user: this.user, org: this.org }; }
  onAuth(cb) { cb(this.user); }
  on(col, cb) { this.subs[col].push(cb); this._emit(col); }
  async add(col, data) { const id = uid(); this.db[col][id] = { ...data, createdAt: Date.now() }; this._save(); this._emit(col); return id; }
  async update(col, id, data) { this.db[col][id] = { ...this.db[col][id], ...data }; this._save(); this._emit(col); }
  async remove(col, id) { delete this.db[col][id]; this._save(); this._emit(col); }
  async bulkAdd(col, list) { list.forEach(d => (this.db[col][uid()] = { ...d, createdAt: Date.now() })); this._save(); this._emit(col); }
  async clearAll() { this.db = { brands: {}, stores: {} }; this._save(); this._emit("brands"); this._emit("stores"); }
  async placesSearch() { throw new Error("Google Places search needs the Firebase backend (Cloud Function). Demo mode မှာ မရပါ။"); }
  async listMembers() { return [{ id: "demo", email: "demo@local", role: "owner" }]; }
  async invite() { throw new Error("Demo mode မှာ member invite မရပါ။"); }
  async signOut() {}
}

/* -------------------------------------------------------------- FIREBASE */
class FirebaseBackend {
  constructor() { this.mode = "firebase"; this.org = null; this.user = null; }

  async load() {
    const [app, auth, fs, fn] = await Promise.all([
      import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"),
      import(FB + "firebase-firestore.js"), import(FB + "firebase-functions.js"),
    ]);
    this.m = { ...auth, ...fs, ...fn };
    this.app = app.initializeApp(firebaseConfig);
    this.auth = auth.getAuth(this.app);
    this.fs = fs.getFirestore(this.app);
    this.fn = fn.getFunctions(this.app, functionsRegion);
  }

  onAuth(cb) { this.m.onAuthStateChanged(this.auth, u => { this.user = u; cb(u); }); }
  signIn(email, pw) { return this.m.signInWithEmailAndPassword(this.auth, email, pw); }
  signUp(email, pw) { return this.m.createUserWithEmailAndPassword(this.auth, email, pw); }
  signInGoogle() { return this.m.signInWithPopup(this.auth, new this.m.GoogleAuthProvider()); }
  resetPassword(email) { return this.m.sendPasswordResetEmail(this.auth, email); }
  signOut() { return this.m.signOut(this.auth); }

  // Returns {org} if the user already belongs to one, or {invite} if one is waiting, else {}.
  async resolveOrg() {
    const { doc, getDoc } = this.m;
    const u = this.user;
    const profile = await getDoc(doc(this.fs, "users", u.uid));
    if (profile.exists() && profile.data().orgId) {
      const orgId = profile.data().orgId;
      const [org, mem] = await Promise.all([
        getDoc(doc(this.fs, "orgs", orgId)), getDoc(doc(this.fs, "orgs", orgId, "members", u.uid)),
      ]);
      if (org.exists() && mem.exists()) { this.org = { id: orgId, ...org.data(), role: mem.data().role }; return { org: this.org }; }
    }
    const inv = await getDoc(doc(this.fs, "invites", (u.email || "").toLowerCase()));
    if (inv.exists()) return { invite: inv.data() };
    return {};
  }

  async createOrg(name) {
    const { doc, collection, setDoc, serverTimestamp } = this.m;
    const u = this.user;
    const ref = doc(collection(this.fs, "orgs"));
    await setDoc(ref, { name, ownerUid: u.uid, plan: "free", createdAt: serverTimestamp() });
    await setDoc(doc(this.fs, "orgs", ref.id, "members", u.uid), { email: u.email, role: "owner", joinedAt: serverTimestamp() });
    await setDoc(doc(this.fs, "users", u.uid), { email: u.email, orgId: ref.id });
    // Starter brand so the map is usable immediately
    await this.addTo(ref.id, "brands", { name: "Our brand", color: "#16a34a", isOwn: true, aliases: [] });
    return this.resolveOrg();
  }

  async acceptInvite(invite) {
    const { doc, setDoc, deleteDoc, serverTimestamp } = this.m;
    const u = this.user;
    await setDoc(doc(this.fs, "orgs", invite.orgId, "members", u.uid), { email: u.email, role: invite.role, joinedAt: serverTimestamp() });
    await setDoc(doc(this.fs, "users", u.uid), { email: u.email, orgId: invite.orgId });
    await deleteDoc(doc(this.fs, "invites", u.email.toLowerCase()));
    return this.resolveOrg();
  }

  col(name) { return this.m.collection(this.fs, "orgs", this.org.id, name); }
  on(name, cb) {
    this.m.onSnapshot(this.col(name), snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => console.error(name, err));
  }
  addTo(orgId, name, data) {
    return this.m.addDoc(this.m.collection(this.fs, "orgs", orgId, name), { ...data, createdAt: Date.now() }).then(r => r.id);
  }
  add(name, data) { return this.addTo(this.org.id, name, data); }
  update(name, id, data) { return this.m.updateDoc(this.m.doc(this.col(name), id), data); }
  remove(name, id) { return this.m.deleteDoc(this.m.doc(this.col(name), id)); }
  async bulkAdd(name, list) {
    const { writeBatch, doc } = this.m;
    for (let i = 0; i < list.length; i += 450) {           // Firestore batch limit is 500
      const b = writeBatch(this.fs);
      list.slice(i, i + 450).forEach(d => b.set(doc(this.col(name)), { ...d, createdAt: Date.now() }));
      await b.commit();
    }
  }
  async clearAll() {
    const { getDocs, writeBatch } = this.m;
    for (const name of ["stores", "brands"]) {
      const snap = await getDocs(this.col(name));
      for (let i = 0; i < snap.docs.length; i += 450) {
        const b = writeBatch(this.fs);
        snap.docs.slice(i, i + 450).forEach(d => b.delete(d.ref));
        await b.commit();
      }
    }
  }
  async listMembers() {
    const snap = await this.m.getDocs(this.col("members"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async invite(email, role) {
    const { doc, setDoc, serverTimestamp } = this.m;
    await setDoc(doc(this.fs, "invites", email.toLowerCase().trim()),
      { orgId: this.org.id, orgName: this.org.name, role, invitedBy: this.user.email, createdAt: serverTimestamp() });
  }
  async placesSearch(query, bias) {
    const call = this.m.httpsCallable(this.fn, "placesSearch");
    const res = await call({ orgId: this.org.id, query, bias });
    return res.data.places;
  }
}

export async function createBackend() {
  if (!hasFirebase) return new DemoBackend();
  const b = new FirebaseBackend();
  await b.load();
  return b;
}
