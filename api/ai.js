// POST /api/ai  { orgId, task: "test"|"insight"|"branches", stats?, lang?, brand?, area? }
// Uses the workspace's own AI key (bring-your-own-key). The key is read here with the Admin SDK and never sent to browsers.
import { handle, requireMember, consume, db, HttpError } from "./_lib.js";
import { callAI, extractJSON, insightTask, branchesTask } from "../public/js/ai-core.js";

export default handle(async (body, req) => {
  const { orgId, task } = body;
  const roles = task === "branches" ? ["owner", "admin", "editor"] : ["owner", "admin", "editor", "viewer"];
  await requireMember(req, orgId, roles, { requireActive: true });
  const [settings, secret] = await Promise.all([db().doc(`orgs/${orgId}/settings/ai`).get(), db().doc(`orgs/${orgId}/secrets/ai`).get()]);
  const s = settings.data() || {}, key = secret.data()?.key;
  if (!s.provider || !key) throw new HttpError(400, "No AI key saved for this workspace yet (Brands & Team → AI).");
  await consume(orgId, "aiCalls", 2000);                    // abuse guard only — the workspace pays its own AI bill
  const base = { provider: s.provider, model: s.model, key };

  if (task === "test") {
    const r = await callAI({ ...base, system: "Reply with exactly: OK", prompt: "ping" });
    return { ok: true, reply: r.text.slice(0, 40) };
  }
  if (task === "insight") {
    const t = insightTask(body.stats || {}, body.lang === "my" ? "my" : "en");
    return await callAI({ ...base, ...t });
  }
  if (task === "branches") {
    if (typeof body.brand !== "string" || !body.brand.trim()) throw new HttpError(400, "Brand name is required.");
    const t = branchesTask(body.brand.trim().slice(0, 80), String(body.area || "").slice(0, 80));
    const r = await callAI({ ...base, ...t });
    let items = [];
    try { items = extractJSON(r.text); } catch { throw new HttpError(502, "The AI did not return a usable list. Try again or switch model."); }
    return { items: Array.isArray(items) ? items.slice(0, 150) : [], sources: r.sources };
  }
  throw new HttpError(400, "Unknown task");
});
