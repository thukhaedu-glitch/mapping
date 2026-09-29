// Bring-your-own-key AI: one small client for Claude, ChatGPT (OpenAI) and Gemini.
// Used by the Vercel API route (api/ai.js, key stays on the server) and by demo mode (key in this browser only).

export const PROVIDERS = {
  claude: { label: "Claude (Anthropic)", keyUrl: "https://console.anthropic.com/settings/keys", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"] },
  openai: { label: "ChatGPT (OpenAI)", keyUrl: "https://platform.openai.com/api-keys", models: ["gpt-5.4-mini", "gpt-5.4", "gpt-5"] },
  gemini: { label: "Gemini (Google)", keyUrl: "https://aistudio.google.com/apikey", models: ["gemini-3.8-flash", "gemini-3.1-flash-lite"] },
};

/**
 * callAI({ provider, key, model, system, prompt, web, browser })
 *   web     – let the model search the web (Claude web_search, OpenAI web_search, Gemini google_search)
 *   browser – true when called from a browser (Claude needs an explicit opt-in header for that)
 * → { text, sources: [{ title, url }] }
 */
export async function callAI(o) {
  if (!o.key) throw new Error("No AI API key saved for this workspace yet (Brands & Team → AI).");
  const model = o.model || PROVIDERS[o.provider]?.models[0];
  if (o.provider === "claude") return claude({ ...o, model });
  if (o.provider === "openai") return openai({ ...o, model });
  if (o.provider === "gemini") return gemini({ ...o, model });
  throw new Error("Unknown AI provider");
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error?.type || `AI provider error ${r.status}`);
  return j;
}

async function claude({ key, model, system, prompt, web, browser }) {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (browser) headers["anthropic-dangerous-direct-browser-access"] = "true";
  const messages = [{ role: "user", content: prompt }];
  const body = { model, max_tokens: 4096, system, messages };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];
  let j, content = [];
  for (let turn = 0; turn < 4; turn++) {                      // long web-search turns may pause; continue them
    j = await post("https://api.anthropic.com/v1/messages", headers, body);
    content = content.concat(j.content || []);
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }
  const text = content.filter(b => b.type === "text").map(b => b.text).join("");
  const sources = [];
  for (const b of content) {
    for (const c of b.citations || []) if (c.url) sources.push({ title: c.title || c.url, url: c.url });
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(r => r.url && sources.push({ title: r.title || r.url, url: r.url }));
  }
  return { text, sources: dedupe(sources) };
}

async function openai({ key, model, system, prompt, web }) {
  const body = { model, instructions: system, input: prompt };
  if (web) body.tools = [{ type: "web_search" }];
  const j = await post("https://api.openai.com/v1/responses", { Authorization: `Bearer ${key}` }, body);
  let text = "", sources = [];
  for (const item of j.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) {
      if (c.type === "output_text") {
        text += c.text;
        (c.annotations || []).forEach(a => a.url && sources.push({ title: a.title || a.url, url: a.url }));
      }
    }
  }
  return { text: text || j.output_text || "", sources: dedupe(sources) };
}

async function gemini({ key, model, system, prompt, web }) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (web) body.tools = [{ google_search: {} }];
  const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, body);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean).map(w => ({ title: w.title || w.uri, url: w.uri }));
  if (!text) throw new Error(cand?.finishReason ? `Gemini stopped: ${cand.finishReason}` : "Gemini returned no text");
  return { text, sources: dedupe(sources) };
}

const dedupe = list => [...new Map(list.map(s => [s.url, s])).values()].slice(0, 12);

/** Pull the first JSON array/object out of a model reply (handles ```json fences and chatter). */
export function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) throw new Error("AI reply contained no JSON");
  const open = src[start], close = open === "[" ? "]" : "}";
  const end = src.lastIndexOf(close);
  return JSON.parse(src.slice(start, end + 1));
}

/* ------------------------------------------------------------------ tasks */

export function insightTask(stats, lang) {
  return {
    web: false,
    system: "You are a retail location analyst for restaurant and retail chains in Myanmar. Be concrete and brief; base every claim only on the numbers given. Never invent data. If a number is missing, say it is missing.",
    prompt:
      `Write a store trade-area assessment in ${lang === "my" ? "Burmese (Myanmar language, Unicode)" : "English"}.\n` +
      "Format: a one-line verdict, then 4–6 short bullet points (competition pressure, nearest rivals, size vs competitors, population per store, area activity if given), then 2–3 concrete recommendations.\n" +
      "Population figures are WorldPop 2020 model estimates; drive times ignore traffic.\n\nDATA (JSON):\n" + JSON.stringify(stats, null, 1),
  };
}

export function branchesTask(brand, area) {
  return {
    web: true,
    system: "You research store/branch locations for retail chains. You only report branches you found in a source during this search. You never guess coordinates.",
    prompt:
      `Find all current branches/outlets of "${brand}" in ${area || "Myanmar"}. Check the brand's official website and Facebook page, food-delivery apps and news.\n` +
      "Return ONLY a JSON array, no other text. Each item:\n" +
      '{"name": branch name, "address": street address, "township": township, "city": city, "lat": number|null, "lng": number|null, "mapsUrl": Google Maps link if a source gives one else null, "source": URL where you found it, "status": "open"|"closed"|"unknown"}\n' +
      "Use null for lat/lng unless a source states the coordinates or links a map pin. Exclude branches reported as permanently closed unless status is unclear.",
  };
}
