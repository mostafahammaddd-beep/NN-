/* One English word → its Arabic meaning (for the double-click popup). Fast model, tiny answer, cached forever. */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { getModelLists, runTask } from "./gemini.js";
import { fixText, ARABIC_RULE } from "./text.js";
import { wordLines, parseWord } from "./parse.js";

const LS = "nclex:wtr:v1";
const mem = new Map();

function readCache() {
  try { return JSON.parse(window.localStorage.getItem(LS)) || {}; } catch (e) { return {}; }
}
function writeCache(k, v) {
  try {
    const all = readCache();
    all[k] = v;
    const keys = Object.keys(all);
    if (keys.length > 600) for (const old of keys.slice(0, keys.length - 600)) delete all[old];
    window.localStorage.setItem(LS, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

/* meanings the app already has (the word lists of the analysed questions + the saved dictionary): a tap on such a word costs NO request */
let known = new Map();
export function setKnownWords(textBlocks) {
  const m = new Map();
  for (const t of textBlocks) for (const l of wordLines(t || "")) {
    const { term, meaning } = parseWord(l);
    const k = term.replace(/[*=«»]/g, "").trim().toLowerCase();
    if (k && meaning && !m.has(k)) m.set(k, meaning.replace(/[*=«»]/g, "").trim());
  }
  known = m;
}

export const cachedMeaning = (word) => mem.get(word.toLowerCase()) || known.get(word.toLowerCase()) || readCache()[word.toLowerCase()] || "";

/* INSTANT first answer (~0.3 s): Google's public translate endpoint, no key. Gemini then upgrades it with the meaning that fits the sentence. */
async function quickMeaning(word, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(word)}`;
  let data = null;
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return "";
    data = await r.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    if (!Capacitor.isNativePlatform()) return "";
    try { const n = await CapacitorHttp.get({ url, readTimeout: 8000, connectTimeout: 5000 }); data = typeof n.data === "string" ? JSON.parse(n.data) : n.data; } catch (x) { return ""; }
  }
  const t = data && data[0] && data[0].map((x) => x && x[0]).filter(Boolean).join("");
  return fixText(String(t || "").replace(/\s+/g, " ").trim());
}

export async function translateWord({ apiKey, word, context, signal, onQuick }) {
  const key = word.toLowerCase();
  const hit = cachedMeaning(word);
  if (hit) return hit;
  const quickP = quickMeaning(word, signal).then((q) => { if (q && !(signal && signal.aborted) && onQuick) onQuick(q); return q; }).catch((e) => { if (e && e.name === "AbortError") throw e; return ""; });
  let gErr = null;
  const lists = getModelLists(apiKey);
  const gem = runTask({
    apiKey, task: "word", models: [...lists.fast, ...lists.pro], signal,
    system: `You translate ONE English word for an Arabic-speaking nursing student (English level A2) who is preparing for the NCLEX-RN.
Reply with ONLY the Arabic meaning that fits the sentence the word appears in: at most 5 words, plain Arabic, no English, no quotes, no punctuation at the end. If it is a medical term, add after " — " a very short everyday explanation (at most 6 Arabic words).${ARABIC_RULE}`,
    parts: [{ text: `Word: ${word}\nSentence: ${String(context || "").slice(0, 300)}` }],
    spec: { levels: ["minimal", "low"], budget: 0 }, maxOut: 120, hedgeMs: 1800, firstMs: 12000, idleMs: 10000,
  }).then((out) => fixText(String(out.text || "").replace(/["“”«»\n]+/g, " ").replace(/\s+/g, " ").trim()))
    .catch((e) => { if (e && e.name === "AbortError") throw e; gErr = e; return ""; });
  const [g, q] = await Promise.all([gem, quickP]);
  if (g) { mem.set(key, g); writeCache(key, g); return g; }
  if (q) { mem.set(key, q); return q; }          // Gemini failed: keep the instant answer (kept in memory only, not persisted)
  if (gErr) throw gErr;
  return "";
}
