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

const DIAGRAM_SYSTEM = `You are a top information designer. You make beautiful, cheerful, perfectly organised educational infographics for an Arabic-speaking nursing student preparing for the NCLEX-RN.

OUTPUT: ONE self-contained SVG and NOTHING else (no markdown, no comments). It starts with <svg and ends with </svg>.

TECH (the SVG is shown inside an <img>): xmlns="http://www.w3.org/2000/svg", viewBox="0 0 1200 800" (900 900 for a cycle). No px width/height. No <script>, <foreignObject>, <image>, external URL, @import or web font. font-family="Arial, Helvetica, sans-serif". Keep the code SHORT: one <style> block with reusable classes, integers only, <use> for repeated shapes, gradients and one soft-shadow filter (feGaussianBlur) inside <defs>.
Palette: ink #0B2A30, teal #0E7C8F, sky #25A3DC, coral #E8664D, amber #F2B134, violet #6B5BD2, green #2FA56B, soft #EAF6F8 / #FFF4E0. Background: a very light gradient (#F4FBFC to #FFFFFF).

LAYOUT (this is what makes it look professional):
1. Plan a grid first: 40px margins, equal gaps. Header band (rounded, dark teal gradient, y 30-130) with the English title in white (48px bold) and a short subtitle in sky blue (26px).
2. Under it ONE clear structure: tree (root on top, 3-4 cards joined by elbow connectors) | numbered steps left to right with chevron arrows | cycle on a circle | 2-column compare with a "VS" badge | cause-to-effect chain | mnemonic letter cards.
3. Cards: equal size, rounded 24, white fill, a coloured header strip (about 64px) with white heading text, soft shadow. At most 4 bullets per card, each 1 to 5 words.
4. TEXT SIZE: headings 32, body 28, NEVER below 26. At most about 60 words in total. If it does not fit, cut words, never shrink the font. Roughly 14px per character at 28px: split long labels into short lines with separate <text> elements and make sure each line fits inside its card.
5. Fill the canvas: the content uses at least 85% of the width and height, no big empty areas, nothing overlapping, everything centred on its card (text-anchor="middle").
6. One simple icon per card: a coloured circle with a symbol, or one emoji (48px) in the header. Colour carries meaning: coral danger/abnormal, green safe/normal, amber caution, violet info, sky neutral, teal main.
7. If there is a key exam point, finish with a rounded "NCLEX Tip" strip (fill #FFF4E0, 26px text, one short sentence).

Labels are in ENGLISH, spelled exactly right. Arabic only if the student asks (direction="rtl", text-anchor="middle"). Medical accuracy first: never invent values, anatomy or drugs.
Before you output, check silently: well-formed XML, every tag closed, every text inside its card and the canvas.`;

async function runDiagram({ apiKey, ctx, request, atts, signal }) {
  const lists = getModelLists(apiKey);
  const refs = atts && atts.length ? sourceParts({ kind: "bundle", items: atts }, null) : [];
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await runTask({
      apiKey, task: "lesson:diagram", signal, models: [...lists.fast, ...lists.pro],
      system: DIAGRAM_SYSTEM + (last ? `\n\nYour previous SVG was not valid XML (${last}). Output a corrected, well-formed SVG.` : ""),
      parts: [...refs, { text: `CONTEXT — the question and lesson he is studying:\n${cap(ctx.question, 1800)}\n${cap(ctx.explanation, 1800)}\n\nSTUDENT REQUEST: ${request}\n\nDraw it as one SVG.` }],
      spec: { levels: ["minimal", "low"], budget: 0 }, maxOut: 9000, hedgeMs: 15000, firstMs: 60000, idleMs: 45000,
    });
    try { return { mime: "image/svg+xml", data: toB64(cleanSvg(out.text)), text: "" }; }
    catch (e) { last = e.svgError || e.message; if (attempt) throw e; }
  }
  throw new Error("الرسم ما طلعش صح. جرّب توصفه بشكل تاني.");
}

/* ── art: Pollinations (FLUX) ── */
const ART_STYLE = "highly detailed, sharp focus, vibrant harmonious colours, professional quality, no text, no letters, no watermark";
async function artPrompt({ apiKey, ctx, request, signal }) {
  if (/^[\x20-\x7E]+$/.test(request) && request.length < 220) return `${request}, ${ART_STYLE}`;   // already English → skip the extra model call (saves seconds)
  const lists = getModelLists(apiKey);
  const out = await runTask({
    apiKey, task: "word", signal, models: [...lists.fast, ...lists.pro],
    system: `You write prompts for a text-to-image model (FLUX). Output ONE English prompt, at most 70 words, nothing else.
Describe exactly what the student asks for, concretely and visually (subject, pose, setting, light, colours). If it is a medical / anatomy / process topic: a clean, modern, accurate flat-vector educational illustration on a soft pastel background. If it is an animal, object or scene: a beautiful, polished artwork of it. The model cannot spell, so there must be NO words, NO letters, NO numbers and NO labels in the picture.`,
    parts: [{ text: `Context (what the student studies):\n${cap(ctx.question, 500)}\n\nThe student asks for: ${request}` }],
    spec: { levels: ["minimal", "low"], budget: 0 }, maxOut: 300, hedgeMs: 2500, firstMs: 15000, idleMs: 12000,
  });
  const p = String(out.text || "").replace(/["\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `${p || request}, ${ART_STYLE}`;
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

const sleep = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms); signal && signal.addEventListener("abort", () => { clearTimeout(t); no(abortError()); }, { once: true }); });

async function runArt({ apiKey, ctx, request, signal, onStatus }) {
  const prompt = await artPrompt({ apiKey, ctx, request, signal });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=768&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
  /* one try, never longer than 60 s: if the free service hangs we fall through to the diagram engine instead of leaving the student waiting */
  const once = async () => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 60000), onA = () => c.abort();
    signal && signal.addEventListener("abort", onA, { once: true });
    try { return await fetchBlob(url, c.signal); }
    catch (e) { if (signal && signal.aborted) throw abortError(); throw new Error("خدمة الصور المجانية اتأخرت."); }
    finally { clearTimeout(t); signal && signal.removeEventListener("abort", onA); }
  };
  let res = await once();
  for (let i = 0; i < 3 && [429, 500, 502, 503, 504].includes(res.status); i++) {   // anonymous tier: busy → short retries instead of one long 16 s wait
    onStatus && onStatus("wait");
    await sleep(4000 + i * 3000, signal);
    res = await once();
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
