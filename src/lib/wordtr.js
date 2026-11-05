/* English → Arabic for the two popups (double-click a word · select a sentence).
   v3.13: BOTH use Google Translate only (free public endpoint, no key, no Gemini tokens). Nothing here ever calls Gemini.
   Answers are cached (memory + localStorage), so the same word / sentence is never translated twice. */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { fixText } from "./text.js";

const LS = "nclex:wtr:v2";
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

/* only Google's own answers are cached (old v1 entries could hold Gemini meanings, so the key was bumped) */
export const cachedMeaning = (word) => mem.get(word.toLowerCase()) || readCache()[word.toLowerCase()] || "";

/* Google's public translate endpoint (no key). Works for a word and for a whole sentence. */
async function googleTranslate(text, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
  let data = null, netErr = null;
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) netErr = new Error("HTTP " + r.status);
    else data = await r.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    netErr = e;
  }
  if (!data && Capacitor.isNativePlatform()) {      // WebView blocked by CORS / network → native client
    try { const n = await CapacitorHttp.get({ url, readTimeout: 12000, connectTimeout: 6000 }); data = typeof n.data === "string" ? JSON.parse(n.data) : n.data; netErr = null; } catch (x) { netErr = x; }
  }
  if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  if (!data) throw Object.assign(new Error("مفيش اتصال بخدمة ترجمة جوجل. اتأكد من النت."), { detail: String((netErr && netErr.message) || netErr || "") });
  const t = data[0] && data[0].map((x) => x && x[0]).filter(Boolean).join("");
  return fixText(String(t || "").replace(/\s+/g, " ").trim());
}

/* ── word ── */
export async function translateWord({ word, signal, onQuick }) {
  const key = word.toLowerCase();
  const hit = cachedMeaning(word);
  if (hit) return hit;
  const g = await googleTranslate(word, signal);
  if (g) { mem.set(key, g); writeCache(key, g); if (onQuick && !(signal && signal.aborted)) onQuick(g); }
  return g;
}

/* ── sentence (selected text) ── */
const LS_S = "nclex:str:v1";
const smem = new Map();
const sKey = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
function readS() { try { return JSON.parse(window.localStorage.getItem(LS_S)) || {}; } catch (e) { return {}; } }
function writeS(k, v) {
  try {
    const all = readS();
    delete all[k]; all[k] = v;                       // most recent last
    const keys = Object.keys(all);
    if (keys.length > 250) for (const old of keys.slice(0, keys.length - 250)) delete all[old];
    window.localStorage.setItem(LS_S, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}
export const cachedSentence = (text) => { const k = sKey(text); return smem.get(k) || readS()[k] || ""; };

export const MAX_SENTENCE = 900;
export async function translateSentence({ text, signal }) {
  const k = sKey(text);
  const hit = cachedSentence(text);
  if (hit) return hit;
  const g = await googleTranslate(text.slice(0, MAX_SENTENCE), signal);
  if (g) { smem.set(k, g); writeS(k, g); }
  return g;
}
