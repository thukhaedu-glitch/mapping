// Bring-your-own-key AI: one small client for Claude, ChatGPT (OpenAI) and Gemini.
// Used by the Vercel API route (api/ai.js, key stays on the server) and by demo mode (key in this browser only).

export const PROVIDERS = {
  claude: { label: "Claude (Anthropic)", keyUrl: "https://console.anthropic.com/settings/keys", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"] },
  openai: { label: "ChatGPT (OpenAI)", keyUrl: "https://platform.openai.com/api-keys", models: ["gpt-5.4-mini", "gpt-5.4", "gpt-5"] },
  gemini: { label: "Gemini (Google)", keyUrl: "https://aistudio.google.com/apikey", models: ["gemini-3.8-flash", "gemini-3.1-flash-lite"] },
  // Gateways: one key, many models (use OpenRouter model slugs like "anthropic/claude-sonnet-5.5")
  openrouter: { label: "OpenRouter (one key, all models)", keyUrl: "https://openrouter.ai/keys", models: ["google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5", "openai/gpt-5.4-mini"] },
  fal: { label: "fal (one key, all models)", keyUrl: "https://fal.ai/dashboard/keys", models: ["google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5", "openai/gpt-5.4-mini"] },
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
  if (o.provider === "openrouter") return chatCompat({ ...o, model, url: "https://openrouter.ai/api/v1/chat/completions", auth: `Bearer ${o.key}` });
  if (o.provider === "fal") return chatCompat({ ...o, model, url: "https://fal.run/openrouter/router/openai/v1/chat/completions", auth: `Key ${o.key}` });
  throw new Error("Unknown AI provider");
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error?.type || `AI provider error ${r.status}`);
  return j;
}

async function claude({ key, model, system, prompt, web, browser, maxTokens = 4096, maxSearches = 6 }) {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (browser) headers["anthropic-dangerous-direct-browser-access"] = "true";
  const messages = [{ role: "user", content: prompt }];
  const body = { model, max_tokens: maxTokens, system, messages };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];
  let j, content = [];
  for (let turn = 0; turn < 8; turn++) {                      // long web-search turns may pause; continue them
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

async function openai({ key, model, system, prompt, web, maxTokens }) {
  const body = { model, instructions: system, input: prompt };
  if (maxTokens > 4096) body.max_output_tokens = maxTokens + 8000;   // reasoning models spend part of it thinking
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

async function gemini({ key, model, system, prompt, web, maxTokens }) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (maxTokens > 4096) body.generationConfig = { maxOutputTokens: maxTokens + 8000 };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (web) body.tools = [{ google_search: {} }];
  const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, body);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean).map(w => ({ title: w.title || w.uri, url: w.uri }));
  if (!text) throw new Error(cand?.finishReason ? `Gemini stopped: ${cand.finishReason}` : "Gemini returned no text");
  return { text, sources: dedupe(sources) };
}

// OpenAI chat-completions compatible gateways. Web search uses OpenRouter's web plugin
// (the model's native search for Claude/Gemini/OpenAI). Through fal the plugin may be ignored — then no live web search.
async function chatCompat({ url, auth, model, system, prompt, web, maxTokens, maxSearches = 6 }) {
  const body = { model, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }] };
  if (maxTokens > 4096) body.max_tokens = maxTokens;
  if (web) body.plugins = [{ id: "web", max_results: Math.min(maxSearches, 10) }];
  const j = await post(url, { Authorization: auth }, body);
  const msg = j.choices?.[0]?.message || {};
  const text = typeof msg.content === "string" ? msg.content : (msg.content || []).map(c => c.text || "").join("");
  const sources = (msg.annotations || []).map(a => a.url_citation || a).filter(a => a?.url).map(a => ({ title: a.title || a.url, url: a.url }));
  if (!text) throw new Error("The AI gateway returned no text");
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
  try { return JSON.parse(src.slice(start, end + 1)); }
  catch (e) {
    // Reply cut off mid-list (hit the output limit): keep every complete {...} item
    if (open !== "[") throw e;
    const items = [];
    let depth = 0, from = -1, inStr = false, esc = false;
    for (let i = start + 1; i < src.length; i++) {
      const ch = src[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") { if (depth++ === 0) from = i; }
      else if (ch === "}" && --depth === 0 && from >= 0) { try { items.push(JSON.parse(src.slice(from, i + 1))); } catch {} from = -1; }
    }
    if (!items.length) throw e;
    return items;
  }
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
  const where = area || "Myanmar (the whole country)";
  return {
    web: true, maxTokens: 16000, maxSearches: 15,
    system: "You research store/branch locations for retail and restaurant chains in Myanmar and return map-ready data. You only report branches you found in a source during this search.",
    prompt:
      `Find ALL current branches/outlets of "${brand}" in ${where}. Be exhaustive: check the brand's official website / store locator, its Facebook page, food-delivery apps (Foodpanda, GrabFood), Google Maps listings, mall directories and news. ` +
      "If the area is a whole country, work city by city (Yangon, Mandalay, Naypyitaw, then other cities) so no branch is missed.\n" +
      "Coordinates are the most important field — the result goes straight onto a map. For each branch:\n" +
      '- if a source states the coordinates or links a Google Maps pin, use them and set "coord": "source";\n' +
      '- otherwise, if the branch is inside a known mall, landmark or on a specific street corner you can locate confidently, give that location\'s coordinates (5 decimals) and set "coord": "approx";\n' +
      '- otherwise use null for lat/lng and "coord": null. Never invent a location you cannot tie to the branch\'s address.\n' +
      "Return ONLY a JSON array, no other text. Each item:\n" +
      '{"name": branch name, "address": street address, "township": township, "city": city, "lat": number|null, "lng": number|null, "coord": "source"|"approx"|null, "mapsUrl": Google Maps link if a source gives one else null, "phone": phone or null, "source": URL where you found the branch, "status": "open"|"closed"|"unknown"}\n' +
      "Exclude branches reported as permanently closed.",
  };
}
