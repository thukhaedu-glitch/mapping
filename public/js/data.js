// Data layer — one API, two backends:
//   FirebaseBackend: multi-tenant Firestore (orgs/{orgId}/brands|stores|members)
//   DemoBackend:     in-browser only (localStorage), for trying the app without Firebase
import { firebaseConfig, functionsRegion, apiBase } from "./firebase-config.js";
import { callAI, extractJSON, insightTask, branchesTask } from "./ai-core.js";

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
  async popStats() { throw new Error("Browser blocked WorldPop (CORS). Deploy with Firebase Functions, or build the offline grid with tools/build_pop_grid.py."); }
  // Demo: AI key lives only in this browser and is sent straight to the provider.
  async getAISettings() { try { const a = JSON.parse(localStorage.getItem("sr-demo-ai") || "{}"); return { provider: a.provider, model: a.model, keyHint: a.key ? "…" + a.key.slice(-4) : "" }; } catch { return {}; } }
  async saveAISettings({ provider, model, key }) {
    let a = {}; try { a = JSON.parse(localStorage.getItem("sr-demo-ai") || "{}"); } catch {}
    a = { ...a, provider, model, ...(key ? { key } : {}) };
    try { localStorage.setItem("sr-demo-ai", JSON.stringify(a)); } catch {}
  }
  async ai(task, payload = {}) {
    let a = {}; try { a = JSON.parse(localStorage.getItem("sr-demo-ai") || "{}"); } catch {}
    const base = { provider: a.provider, model: a.model, key: a.key, browser: true };
    if (task === "test") { const r = await callAI({ ...base, system: "Reply with exactly: OK", prompt: "ping" }); return { ok: true, reply: r.text.slice(0, 40) }; }
    if (task === "insight") return callAI({ ...base, ...insightTask(payload.stats, payload.lang) });
    if (task === "branches") { const r = await callAI({ ...base, ...branchesTask(payload.brand, payload.area) }); return { items: extractJSON(r.text), sources: r.sources }; }
  }
  async listMembers() { return [{ id: "demo", email: "demo@local", role: "owner" }]; }
  async invite() { throw new Error("Demo mode မှာ member invite မရပါ။"); }
  async signOut() {}
}

/* -------------------------------------------------------------- FIREBASE */
class FirebaseBackend {
  constructor() { this.mode = "firebase"; this.org = null; this.user = null; }

  async load() {
    // Cloud Functions SDK is loaded only when first needed (Places / population proxy)
    const [app, auth, fs] = await Promise.all([
      import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js"),
    ]);
    this.m = { ...auth, ...fs };
    this.app = app.initializeApp(firebaseConfig);
    this.auth = auth.getAuth(this.app);
    try {
      // IndexedDB cache: repeat visits render from local data instantly, then sync
      this.fs = fs.initializeFirestore(this.app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
    } catch { this.fs = fs.getFirestore(this.app); }
  }
  async functions() {
    if (!this.fn) {
      const fn = await import(FB + "firebase-functions.js");
      this.m.httpsCallable = fn.httpsCallable;
      this.fn = fn.getFunctions(this.app, functionsRegion);
    }
    return this.fn;
  }

  onAuth(cb) { this.m.onAuthStateChanged(this.auth, u => { this.user = u; cb(u); }); }
  signIn(email, pw) { return this.m.signInWithEmailAndPassword(this.auth, email, pw); }
  signUp(email, pw) { return this.m.createUserWithEmailAndPassword(this.auth, email, pw); }
  signInGoogle() { return this.m.signInWithPopup(this.auth, new this.m.GoogleAuthProvider()); }
  resetPassword(email) { return this.m.sendPasswordResetEmail(this.auth, email); }
  signOut() { return this.m.signOut(this.auth); }

  _cacheKey() { return "sr-org-" + this.user.uid; }
  _saveOrg(org) { this.org = org; try { localStorage.setItem(this._cacheKey(), JSON.stringify({ id: org.id, name: org.name, role: org.role, status: org.status || "active" })); } catch {} }
  cachedOrg() { try { return JSON.parse(localStorage.getItem(this._cacheKey()) || "null"); } catch { return null; } }
  forgetOrg() { try { localStorage.removeItem(this._cacheKey()); } catch {} }

  // Returns {org} if the user already belongs to one, or {invite} if one is waiting, else {}.
  // Profile + invite are read in parallel (2 round trips max instead of 3 sequential).
  async resolveOrg() {
    const { doc, getDoc } = this.m;
    const u = this.user;
    const [profile, inv] = await Promise.all([
      getDoc(doc(this.fs, "users", u.uid)),
      getDoc(doc(this.fs, "invites", (u.email || "").toLowerCase())).catch(() => null),
    ]);
    if (profile.exists() && profile.data().orgId) {
      const orgId = profile.data().orgId;
      let org, mem;
      try {
        [org, mem] = await Promise.all([getDoc(doc(this.fs, "orgs", orgId)), getDoc(doc(this.fs, "orgs", orgId, "members", u.uid))]);
      } catch (e) {
        if (e.code === "permission-denied") return { blocked: true };   // rules deny reads of blocked workspaces
        throw e;
      }
      if (org.exists() && mem.exists()) { this._saveOrg({ id: orgId, ...org.data(), role: mem.data().role }); return { org: this.org }; }
    }
    this.forgetOrg();
    if (inv?.exists()) return { invite: inv.data() };
    return {};
  }

  async createOrg(name, profile = {}) {
    const { doc, collection, setDoc, serverTimestamp } = this.m;
    const u = this.user;
    const ref = doc(collection(this.fs, "orgs"));
    // Each write depends on the previous one in the security rules (org → owner → profile/brand),
    // so they must be sequential — but the last two run in parallel and we skip re-reading.
    await setDoc(ref, { name, ownerUid: u.uid, ownerEmail: u.email, plan: "free", status: "active", profile, createdAt: serverTimestamp() });
    await setDoc(doc(this.fs, "orgs", ref.id, "members", u.uid), { email: u.email, role: "owner", joinedAt: serverTimestamp() });
    await Promise.all([
      setDoc(doc(this.fs, "users", u.uid), { email: u.email, orgId: ref.id }),
      this.addTo(ref.id, "brands", { name, color: "#16a34a", isOwn: true, aliases: [] }),   // starter "ours" brand
    ]);
    this._saveOrg({ id: ref.id, name, plan: "free", status: "active", ownerUid: u.uid, role: "owner" });
    return { org: this.org };
  }

  async acceptInvite(invite) {
    const { doc, setDoc, deleteDoc, serverTimestamp } = this.m;
    const u = this.user;
    await setDoc(doc(this.fs, "orgs", invite.orgId, "members", u.uid), { email: u.email, role: invite.role, joinedAt: serverTimestamp() });
    await Promise.all([
      setDoc(doc(this.fs, "users", u.uid), { email: u.email, orgId: invite.orgId }),
      deleteDoc(doc(this.fs, "invites", u.email.toLowerCase())),
    ]);
    this._saveOrg({ id: invite.orgId, name: invite.orgName, role: invite.role });
    return { org: this.org };
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
  async getAISettings() {
    const d = await this.m.getDoc(this.m.doc(this.fs, "orgs", this.org.id, "settings", "ai"));
    return d.exists() ? d.data() : {};
  }
  /** Key goes to a write-only doc (rules: nobody can read it back); only a hint is kept in settings. */
  async saveAISettings({ provider, model, key }) {
    const { doc, setDoc, serverTimestamp } = this.m;
    if (key) await setDoc(doc(this.fs, "orgs", this.org.id, "secrets", "ai"), { key, updatedAt: serverTimestamp() });
    const data = { provider, model, updatedBy: this.user.email, updatedAt: serverTimestamp() };
    if (key) data.keyHint = "…" + key.slice(-4);
    await setDoc(doc(this.fs, "orgs", this.org.id, "settings", "ai"), data, { merge: true });
  }
  ai(task, payload = {}) {
    if (!apiBase) throw new Error("AI features need the Vercel API (apiBase = \"/api\").");
    return this.api("ai", { orgId: this.org.id, task, ...payload });
  }

  /** POST to the Vercel API with the user's Firebase ID token. */
  async api(path, body) {
    const token = await this.auth.currentUser.getIdToken();
    const r = await fetch(`${apiBase}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
    return j;
  }
  async popStats(lat, lng, radius) {
    if (apiBase) return (await this.api("population", { orgId: this.org.id, lat, lng, radius })).total;
    const res = await this.m.httpsCallable(await this.functions(), "populationStats")({ orgId: this.org.id, lat, lng, radius });
    return res.data.total;
  }
  async placesSearch(query, bias) {
    if (apiBase) return (await this.api("places", { orgId: this.org.id, query, bias })).places;
    const call = this.m.httpsCallable(await this.functions(), "placesSearch");
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
