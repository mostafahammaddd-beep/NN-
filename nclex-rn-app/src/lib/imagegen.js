/* ───────────── Pictures in the chat — three engines, tried in order ─────────────
   Google does NOT give image generation to free API keys (confirmed by Google's own pricing page and forum staff).
   So the chat has two engines that work with a FREE key, and keeps Google's own image model for keys with billing:

     diagram  Gemini's free TEXT model writes an SVG drawing: labelled schemes, flow-charts, cycles, mnemonic cards.
              Always works with a free key, the words inside are spelled right (the thing that matters for study).
     art      a real text-to-image model (FLUX) through Pollinations.ai — free, no key, no sign-up. The words
              "no text inside the picture" are added, because image models cannot spell. ~1 picture / 15 s.
     gemini   Google's Nano Banana models — only works when the API key has billing enabled.

   Order for each choice:  diagram → [diagram]   art → [art, diagram]   gemini → [gemini, art, diagram]  */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { getModelLists, runTask, generateImage } from "./gemini.js";
import { sourceParts } from "./docs.js";
import { fixText } from "./text.js";
import { imagePrompt } from "./chat.js";

export const ENGINES = [
  { id: "diagram", label: "رسم توضيحي", hint: "دقيق وبعناوين صح · مجاني" },
  { id: "art", label: "صورة فنية AI", hint: "صورة حقيقية · مجاني بدون مفتاح" },
  { id: "gemini", label: "Gemini 💳", hint: "أعلى جودة · بيحتاج Billing" },
];
const LABEL = { diagram: "رسم توضيحي", art: "صورة فنية", gemini: "Gemini" };
const LS_ENGINE = "nclex:imgengine";
const LS_BLOCK = "nclex:imgblock:gemini";

export const getEngine = () => { try { const e = window.localStorage.getItem(LS_ENGINE); return ENGINES.some((x) => x.id === e) ? e : "diagram"; } catch (e) { return "diagram"; } };
export const setEngine = (id) => { try { window.localStorage.setItem(LS_ENGINE, id); } catch (e) { /* ignore */ } };

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const cap = (s, n) => ((s || "").length > n ? (s || "").slice(0, n) + "…" : (s || ""));
const toB64 = (str) => btoa(unescape(encodeURIComponent(str)));

/* ── SVG: clean it, make sure it is well-formed, never let it run anything ── */
export function cleanSvg(raw) {
  let s = String(raw || "").replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("<svg"), b = s.lastIndexOf("</svg>");
  if (a < 0 || b < 0) throw new Error("الموديل ما رجّعش رسم صالح.");
  s = fixText(s.slice(a, b + 6))
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<image\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("|')(?!#)[^"']*\1/gi, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none");
  if (!/xmlns\s*=/.test(s.slice(0, 400))) s = s.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  const doc = new DOMParser().parseFromString(s, "image/svg+xml");
  const bad = doc.getElementsByTagName("parsererror")[0];
  if (bad) throw Object.assign(new Error("الرسم طلع بصيغة غلط."), { svgError: String(bad.textContent || "").slice(0, 160) });
  return s;
}

const DIAGRAM_SYSTEM = `You are a medical illustrator and information designer. You draw clean, accurate, well-labelled educational diagrams for an Arabic-speaking nursing student who is preparing for the NCLEX-RN.

OUTPUT: ONE self-contained SVG and NOTHING else — no markdown fence, no explanation. It starts with <svg and ends with </svg>.

TECHNICAL RULES (the SVG is shown inside an <img>, so anything outside these rules breaks):
- xmlns="http://www.w3.org/2000/svg" and viewBox="0 0 1200 800" (use 0 0 900 900 for a cycle or a body diagram). No width/height in px.
- No <script>, no <foreignObject>, no <image>, no external URLs, no @import, no web fonts. Only shapes, paths, text, gradients and markers defined inside <defs>.
- font-family="Arial, Helvetica, sans-serif". Text sizes 22 to 40. Every piece of text stays fully inside the viewBox and never overlaps another text or a shape that hides it. Leave 24px padding.
- Start with a white background rect. Palette: ink #0B2A30, teal #0E7C8F, sky #25A3DC, coral #E8664D, amber #F2B134, violet #6B5BD2, green #2FA56B, soft fills #EAF6F8 / #FFF4E0. Strokes 3 to 5.

DESIGN RULES:
- One idea per drawing: a title at the top (English, big), then the diagram, then (only if needed) a small legend. Number steps when order matters. Arrows: draw them with <marker> definitions.
- Labels are in ENGLISH (spelled exactly right), short (1 to 4 words). Arabic labels only if the student asks, and then use direction="rtl" and text-anchor="middle".
- Medical accuracy first: a schematic is fine, but never invent anatomy, values or drugs. Show the normal vs abnormal, the cause → effect chain, the decision tree or the mnemonic that the student asked for.
- Make it beautiful and uncluttered: rounded rectangles, consistent spacing, colour used for meaning (coral = danger / abnormal, green = safe / normal, amber = caution).

Before you output, check silently: well-formed XML, every tag closed, every label readable and inside the canvas, nothing overlaps.`;

async function runDiagram({ apiKey, ctx, request, atts, signal }) {
  const lists = getModelLists(apiKey);
  const refs = atts && atts.length ? sourceParts({ kind: "bundle", items: atts }, null) : [];
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await runTask({
      apiKey, task: "lesson:diagram", signal, models: [...lists.fast, ...lists.pro],
      system: DIAGRAM_SYSTEM + (last ? `\n\nYour previous SVG was not valid XML (${last}). Output a corrected, well-formed SVG.` : ""),
      parts: [...refs, { text: `CONTEXT — the question and lesson he is studying:\n${cap(ctx.question, 1800)}\n${cap(ctx.explanation, 1800)}\n\nSTUDENT REQUEST: ${request}\n\nDraw it as one SVG.` }],
      spec: { levels: ["low", "minimal"], budget: 1024 }, maxOut: 16000, hedgeMs: 12000, firstMs: 90000, idleMs: 70000,
    });
    try { return { mime: "image/svg+xml", data: toB64(cleanSvg(out.text)), text: "" }; }
    catch (e) { last = e.svgError || e.message; if (attempt) throw e; }
  }
  throw new Error("الرسم ما طلعش صح. جرّب توصفه بشكل تاني.");
}

/* ── art: Pollinations (FLUX) ── */
async function artPrompt({ apiKey, ctx, request, signal }) {
  const lists = getModelLists(apiKey);
  const out = await runTask({
    apiKey, task: "word", signal, models: [...lists.fast, ...lists.pro],
    system: `You write prompts for a text-to-image model (FLUX). Output ONE English prompt, at most 80 words, nothing else.
Describe a clean, accurate, flat-colour educational medical illustration on a plain white background, with clear shapes and soft colours. The model cannot spell, so the picture must contain NO words, NO letters, NO numbers and NO labels. Describe the scene visually and concretely. Be medically accurate.`,
    parts: [{ text: `Context (what the student studies):\n${cap(ctx.question, 700)}\n${cap(ctx.explanation, 700)}\n\nThe student asks for: ${request}` }],
    spec: { levels: ["minimal", "low"], budget: 0 }, maxOut: 400, hedgeMs: 3500, firstMs: 25000, idleMs: 20000,
  });
  const p = String(out.text || "").replace(/["\n]+/g, " ").replace(/\s+/g, " ").trim();
  return p || request;
}

async function fetchBlob(url, signal) {
  let r;
  try { r = await fetch(url, { signal }); }
  catch (e) {
    if (e && e.name === "AbortError") throw e;
    if (!Capacitor.isNativePlatform()) throw e;
    const n = await CapacitorHttp.request({ url, method: "GET", responseType: "blob", readTimeout: 120000, connectTimeout: 30000 });   // WebView could not reach it, native can
    return { status: n.status, mime: (n.headers && (n.headers["Content-Type"] || n.headers["content-type"])) || "image/jpeg", b64: n.data, size: String(n.data || "").length * 0.75 };
  }
  const blob = await r.blob();
  const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => rej(new Error("read")); fr.readAsDataURL(blob); });
  return { status: r.status, mime: blob.type || "image/jpeg", b64, size: blob.size };
}

async function runArt({ apiKey, ctx, request, signal, onStatus }) {
  const prompt = await artPrompt({ apiKey, ctx, request, signal });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=768&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
  let res = await fetchBlob(url, signal);
  if (res.status === 429) {                                          // anonymous tier: one picture every ~15 s
    onStatus && onStatus("wait");
    await new Promise((ok, no) => { const t = setTimeout(ok, 16000); signal && signal.addEventListener("abort", () => { clearTimeout(t); no(abortError()); }, { once: true }); });
    res = await fetchBlob(url, signal);
  }
  if (res.status !== 200 || !/^image\//.test(res.mime) || res.size < 3000) throw new Error(res.status === 429 ? "خدمة الصور المجانية مشغولة دلوقتي." : "خدمة الصور المجانية ما ردّتش.");
  return { mime: res.mime, data: res.b64, text: "" };
}

/* ── Google's own model (only with billing) ── */
async function runGemini({ apiKey, ctx, request, atts, signal }) {
  try { if (+window.localStorage.getItem(LS_BLOCK) > Date.now()) throw Object.assign(new Error("الباقة المجانية مش بتدعم رسم الصور في Gemini."), { skip: true }); } catch (e) { if (e.skip) throw e; }
  const refs = atts && atts.length ? sourceParts({ kind: "bundle", items: atts }, null) : [];
  try {
    const out = await generateImage({ apiKey, prompt: imagePrompt(ctx, request), parts: refs, signal });
    return { mime: out.mime, data: out.data, text: out.text || "" };
  } catch (e) {
    if (e && e.billing) { try { window.localStorage.setItem(LS_BLOCK, String(Date.now() + 6 * 3600e3)); } catch (x) { /* ignore */ } }
    throw e;
  }
}

const RUN = { diagram: runDiagram, art: runArt, gemini: runGemini };

/* → { mime, data, text, engine, notes[] }   notes = what was tried and failed on the way */
export async function makePicture({ engine, apiKey, ctx, request, atts = [], signal, onStatus }) {
  const order = engine === "gemini" ? ["gemini", "art", "diagram"] : engine === "art" ? ["art", "diagram"] : ["diagram"];
  const notes = [];
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    if (signal && signal.aborted) throw abortError();
    try {
      onStatus && onStatus(e);
      const r = await RUN[e]({ apiKey, ctx, request, atts, signal, onStatus });
      return { ...r, engine: e, notes };
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      if (i === order.length - 1) throw err;
      notes.push(`${LABEL[e]}: ${(err && err.message) || "فشل"}`);
    }
  }
  throw new Error("معرفتش أرسم الصورة.");
}
