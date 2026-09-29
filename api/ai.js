// POST /api/ai  { orgId, task: "test"|"insight"|"branches", stats?, lang?, brand?, area? }
// mode "own":      the workspace's own AI key (bring-your-own-key) — they pay their provider.
// mode "platform": StoreRadar's key (PLATFORM_AI_* env vars) — each successful call is charged in MMK credits.
import { handle, requireMember, consume, db, HttpError } from "./_lib.js";
import { getPricing, platformChoice, balance, adjust } from "./_credits.js";
import { callAI, extractJSON, insightTask, branchesTask } from "../public/js/ai-core.js";

export default handle(async (body, req) => {
  const { orgId, task } = body;
  if (!["test", "insight", "branches"].includes(task)) throw new HttpError(400, "Unknown task");
  const roles = task === "branches" ? ["owner", "admin", "editor"] : ["owner", "admin", "editor", "viewer"];
  const { user } = await requireMember(req, orgId, roles, { requireActive: true });
  const settings = (await db().doc(`orgs/${orgId}/settings/ai`).get()).data() || {};
  const mode = settings.mode || (settings.provider ? "own" : "platform");    // new workspaces default to StoreRadar credits

  let routes, price = 0;
  if (mode === "platform") {
    const pricing = await getPricing();
    const c = platformChoice(task, pricing, settings.platformProvider);
    if (!c) throw new HttpError(503, "StoreRadar AI is not available right now. Use your own API key or contact support.");
    routes = [c]; price = c.price;
    const bal = await balance(orgId);
    if (bal < price) throw new HttpError(402, `Not enough AI credits: this costs ${price.toLocaleString()} MMK, balance is ${bal.toLocaleString()} MMK. Top up in Brands & Team → AI.`);
  } else {
    const secret = (await db().doc(`orgs/${orgId}/secrets/ai`).get()).data()?.key;
    if (!settings.provider || !secret) throw new HttpError(400, "No AI key saved for this workspace yet (Brands & Team → AI).");
    routes = [{ provider: settings.provider, model: settings.model, key: secret }];
  }
  await consume(orgId, "aiCalls", 2000);                       // abuse guard

  if (task === "branches" && (typeof body.brand !== "string" || !body.brand.trim())) throw new HttpError(400, "Brand name is required.");

  let result, used, lastErr;
  for (const base of routes) {
    try {
      if (task === "test") {
        const r = await callAI({ ...base, system: "Reply with exactly: OK", prompt: "ping" });
        result = { ok: true, reply: r.text.slice(0, 40), mode };
      } else if (task === "insight") {
        result = await callAI({ ...base, ...insightTask(body.stats || {}, body.lang === "my" ? "my" : "en") });
      } else {
        const r = await callAI({ ...base, ...branchesTask(body.brand.trim().slice(0, 80), String(body.area || "").slice(0, 80)) });
        const items = extractJSON(r.text);                      // throws → next provider
        result = { items: Array.isArray(items) ? items.slice(0, 150) : [], sources: r.sources };
      }
      used = base; break;
    } catch (e) { lastErr = e; console.error("AI provider failed", base.provider, base.model, e.message); }
  }
  if (!result) throw new HttpError(502, `AI failed: ${lastErr?.message || "no answer"}`);   // nothing charged
  result.provider = used.provider; result.model = used.model;

  if (price > 0) {                                             // charge only after a successful answer
    result.charged = price;
    result.balance = await adjust(orgId, -price, { type: "charge", task, by: user.email || user.uid, provider: used.provider, model: used.model, offer: used.offer || null });
  }
  return result;
});
