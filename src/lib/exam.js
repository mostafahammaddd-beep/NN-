/* ───────────── Exams made by the AI ─────────────
   The student says «اعملي امتحان 10 أسئلة على القلب» (or presses the exam button) → ONE request returns a JSON exam,
   which the chat shows as an interactive card (components/ExamCard.jsx).
   • built from the student's OWN saved questions / lessons when they match what he asked, otherwise from NCLEX knowledge
   • single-answer and "select all that apply" items; options are shuffled here (models love putting the key on B/C)  */

import { getModelLists, runTask } from "./gemini.js";
import { materialFor } from "./library.js";
import { sourceParts } from "./docs.js";
import { fixText, ARABIC_RULE } from "./text.js";

/* ── does this message ask for an exam? ── */
const CREATE = /(اعمل|اعملي|اعملّي|اعملى|اعملّى|هات|هاتلي|جهز|جهزلي|جهّز|اطلع|اطلعلي|ولد|ولّد|صمم|صمّم|اكتب|اكتبلي|ابني|اديني|عايز|عاوز|عاوزه|عايزه|محتاج|أريد|اريد|make|create|generate|give|build|prepare|write|i want|i need)/i;
const STRONG = /(امتحان|كويز|كويزات|quiz|exam|mcq|mock|practice test)/i;
const SOFT = /(اسئلة|أسئلة|اسئله|أسئله|questions)/i;          // "5 أسئلة على القلب" is an exam, "عندي أسئلة" is not
const WEAK = /(اختبار|test)/i;
const NOT_LAB = /(دم|بول|تحليل|ملخص|لخص|اشرح|شرح|blood|urine|lab|summary|explain)/i;
const DIRECT = /(امتحني|امتحنّي|اختبرني|اختبرنى|امتحنى|quiz me|test me|examine me)/i;

export function wantsExam(q) {
  const s = String(q || "");
  if (s.length > 500) return false;
  if (DIRECT.test(s)) return true;
  if (CREATE.test(s) && STRONG.test(s)) return true;
  if (CREATE.test(s) && SOFT.test(s) && /[\d\u0660-\u0669]|(^|\s)(خمسة|خمس|عشرة|عشر|عشرين|تلاتة|ثلاثة|اربعة|أربعة|ستة|سبعة|تمانية|تسعة)(\s|$)/.test(s)) return true;
  if (CREATE.test(s) && WEAK.test(s) && !NOT_LAB.test(s)) return true;
  return /^\s*(امتحان|كويز|quiz|exam)\b/i.test(s);
}

const AR_NUM = { "واحد": 1, "اتنين": 2, "اثنين": 2, "تلاتة": 3, "ثلاثة": 3, "تلات": 3, "اربعة": 4, "أربعة": 4, "اربع": 4, "خمسة": 5, "خمس": 5, "ستة": 6, "ست": 6, "سبعة": 7, "سبع": 7, "تمانية": 8, "ثمانية": 8, "تمن": 8, "تسعة": 9, "تسع": 9, "عشرة": 10, "عشر": 10, "خمستاشر": 15, "عشرين": 20 };
export function examCount(q) {
  const s = String(q || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
  const m = s.match(/(\d{1,2})/);
  if (m) return Math.max(1, Math.min(20, +m[1]));
  for (const [w, n] of Object.entries(AR_NUM)) if (new RegExp(`(^|\\s)${w}(\\s|$)`).test(s)) return n;
  return 5;
}

const SYSTEM = `You are a senior NCLEX-RN item writer. You write exam items that look and feel like the real NCLEX-RN, for an Arabic-speaking nursing student whose English is about A2 (keep the wording simple, but keep clinical terms in English).

WRITING RULES
- Each item = a short clinical scenario (age, setting, findings / lab values when useful) + ONE clear question. Test NCLEX thinking: priority, safety, ABCs, delegation, infection control, pharmacology, lab values, assessment before intervention, client teaching.
- Two item types: "single" (4 options, exactly one correct) and "multi" (select ALL that apply: 5 or 6 options, 2–4 correct). When the exam has 5 or more items, make about one in four a "multi". Fewer than 5 items → all "single".
- Distractors must be plausible and wrong for a clear clinical reason. Never use "all of the above" / "none of the above". Options similar in length. No trick wording, no ambiguity, no two defensible answers.
- Accuracy is everything: only standard, widely accepted nursing facts. Never invent doses, ranges or protocols. If a fact differs by region, avoid it.
- Different items must test different points (no near-duplicates).
- SOURCE: if "STUDENT MATERIAL" is given and it matches what the student asked for (or he asks for an exam from his own questions), build the items on the facts, rules and traps in it — with NEW scenarios and numbers, never copy a question he already solved. Otherwise use general NCLEX knowledge on the requested topic. If no topic is named and no material is given, write a balanced mixed set.
- "rationale": 2–4 short sentences: why the key is right and why the strongest wrong option fails. Casual Egyptian Arabic, medical terms and key English phrases stay in English. "topic": 1–3 words in English (e.g. "Heart failure").

OUTPUT: valid JSON only (no markdown fences, no commentary):
{"title":"<short Arabic title, e.g. امتحان قصور القلب>","intro":"<one friendly Arabic sentence>","questions":[{"type":"single","stem":"…","options":["…","…","…","…"],"correct":[0],"rationale":"…","topic":"…"}]}
"correct" lists the zero-based indexes of the right options.${ARABIC_RULE}`;

const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function clean(data, count) {
  const qs = (Array.isArray(data.questions) ? data.questions : []).map((q) => {
    const opts = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).replace(/^\s*\(?[A-Fa-f][).]\s+/, "").trim()).filter(Boolean);
    let correct = (Array.isArray(q.correct) ? q.correct : [q.correct]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < opts.length);
    correct = [...new Set(correct)];
    if (opts.length < 2 || !correct.length || !String(q.stem || "").trim()) return null;
    const type = q.type === "multi" && correct.length > 1 ? "multi" : "single";
    if (type === "single" && correct.length > 1) correct = [correct[0]];
    const order = shuffle(opts.map((_, i) => i));
    return {
      type,
      stem: fixText(String(q.stem).trim()),
      options: order.map((i) => fixText(opts[i])),
      correct: order.map((old, now) => (correct.includes(old) ? now : -1)).filter((n) => n >= 0),
      rationale: fixText(String(q.rationale || "").trim()),
      topic: fixText(String(q.topic || "").trim()).slice(0, 40),
    };
  }).filter(Boolean).slice(0, count);
  if (!qs.length) throw Object.assign(new Error("ما قدرتش أطلّع امتحان سليم المرة دي. جرّب تاني."), { detail: "exam: no valid questions" });
  return { title: fixText(String(data.title || "امتحان")).slice(0, 80), intro: fixText(String(data.intro || "")).slice(0, 240), questions: qs };
}

function parseJson(raw) {
  let t = String(raw || "").replace(/^\s*```[a-z]*\s*$/gim, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("bad json");
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); }
}

export async function makeExam({ apiKey, request, questions, topics, focusId, focusTopicId, attach = [], extra = "", signal, onStatus }) {
  const count = examCount(request);
  const lists = getModelLists(apiKey);
  const models = [...lists.fast, ...lists.pro];
  const mat = materialFor({ questions, topics, query: request, focusId, focusTopicId });
  const files = attach.length ? [{ text: "The student attached these files: build the exam from them." }, ...sourceParts({ kind: "bundle", items: attach }, null)] : [];
  const user = `STUDENT REQUEST: ${request}\nNumber of items: ${count}\n\n${extra ? `WHAT THE STUDENT IS LOOKING AT RIGHT NOW (use it when the request says "this question / this topic"):\n${extra}\n\n` : ""}${mat.text ? `STUDENT MATERIAL (his saved questions and lessons — use it ${mat.matched ? "as the source" : "only if the request is about his own questions; otherwise ignore it"}):\n${mat.text}\n\n` : "STUDENT MATERIAL: none saved yet — use general NCLEX knowledge.\n\n"}Write the exam JSON now.`;
  onStatus && onStatus("writing");
  const res = await runTask({
    apiKey, models, task: "exam:make", system: SYSTEM, parts: [...files, { text: user }],
    spec: { levels: ["high", "medium"], budget: 4096 }, maxOut: 8000 + count * 1600,
    hedgeMs: 12000, firstMs: 120000, idleMs: 90000, signal, onText: () => {},
  });
  let data;
  try { data = parseJson(res.text); }
  catch (e) { throw Object.assign(new Error("الامتحان رجع بشكل مش مفهوم. جرّب تاني."), { detail: "exam: bad json" }); }
  const exam = clean(data, count);
  return { exam: { ...exam, answers: {}, cur: 0, done: false, at: Date.now() }, fromMaterial: !!mat.matched, titles: mat.titles };
}
