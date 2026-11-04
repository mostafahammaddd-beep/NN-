/* ───────────── Gemini networking ─────────────
   Goals: first text on screen in ~1–2 s, never block on housekeeping calls, never wait for a slow
   model when another one can answer.

   • STREAMING (SSE) through the WebView fetch → text is shown while it is still being written.
   • NO blocking "list models" round trip before analysing (cached list + safe defaults; refreshed in background).
   • HEDGED fallback: if a model has not produced its first token after `hedgeMs`, the next model is started
     in parallel and the first one to answer wins (an overloaded model can no longer stall the whole task).
   • Thinking level is remembered per model (no repeated 400 round trips).
   • "Sign of life" = any streamed part, INCLUDING Gemini's thought summaries (includeThoughts). A model that is
     busy thinking is therefore never mistaken for a stalled one (no wasted duplicate requests), and a model that
     dies while thinking is replaced by the next one before the user has seen anything.
   • systemInstruction carries the static prompt → Gemini's implicit cache can reuse it between runs.
   • Models that are unavailable for the key (404 / quota 0) are remembered for 6 h, even across app restarts.
   • If WebView fetch cannot reach Google (CORS / network), it falls back to the native Capacitor HTTP client
     (non-streaming) automatically.                                                                       */

import { Capacitor, CapacitorHttp } from "@capacitor/core";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
import { trackRequest, noteQuota } from "./usage.js";
export const ENV_KEY = ENV.VITE_GEMINI_API_KEY || "";
export const API_BASE = ENV.VITE_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

/* ── errors ── */

export function friendlyError(status, message) {
  const m = (message || "").toLowerCase();
  if (/api key|api_key/.test(m) || status === 401 || status === 403)
    return "مفتاح الـ API مش مقبول أو مالوش صلاحية. اتأكد من المفتاح من أيقونة 🔑 فوق.";
  if (status === 429) return "وصلت للحد المسموح من الطلبات. استنى دقيقة وجرّب تاني.";
  if (status === 400 && /pdf|document/.test(m)) return "ملف الـ PDF مش مقروء أو مش مدعوم. جرّب ملف تاني أو صوّر الصفحة.";
  if (status === 400 && m.includes("image")) return "الصورة مش واضحة أو مش مدعومة. جرّب صورة تانية.";
  if (status >= 500) return "سيرفرات Google مشغولة دلوقتي. جرّب تاني بعد شوية.";
  return "حصلت مشكلة أثناء التحليل.";
}

function apiError(status, bodyText) {
  let message = "";
  try { message = JSON.parse(bodyText)?.error?.message || ""; } catch (e) { message = String(bodyText || "").slice(0, 200); }
  return classify(status, message);
}

function classify(status, message) {
  const m = (message || "").toLowerCase();
  const err = new Error(friendlyError(status, message));
  err.status = status;
  err.detail = `HTTP ${status} · ${message || ""}`.slice(0, 400);
  err.thinking = status === 400 && /thinking|thought/.test(m);
  err.fatal = !err.thinking && (
    status === 401 ||
    /api key not valid|api_key_invalid|api key expired|invalid api key|api key not found|api key is missing/.test(m) ||
    (status === 403 && /api key|api_key|referer|ip address|has not been used|is disabled/.test(m))
  );
  if (status === 429) noteQuota(message);
  err.dead = status === 404 || (status === 429 && /limit:\s*0/.test(m)) || (status === 403 && !err.fatal);
  return err;
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const timeoutError = (what) =>
  Object.assign(new Error("الطلب أخد وقت أطول من اللازم واتقطع. جرّب تاني أو اختار وضع أسرع."), { detail: `timeout (${what})`, timeout: true });

/* ── plain (non-stream) requests: model list, connection test ── */

function normalizeResponse(status, data) {
  let json = data;
  if (typeof data === "string") { try { json = JSON.parse(data); } catch (e) { json = {}; } }
  return { status, json: json && typeof json === "object" ? json : {} };
}

export async function rawRequest(method, url, body, timeoutMs) {
  const errors = [];
  if (Capacitor.isNativePlatform()) {
    try {
      const opts = { url, method, headers: { "Content-Type": "application/json" }, connectTimeout: 30000, readTimeout: timeoutMs };
      if (body !== undefined) opts.data = body;
      const r = await CapacitorHttp.request(opts);
      return normalizeResponse(r.status, r.data);
    } catch (e) { errors.push("native: " + String((e && e.message) || e)); }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { method, headers: { "Content-Type": "application/json" }, signal: ctrl.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    clearTimeout(timer);
    return normalizeResponse(res.status, text);
  } catch (e) {
    errors.push("webview: " + (e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e)));
  }
  throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: errors.join(" | ") });
}

/* ── model lists (cached, never blocking) ── */

const DEFAULT_LISTS = {
  fast: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"],
  pro: ["gemini-pro-latest", "gemini-2.5-pro"],
};
const LS_MODELS = "nclex:models:v3";
const keyTag = (k) => (k || "").slice(-8);
let _lists = null;

/* models that are unavailable for this key (404 / quota 0): remembered across restarts for a few hours,
   so the first analysis of a new session does not waste a round trip on a model that cannot answer */
const LS_DEAD = "nclex:dead:v1";
const DEAD_TTL = 6 * 3600e3;
let _deadMem = null;
function deadMap(apiKey) {
  const k = keyTag(apiKey);
  if (_deadMem && _deadMem.k === k) return _deadMem.map;
  let map = {};
  try { const raw = JSON.parse(window.localStorage.getItem(LS_DEAD)); if (raw && raw.k === k && raw.map) map = raw.map; } catch (e) { /* ignore */ }
  _deadMem = { k, map };
  return map;
}
const deadSet = (apiKey) => {
  const map = deadMap(apiKey), now = Date.now();
  return new Set(Object.keys(map).filter((m) => map[m] > now));
};
const addDead = (apiKey, model) => {
  const map = deadMap(apiKey);
  map[model] = Date.now() + DEAD_TTL;
  try { window.localStorage.setItem(LS_DEAD, JSON.stringify({ k: keyTag(apiKey), map })); } catch (e) { /* ignore */ }
};
const clearDead = () => {
  _deadMem = null;
  try { window.localStorage.removeItem(LS_DEAD); } catch (e) { /* ignore */ }
};

const modelRank = (n) => {
  const tier = /pro/.test(n) ? 2 : /lite/.test(n) ? 0 : 1;
  const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
  const base = /latest$/.test(n) ? 500 : (v ? parseFloat(v) * 10 : 0);
  return tier * 1000 + base - (/preview|exp/.test(n) ? 1 : 0);
};

export function getModelLists(apiKey) {
  if (_lists && _lists.k === keyTag(apiKey)) return _lists.lists;
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
    if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 3 * 864e5) { _lists = raw; return raw.lists; }
  } catch (e) { /* ignore */ }
  return DEFAULT_LISTS;
}

export async function refreshModels(apiKey, { force = false } = {}) {
  if (!apiKey) return DEFAULT_LISTS;
  if (!force) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
      if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 864e5) { _lists = raw; return raw.lists; }
    } catch (e) { /* ignore */ }
  }
  const { status, json } = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 30000);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const found = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-/.test(m.name)
      && !/image|tts|audio|live|embed|robotics|computer|learnlm|gemma|aqa|vision|deep-research|customtools/i.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .sort((x, y) => modelRank(y) - modelRank(x));
  const pro = found.filter((n) => /pro/.test(n)).slice(0, 3);
  const flash = found.filter((n) => !/pro/.test(n) && !/lite/.test(n)).slice(0, 3);
  const lite = found.filter((n) => /lite/.test(n)).slice(0, 1);
  const fast = [...flash, ...lite];
  const lists = {
    fast: fast.length ? fast : (pro.length ? pro : DEFAULT_LISTS.fast),
    pro: pro.length ? pro : (flash.length ? flash : DEFAULT_LISTS.pro),
  };
  _lists = { k: keyTag(apiKey), t: Date.now(), lists };
  clearDead();
  try { window.localStorage.setItem(LS_MODELS, JSON.stringify(_lists)); } catch (e) { /* ignore */ }
  return lists;
}

export async function testConnection(apiKey) {
  const { fast, pro } = await refreshModels(apiKey, { force: true });
  return `${pro[0]} + ${fast[0]}`;
}

/* Fire-and-forget: refreshes the model list in the background. */
export function warmUp(apiKey) {
  if (!apiKey) return;
  refreshModels(apiKey).catch(() => {});
}

/* Opens the DNS + TLS + HTTP/2 connection to Google BEFORE the user presses "analyse", so the three
   parallel requests reuse one hot connection instead of each paying the handshake (≈ 0.3–0.8 s on mobile). */
let _warmAt = 0;
export function warmConnection(apiKey) {
  if (!apiKey || Date.now() - _warmAt < 45000) return;
  _warmAt = Date.now();
  try {
    fetch(`${API_BASE}?pageSize=1&key=${encodeURIComponent(apiKey)}`, { method: "GET", cache: "no-store" })
      .then((r) => r.arrayBuffer()).catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ── thinking control ──
   Gemini 3.x uses thinkingLevel, 2.x uses thinkingBudget. The first rung that works is remembered. */

const is2x = (model) => /gemini-2\./.test(model);

function ladderFor(model, spec) {
  // Gemini 2.5 Pro cannot switch thinking off (minimum 128): asking for 0 would waste a 400 round trip
  const bud = { thinkingBudget: is2x(model) && /pro/.test(model) ? Math.max(128, spec.budget) : spec.budget };
  if (is2x(model)) return [bud, null];
  return [...spec.levels.map((l) => ({ thinkingLevel: l })), bud, null];
}

const memoKey = (model, task) => `nclex:tl:${model}|${task}`;
const readMemo = (model, task) => { try { return parseInt(window.localStorage.getItem(memoKey(model, task)) || "0", 10) || 0; } catch (e) { return 0; } };
const writeMemo = (model, task, i) => { try { window.localStorage.setItem(memoKey(model, task), String(i)); } catch (e) { /* ignore */ } };

const tempFor = (task) => (/^solve/.test(task) ? 0.2 : /^lesson/.test(task) ? 0.4 : 0.1);

function genConfig(model, think, maxOut, task) {
  const g = { maxOutputTokens: maxOut };
  if (is2x(model)) g.temperature = tempFor(task); // Gemini 3: keep Google's default temperature
  if (think) {
    const t = { ...think };
    // thought summaries stream while the model thinks → proof of life (never shown to the student)
    if (t.thinkingBudget !== 0 && t.thinkingLevel !== "minimal") t.includeThoughts = true;
    g.thinkingConfig = t;
  }
  return g;
}

/* ── one streaming request (SSE over fetch) ── */

function readParts(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  const alive = parts.some((p) => typeof p.text === "string"); // visible text OR a thought summary
  return { text, alive, finish: cand?.finishReason || null, block: json?.promptFeedback?.blockReason || null };
}

async function fetchStream({ apiKey, model, body, signal, onText, onAlive, firstMs, idleMs = 45000 }) {
  if (signal.aborted) throw abortError();
  const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const link = () => ctrl.abort();
  signal.addEventListener("abort", link);
  let timer = null, why = null;
  const arm = (ms, w) => { clearTimeout(timer); timer = setTimeout(() => { why = w; ctrl.abort(); }, ms); };
  arm(firstMs, "first-byte");

  let full = "", finish = null, block = null;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json;
    try { json = JSON.parse(payload); } catch (e) { return; }
    if (json.error) throw classify(json.error.code || 500, json.error.message || "");
    const r = readParts(json);
    if (r.alive && onAlive) onAlive();
    if (r.finish) finish = r.finish;
    if (r.block) block = r.block;
    if (r.text) { full += r.text; onText(full); }
  };

  try {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (why) throw timeoutError(why);
      throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "fetch: " + String((e && e.message) || e), netBeforeStart: true });
    }
    if (!res.ok) throw apiError(res.status, await res.text());
    arm(idleMs, "idle");

    const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
    if (!reader) {
      (await res.text()).split("\n").forEach((l) => handle(l.replace(/\r$/, "")));
    } else {
      const dec = new TextDecoder("utf-8");
      let buf = "";
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) {
          if (signal.aborted) throw abortError();
          if (why) throw timeoutError(why);
          throw Object.assign(new Error("النت قطع في نص التحميل. دوس إعادة المحاولة."), { detail: "stream: " + String((e && e.message) || e), interrupted: true });
        }
        if (chunk.done) break;
        arm(idleMs, "idle");
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf.replace(/\r$/, ""));
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", link);
  }
  return { text: full, finish, block };
}

/* Native (non-streaming) fallback — used only if WebView fetch cannot reach Google. */
async function nativeOnce({ apiKey, model, body, signal, onText, onAlive }) {
  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let r;
  try {
    r = await CapacitorHttp.request({ url, method: "POST", headers: { "Content-Type": "application/json" }, data: body, connectTimeout: 30000, readTimeout: 300000 });
  } catch (e) {
    if (signal.aborted) throw abortError();
    const msg = String((e && e.message) || e);
    if (/timeout|timed out/i.test(msg)) throw timeoutError("native");
    throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "native: " + msg });
  }
  if (signal.aborted) throw abortError();
  const { status, json } = normalizeResponse(r.status, r.data);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const out = readParts(json);
  if (out.alive && onAlive) onAlive();
  if (out.text) onText(out.text);
  return out;
}

let _noStreamUntil = 0;
async function streamOrNative(args) {
  if (Date.now() >= _noStreamUntil) {
    try { return await fetchStream(args); }
    catch (e) {
      if (!(e && e.netBeforeStart && Capacitor.isNativePlatform())) throw e;
      const out = await nativeOnce(args);          // WebView could not reach Google but native can
      _noStreamUntil = Date.now() + 10 * 60 * 1000; // stop retrying fetch for a while
      return out;
    }
  }
  return nativeOnce(args);
}

async function attemptModel({ apiKey, model, task, system, parts, spec, maxOut, signal, onText, onAlive, firstMs, idleMs }) {
  const rungs = ladderFor(model, spec);
  let idx = Math.min(readMemo(model, task), rungs.length - 1);
  for (;;) {
    const body = { contents: [{ role: "user", parts }], generationConfig: genConfig(model, rungs[idx], maxOut, task) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    try {
      trackRequest(model);                                       // every request counts against the daily quota
      const out = await streamOrNative({ apiKey, model, body, signal, onText, onAlive, firstMs, idleMs });
      if (!out.text.trim()) {
        throw Object.assign(new Error(out.block ? "السؤال اتحجب من فلتر الأمان بتاع Google. جرّب صورة تانية." : "الذكاء الاصطناعي رجّع رد فاضي. جرّب تاني."),
          { detail: `${model} · ${out.finish || out.block || "empty"}`, emptyReply: true });
      }
      writeMemo(model, task, idx);
      return out;
    } catch (e) {
      if (e.thinking && idx < rungs.length - 1) { idx += 1; continue; }
      if (e && !e.detail) e.detail = model;
      else if (e && e.detail && !e.detail.includes(model)) e.detail = `${model} · ${e.detail}`;
      throw e;
    }
  }
}

/* ── hedged race between models ──
   A model "claims" the race with its FIRST sign of life (a thought summary or visible text). From then on the
   other candidates are cancelled. If the claimer dies before anything was shown, the race re-opens and the next
   model starts at once; if text was already shown, the error is reported (we never silently switch mid-answer). */

function raceModels({ apiKey, models, run, hedgeMs, signal, onText }) {
  return new Promise((resolve, reject) => {
    const dead = deadSet(apiKey);
    const alive = models.filter((m) => !dead.has(m));
    const order = [...new Set(alive.length ? alive : models)];
    if (!order.length) return reject(new Error("مفيش موديل متاح دلوقتي."));

    const ctrls = [];
    let launched = 0, active = 0, winner = -1, shown = false, settled = false, lastErr = null, hedgeTimer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      ctrls.forEach((c) => c.abort());
      signal && signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal) {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", onAbort);
    }

    const claim = (i) => {
      if (settled) return false;
      if (winner === -1) {
        winner = i;
        clearTimeout(hedgeTimer);
        ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
      }
      return winner === i;
    };

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (winner === -1 && launched < order.length && hedgeMs) hedgeTimer = setTimeout(launch, hedgeMs);
    };

    function launch() {
      if (settled || winner !== -1 || launched >= order.length) return;
      const i = launched++;
      const model = order[i];
      const ctrl = new AbortController();
      ctrls[i] = ctrl;
      active++;
      run(
        model, ctrl.signal,
        (text) => { if (claim(i)) { shown = true; onText(text, model); } },
        () => { claim(i); },
      ).then((res) => {
        active--;
        if (settled || !claim(i)) return;
        finish(() => resolve({ ...res, model }));
      }).catch((err) => {
        active--;
        if (settled || ctrl.signal.aborted) return;       // lost the race on purpose
        if (err && err.dead) addDead(apiKey, model);
        if (winner === i) {
          if (!shown && !err.fatal && launched < order.length) {   // died while thinking: hand over, nothing was shown
            winner = -1; lastErr = err;
            launch(); armHedge();
            return;
          }
          return finish(() => reject(err));                 // the winner died mid-answer
        }
        lastErr = err;
        if (err.fatal) return finish(() => reject(err));
        if (launched < order.length) { launch(); armHedge(); }
        else if (active === 0) finish(() => reject(lastErr));
      });
      armHedge();
    }
    launch();
  });
}

/* public: run one task against a list of candidate models */
export function runTask({ apiKey, models, task, system, parts, spec, maxOut, hedgeMs, firstMs, idleMs, signal, onText }) {
  /* callers that only want the final text (word meaning, picture prompt, topics …) pass no onText / signal:
     the engine calls both unconditionally, so give it harmless defaults here, once, for every caller */
  if (typeof onText !== "function") onText = () => {};
  if (!signal) signal = new AbortController().signal;
  return raceModels({
    apiKey, models, hedgeMs, signal, onText,
    run: (model, sig, emit, alive) => attemptModel({ apiKey, model, task, system, parts, spec, maxOut, signal: sig, onText: emit, onAlive: alive, firstMs, idleMs }),
  });
}


/* ───────────── image generation (Nano Banana family) ─────────────
   The image models are NOT on Google's free tier, so the first answer for a free key is a clear message.
   Model ids change often → the list is read from the API for THIS key (cached 12 h); a static list is the fallback. */

const IMG_PREFERRED = ["gemini-3.1-flash-image", "gemini-nano-banana-2.1", "gemini-3.1-flash-image-preview", "gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image"];
const LS_IMG = "nclex:imgmodels:v1";

async function imageModels(apiKey) {
  try {
    const c = JSON.parse(window.localStorage.getItem(LS_IMG));
    if (c && c.key === apiKey.slice(-6) && Date.now() - c.at < 12 * 3600e3 && c.list.length) return c.list;
  } catch (e) { /* ignore */ }
  let names = [];
  try {
    const r = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 20000);
    names = ((r.json && r.json.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /image|banana/i.test(m.name) && !/imagen/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ""));
  } catch (e) { /* offline list → fall back */ }
  const rank = (n) => { const i = IMG_PREFERRED.indexOf(n); return i < 0 ? 99 : i; };
  const list = names.length ? [...names].sort((a, b) => rank(a) - rank(b)) : IMG_PREFERRED;
  try { window.localStorage.setItem(LS_IMG, JSON.stringify({ key: apiKey.slice(-6), at: Date.now(), list })); } catch (e) { /* ignore */ }
  return list;
}

export async function generateImage({ apiKey, prompt, parts = [], signal }) {
  const models = await imageModels(apiKey);
  let last = null;
  for (const model of models) {
    if (signal && signal.aborted) throw abortError();
    trackRequest(model);
    const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = { contents: [{ role: "user", parts: [...parts, { text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
    let r;
    try { r = await rawRequest("POST", url, body, 170000); }
    catch (e) { last = e; continue; }
    if (signal && signal.aborted) throw abortError();
    if (r.status === 200) {
      const ps = (((r.json.candidates || [])[0] || {}).content || {}).parts || [];
      const img = ps.find((p) => p.inlineData && /^image\//.test(p.inlineData.mimeType || "") && !p.thought);
      const text = ps.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
      if (img) {
        try { window.localStorage.setItem(LS_IMG, JSON.stringify({ key: apiKey.slice(-6), at: Date.now(), list: [model, ...models.filter((m) => m !== model)] })); } catch (e) { /* ignore */ }
        return { mime: img.inlineData.mimeType, data: img.inlineData.data, text, model };
      }
      last = Object.assign(new Error("الموديل ما رسمش صورة (ممكن الطلب اتحجب لأسباب أمان). جرّب توصف الصورة بشكل تاني."), { detail: `${model} · no image` });
      continue;
    }
    const msg = (r.json && r.json.error && r.json.error.message) || "";
    const err = classify(r.status, msg);
    if (r.status === 404 || /not found|not supported|unsupported|is not available/i.test(msg)) { last = err; continue; }
    if (r.status === 429 || r.status === 403 || /billing|paid|free.?tier/i.test(msg)) {
      throw Object.assign(new Error("إنشاء الصور في Gemini مش متاح في الباقة المجانية. فعّل الدفع (Billing) من Google AI Studio لو عايزه."), { detail: err.detail, billing: true });
    }
    throw err;
  }
  throw Object.assign(last || new Error("مفيش موديل رسم صور متاح مع المفتاح ده."), { billing: true });
}
