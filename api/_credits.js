// Platform AI credits (MMK). Balance lives in orgs/{id}/billing/ai; every change is written to orgs/{id}/creditLog.
// Only the server (Admin SDK) writes these — Firestore rules make them read-only for clients.
import { FieldValue } from "firebase-admin/firestore";
import { db, HttpError } from "./_lib.js";

export const GATEWAYS = ["gemini", "claude", "openai", "openrouter", "fal"];

// What you sell: a list of AI options. Each has a gateway (whose key you pay), a model and its own MMK prices.
// Clients choose one of the enabled options in Brands & Team → AI.
export const DEFAULT_PRICING = {
  offers: [
    { id: "gemini", label: "Gemini", via: "gemini", model: "gemini-3.8-flash", enabled: true, prices: { insight: 500, branches: 2000 } },
    { id: "claude", label: "Claude", via: "claude", model: "claude-sonnet-5-5", enabled: true, prices: { insight: 1200, branches: 4000 } },
  ],
  defaultProvider: "gemini",
  packages: [{ name: "Starter", mmk: 50000 }, { name: "Growth", mmk: 150000 }, { name: "Business", mmk: 500000 }],
  contact: "Pay by KBZPay / WavePay, then send the receipt on Viber. Credits are added within 1 business day.",
};

export async function getPricing() {
  const p = (await db().doc("platform/pricing").get()).data() || {};
  let offers = p.offers;
  if (offers && !Array.isArray(offers)) offers = Object.entries(offers).map(([k, o]) => ({ id: k, via: k, ...o }));   // older format
  return { ...DEFAULT_PRICING, ...p, offers: offers?.length ? offers : DEFAULT_PRICING.offers };
}

// Your keys (Vercel env vars) — set only the gateways you use:
//   PLATFORM_GEMINI_KEY, PLATFORM_CLAUDE_KEY, PLATFORM_OPENAI_KEY, PLATFORM_OPENROUTER_KEY, PLATFORM_FAL_KEY
export function platformKeys() {
  const k = Object.fromEntries(GATEWAYS.map(g => [g, process.env[`PLATFORM_${g.toUpperCase()}_KEY`]]));
  const legacy = process.env.PLATFORM_AI_PROVIDER;
  if (legacy && process.env.PLATFORM_AI_KEY && !k[legacy]) k[legacy] = process.env.PLATFORM_AI_KEY;
  return Object.fromEntries(Object.entries(k).filter(([, v]) => v));
}

/** The option this workspace uses: its own choice if offered, else your default, else any offered one. */
export function platformChoice(task, pricing, chosen) {
  const keys = platformKeys();
  const find = id => pricing.offers.find(o => o.id === id && o.enabled && keys[o.via]);
  const o = find(chosen) || find(pricing.defaultProvider) || pricing.offers.find(x => x.enabled && keys[x.via]);
  if (!o) return null;
  return { provider: o.via, key: keys[o.via], model: o.model, offer: o.id, price: task === "test" ? 0 : +o.prices?.[task] || 0 };
}

export function platformAI() {       // summary for the admin page
  const keys = Object.keys(platformKeys());
  return keys.length ? { providers: keys } : null;
}

export async function balance(orgId) {
  return (await db().doc(`orgs/${orgId}/billing/ai`).get()).data()?.balance || 0;
}

/** Add (positive) or remove (negative) credits atomically, with a ledger entry. */
export async function adjust(orgId, amount, entry) {
  const ref = db().doc(`orgs/${orgId}/billing/ai`);
  let after = 0;
  await db().runTransaction(async t => {
    const cur = (await t.get(ref)).data()?.balance || 0;
    after = Math.round(cur + amount);
    // balance was checked before the AI call; a concurrent call may dip slightly below 0 — the next call is then refused
    t.set(ref, { balance: after, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    t.create(db().collection(`orgs/${orgId}/creditLog`).doc(), { ...entry, amount: Math.round(amount), balanceAfter: after, at: FieldValue.serverTimestamp() });
  });
  return after;
}
